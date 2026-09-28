/**
 * Where memories live in Qdrant. The mem9 proxy and the migration script that
 * gives the collection its lexical arm have to agree on both, so they are
 * spelled once.
 */
export const MEMORY_COLLECTION = 'cortex_memories'

export function memoryQdrantUrl(): string {
  return process.env['QDRANT_URL'] || 'http://qdrant:6333'
}
