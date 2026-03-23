/**
 * Docs Knowledge Builder
 *
 * Scans a cloned repository for documentation files (*.md, *.mdx, *.txt, *.rst),
 * chunks them, embeds using shared-mem9 Embedder, and stores as knowledge documents
 * in SQLite + Qdrant.
 *
 * On re-index, existing auto-docs knowledge for the project is deleted and re-created
 * to ensure freshness.
 */

import { readdirSync, readFileSync, statSync } from 'fs'
import { join, extname, relative, basename } from 'path'
import { randomUUID } from 'crypto'
import { Embedder, VectorStore } from '@cortex/shared-mem9'
import type { EmbedderConfig, VectorStoreConfig } from '@cortex/shared-mem9'
import { db } from '../db/client.js'
import { createLogger } from '@cortex/shared-utils'

const logger = createLogger('docs-knowledge')

const QDRANT_URL = process.env.QDRANT_URL ?? 'http://qdrant:6333'
const COLLECTION = 'knowledge'
const CHUNK_SIZE = 1500
const CHUNK_OVERLAP = 300

// ── File scanning config ──

const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.rst'])
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '__pycache__',
  '.turbo', 'coverage', '.cache', 'vendor', '.pnpm-store',
  'bin', 'obj', '.vs', '.idea',
])
const SKIP_FILES = new Set([
  'changelog', 'changelog.md', 'changes.md',
  'license', 'license.md', 'license.txt',
  'contributing.md', 'code_of_conduct.md',
  'security.md', 'pull_request_template.md',
  'issue_template.md',
])
const MIN_FILE_SIZE = 100    // Skip tiny files
const MAX_FILE_SIZE = 512 * 1024 // 512KB

// ── Helpers ──

function chunkText(text: string): string[] {
  if (text.length <= CHUNK_SIZE) return [text]

  const chunks: string[] = []
  let start = 0

  while (start < text.length) {
    let end = start + CHUNK_SIZE
    if (end < text.length) {
      const newlinePos = text.lastIndexOf('\n', end)
      if (newlinePos > start + CHUNK_SIZE / 2) {
        end = newlinePos + 1
      }
    }
    chunks.push(text.slice(start, end))
    start = end - CHUNK_OVERLAP
    if (start >= text.length) break
  }

  return chunks
}

/**
 * Extract a title from a markdown file.
 * Tries: first # heading → filename without extension.
 */
