import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultBundlePath, serveWorkerAsset } from './worker-asset.js'

let dir: string
let bundlePath: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'worker-asset-'))
  bundlePath = join(dir, 'cortex-worker.mjs')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const get = (path: string, method = 'GET') => new Request(`http://hub${path}`, { method })

describe('serveWorkerAsset', () => {
  it('serves the bundle with text/javascript', async () => {
    await writeFile(bundlePath, 'console.log(1)\n')
    const res = await serveWorkerAsset(get('/conductor/worker.mjs'), { bundlePath })
    expect(res?.status).toBe(200)
    expect(res?.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(res?.headers.get('cache-control')).toBe('no-cache')
    expect(await res?.text()).toBe('console.log(1)\n')
  })

  it('serves the version as text/plain, trimmed', async () => {
    await writeFile(join(dir, 'cortex-worker.version'), '0.9.10\n')
    const res = await serveWorkerAsset(get('/conductor/worker.version?x=1'), { bundlePath })
    expect(res?.status).toBe(200)
    expect(res?.headers.get('content-type')).toMatch(/^text\/plain/)
    expect(res?.headers.get('cache-control')).toBe('no-cache')
    expect(await res?.text()).toBe('0.9.10')
  })

  it('answers HEAD with the same headers and no body', async () => {
    await writeFile(bundlePath, 'abc')
    const res = await serveWorkerAsset(get('/conductor/worker.mjs', 'HEAD'), { bundlePath })
    expect(res?.status).toBe(200)
    expect(res?.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(await res?.text()).toBe('')
  })

  it('returns 404 when the bundle is missing', async () => {
    const res = await serveWorkerAsset(get('/conductor/worker.mjs'), { bundlePath })
    expect(res?.status).toBe(404)
    expect(res?.headers.get('content-type')).toMatch(/^text\/plain/)
    expect(await res?.text()).toBe('worker bundle not built')
  })

  it('returns 404 for the version when only the version file is missing', async () => {
    await writeFile(bundlePath, 'abc')
    const res = await serveWorkerAsset(get('/conductor/worker.version'), { bundlePath })
    expect(res?.status).toBe(404)
  })

  it('reads the file on every request', async () => {
    await writeFile(bundlePath, 'one')
    await serveWorkerAsset(get('/conductor/worker.mjs'), { bundlePath })
    await writeFile(bundlePath, 'two')
    const res = await serveWorkerAsset(get('/conductor/worker.mjs'), { bundlePath })
    expect(await res?.text()).toBe('two')
  })

  it('returns null for other paths and methods', async () => {
    expect(await serveWorkerAsset(get('/health'), { bundlePath })).toBeNull()
    expect(await serveWorkerAsset(get('/conductor/worker.mjs/x'), { bundlePath })).toBeNull()
    expect(await serveWorkerAsset(get('/conductor/worker.mjs', 'POST'), { bundlePath })).toBeNull()
  })
})

describe('defaultBundlePath', () => {
  it('honours CONDUCTOR_WORKER_PATH', () => {
    expect(defaultBundlePath({ CONDUCTOR_WORKER_PATH: '/x/w.mjs' }, 'file:///a/b/node.js')).toBe('/x/w.mjs')
  })

  it('falls back to the sibling conductor-worker dist', () => {
    expect(defaultBundlePath({}, 'file:///repo/apps/hub-mcp/dist/node.js')).toBe(
      '/repo/apps/conductor-worker/dist/cortex-worker.mjs',
    )
  })
})
