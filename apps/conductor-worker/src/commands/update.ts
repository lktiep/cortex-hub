// `cortex-worker update`: replace the installed bundle with the hub's, atomically.
// Both endpoints are public, so no key is sent.
import { chmodSync, closeSync, openSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';

const SHEBANG = '#!/usr/bin/env node';
const VERSION_TIMEOUT_MS = 30_000;
const BUNDLE_TIMEOUT_MS = 120_000;

/** The first line of a file, without its line ending; '' when unreadable. */
function firstLine(file: string): string {
  let fd: number | null = null;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(256);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, n).toString('utf8');
    const nl = text.indexOf('\n');
    return (nl < 0 ? text : text.slice(0, nl)).replace(/\r$/, '');
  } catch {
    return '';
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * The body length the response declares, or null when it declares none or counts encoded
 * bytes (fetch hands over the decoded body, so a gzip Content-Length cannot be compared).
 */
function declaredLength(res: Response): number | null {
  const encoding = res.headers.get('content-encoding')?.trim().toLowerCase() ?? '';
  if (encoding !== '' && encoding !== 'identity') return null;
  const raw = res.headers.get('content-length')?.trim() ?? '';
  return /^\d+$/.test(raw) ? Number(raw) : null;
}

async function get(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<Response> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (res.status !== 200) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return res;
}

/**
 * Fetches `<hub>/conductor/worker.version`; when it differs from `current`, downloads
 * `worker.mjs` to `<target>.tmp`, checks it is as long as its Content-Length says and
 * starts with the node shebang, gives it the target's mode and renames it over `target`.
 * A failure leaves `target` untouched and no tmp file.
 */
export async function updateBundle(
  hubBase: string,
  target: string,
  current: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ updated: boolean; version: string }> {
  const base = hubBase.trim().replace(/\/+$/, '');
  const versionUrl = `${base}/conductor/worker.version`;
  const version = (await (await get(versionUrl, fetchImpl, VERSION_TIMEOUT_MS)).text()).trim();
  if (version === '') throw new Error(`GET ${versionUrl}: empty version`);
  if (version === current.trim()) return { updated: false, version };

  // never overwrite a source file or anything else that is not the installed bundle
  let mode: number;
  try {
    const st = statSync(target);
    if (!st.isFile()) throw new Error('not a file');
    mode = st.mode & 0o777;
  } catch {
    throw new Error(`${target} is not a cortex-worker bundle; update replaces only an installed cortex-worker.mjs`);
  }
  if (firstLine(target) !== SHEBANG) {
    throw new Error(`${target} is not a cortex-worker bundle; update replaces only an installed cortex-worker.mjs`);
  }

  const bundleUrl = `${base}/conductor/worker.mjs`;
  const res = await get(bundleUrl, fetchImpl, BUNDLE_TIMEOUT_MS);
  const body = Buffer.from(await res.arrayBuffer());
  const tmp = `${target}.tmp`;
  try {
    const declared = declaredLength(res);
    if (declared !== null && body.length !== declared) {
      throw new Error(`${bundleUrl}: got ${body.length} of ${declared} bytes`);
    }
    writeFileSync(tmp, body, { mode: mode || 0o755 });
    const head = firstLine(tmp);
    if (head !== SHEBANG) {
      throw new Error(`${bundleUrl} is not the worker bundle (it starts ${JSON.stringify(head.slice(0, 40))})`);
    }
    chmodSync(tmp, mode || 0o755);
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return { updated: true, version };
}