function extractTitle(content: string, filePath: string): string {
  const headingMatch = content.match(/^#\s+(.+)$/m)
  if (headingMatch?.[1]) {
    return headingMatch[1].trim()
  }

  // Fallback to filename
  const name = basename(filePath, extname(filePath))
  return name.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

/**
 * Collect documentation files from a directory tree.
 */
function collectDocFiles(dir: string): Array<{ path: string; relativePath: string }> {
  const files: Array<{ path: string; relativePath: string }> = []

  function walk(currentDir: string) {
    let entries: string[]
    try {
      entries = readdirSync(currentDir)
    } catch {
      return
    }

    for (const entry of entries) {
      const lowerEntry = entry.toLowerCase()
      if (SKIP_DIRS.has(lowerEntry) || entry.startsWith('.')) continue

      const fullPath = join(currentDir, entry)
      let stat
      try {
        stat = statSync(fullPath)
      } catch {
        continue
      }

      if (stat.isDirectory()) {
        walk(fullPath)
      } else if (stat.isFile()) {
        // Check extension
        const ext = extname(entry).toLowerCase()
        if (!DOC_EXTENSIONS.has(ext)) continue

        // Skip excluded files
        if (SKIP_FILES.has(lowerEntry)) continue

        // Size guards
        if (stat.size < MIN_FILE_SIZE || stat.size > MAX_FILE_SIZE) continue

        files.push({
          path: fullPath,
          relativePath: relative(dir, fullPath),
        })
      }
    }
  }

  walk(dir)
  return files
}

/**
 * Resolve Gemini API key from env or provider_accounts table.
 */
function resolveGeminiApiKey(): string {
  const envKey = process.env['GEMINI_API_KEY']
  if (envKey) return envKey
  try {
    const row = db.prepare(
      "SELECT api_key FROM provider_accounts WHERE type = 'gemini' AND status = 'enabled' AND api_key IS NOT NULL LIMIT 1"
    ).get() as { api_key: string } | undefined
    if (row?.api_key) return row.api_key
  } catch { /* DB might not be ready */ }
  return ''
}

// ── Main Pipeline ──

export async function buildKnowledgeFromDocs(
  projectId: string,
  jobId: string,
  repoDir: string,
): Promise<{ docsFound: number; docsProcessed: number; chunksCreated: number; errors: string[] }> {
  const errors: string[] = []

  logger.info(`[${jobId}] Starting docs knowledge build for project ${projectId}`)

  // 1. Collect doc files
  const docFiles = collectDocFiles(repoDir)
  logger.info(`[${jobId}] Found ${docFiles.length} documentation files`)

  if (docFiles.length === 0) {
    return { docsFound: 0, docsProcessed: 0, chunksCreated: 0, errors: [] }
  }

  // 2. Resolve project slug for consistent knowledge grouping
  let normalizedProjectId = projectId
  if (projectId.startsWith('proj-')) {
    const proj = db.prepare('SELECT slug FROM projects WHERE id = ?').get(projectId) as { slug: string } | undefined
    if (proj?.slug) normalizedProjectId = proj.slug
  }
  normalizedProjectId = normalizedProjectId.toLowerCase()

  // 3. Delete existing auto-docs knowledge for this project (upsert strategy)
  const existingDocs = db.prepare(
    "SELECT id FROM knowledge_documents WHERE project_id = ? AND source = 'auto-docs'"
  ).all(normalizedProjectId) as Array<{ id: string }>

  if (existingDocs.length > 0) {
    logger.info(`[${jobId}] Removing ${existingDocs.length} existing auto-docs knowledge items`)

    const vectorStore = new VectorStore({
      url: QDRANT_URL,
      collection: COLLECTION,
    } satisfies VectorStoreConfig)

    for (const doc of existingDocs) {
      // Delete Qdrant chunks
      const chunks = db.prepare('SELECT id FROM knowledge_chunks WHERE document_id = ?').all(doc.id) as Array<{ id: string }>
      for (const chunk of chunks) {
        try {
          await vectorStore.delete(chunk.id)
        } catch { /* best effort */ }
      }
      // SQLite CASCADE handles chunks
      db.prepare('DELETE FROM knowledge_documents WHERE id = ?').run(doc.id)
    }
  }

  // 4. Setup embedder
  const embedConfig: EmbedderConfig = {
    provider: 'gemini' as const,
    apiKey: resolveGeminiApiKey(),
    model: process.env['MEM9_EMBEDDING_MODEL'] || 'gemini-embedding-exp-03-07',
  }
  const embedder = new Embedder(embedConfig)

  const vectorStoreConfig: VectorStoreConfig = {
    url: QDRANT_URL,
    collection: COLLECTION,
  }
  const vectorStore = new VectorStore(vectorStoreConfig)

  // Get vector dimensions
  let vectorSize: number
  try {
    const testVec = await embedder.embed('test')
    vectorSize = testVec.length
  } catch (err) {
    const msg = `Embedding test failed: ${String(err).slice(0, 200)}`
    logger.error(`[${jobId}] ${msg}`)
    return { docsFound: docFiles.length, docsProcessed: 0, chunksCreated: 0, errors: [msg] }
  }

  await vectorStore.ensureCollection(vectorSize)

  // 5. Process each doc file
  let docsProcessed = 0
  let totalChunks = 0

  for (const file of docFiles) {
    try {
      const content = readFileSync(file.path, 'utf-8')
      const title = extractTitle(content, file.relativePath)
      const tagList = ['auto-docs', `project:${normalizedProjectId}`]

      // Create knowledge document
      const docId = `kdoc-${randomUUID().slice(0, 8)}`
      const chunks = chunkText(content)
      const contentPreview = content.slice(0, 500)

      db.prepare(
        `INSERT INTO knowledge_documents (id, title, source, source_agent_id, project_id, tags, content_preview, chunk_count)
         VALUES (?, ?, 'auto-docs', 'system', ?, ?, ?, ?)`
      ).run(docId, `[${file.relativePath}] ${title}`, normalizedProjectId, JSON.stringify(tagList), contentPreview, chunks.length)

      // Embed and store each chunk
      for (let i = 0; i < chunks.length; i++) {
        const chunkId = randomUUID()
        const chunkContent = chunks[i]!

        try {
          const vector = await embedder.embed(chunkContent)
          await vectorStore.upsert(chunkId, vector, {
            document_id: docId,
            chunk_index: i,
            tags: tagList,
            project_id: normalizedProjectId,
            content: chunkContent.slice(0, 2000),
            title: `[${file.relativePath}] ${title}`,
            source: 'auto-docs',
          })

          db.prepare(
            `INSERT INTO knowledge_chunks (id, document_id, chunk_index, content, char_count)
             VALUES (?, ?, ?, ?, ?)`
          ).run(chunkId, docId, i, chunkContent, chunkContent.length)

          totalChunks++
        } catch (err) {
          errors.push(`${file.relativePath}#${i}: ${String(err).slice(0, 100)}`)
        }
      }

      docsProcessed++
      logger.info(`[${jobId}] Processed: ${file.relativePath} → ${chunks.length} chunks`)
    } catch (err) {
      errors.push(`${file.relativePath}: ${String(err).slice(0, 100)}`)
    }

    // Small delay between files to avoid rate limiting
    await new Promise<void>((r) => setTimeout(r, 200))
  }

  logger.info(`[${jobId}] Docs knowledge complete: ${docsProcessed}/${docFiles.length} docs, ${totalChunks} chunks`)

  if (errors.length > 10) {
    const total = errors.length
    errors.length = 10
    errors.push(`... and ${total - 10} more errors`)
  }

  return { docsFound: docFiles.length, docsProcessed, chunksCreated: totalChunks, errors }
}
