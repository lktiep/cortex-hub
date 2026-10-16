import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface WorkerAssetOptions {
  /** Path of cortex-worker.mjs; the version file sits next to it with .version. */
  bundlePath: string
}

export function defaultBundlePath(env: NodeJS.ProcessEnv, moduleUrl: string): string {
  return (
    env.CONDUCTOR_WORKER_PATH?.trim() ||
    resolve(dirname(fileURLToPath(moduleUrl)), '../../conductor-worker/dist/cortex-worker.mjs')
  )
}

function versionPath(bundlePath: string): string {
  return bundlePath.endsWith('.mjs') ? bundlePath.replace(/\.mjs$/, '.version') : `${bundlePath}.version`
}

const TEXT = 'text/plain; charset=utf-8'

function reply(status: number, body: string, contentType: string, head: boolean): Response {
  return new Response(head ? null : body, {
    status,
    headers: { 'Content-Type': contentType, 'Cache-Control': 'no-cache' },
  })
}

/** Serves the worker bundle and its version (public, no auth). Returns null for other requests. */
export async function serveWorkerAsset(req: Request, opts: WorkerAssetOptions): Promise<Response | null> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return null
  const { pathname } = new URL(req.url)
  const isBundle = pathname === '/conductor/worker.mjs'
  if (!isBundle && pathname !== '/conductor/worker.version') return null

  const head = req.method === 'HEAD'
  const file = isBundle ? opts.bundlePath : versionPath(opts.bundlePath)
  try {
    const text = await readFile(file, 'utf8')
    return isBundle
      ? reply(200, text, 'text/javascript; charset=utf-8', head)
      : reply(200, text.trim(), TEXT, head)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return reply(404, 'worker bundle not built', TEXT, head)
    }
    console.error('[worker-asset] read failed:', err)
    return reply(500, 'worker bundle unreadable', TEXT, head)
  }
}
