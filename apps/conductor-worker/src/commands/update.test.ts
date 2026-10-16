import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { updateBundle } from './update.js';

const SHEBANG = '#!/usr/bin/env node';
const OLD = `${SHEBANG}\nconsole.log('old');\n`;
const NEW = `${SHEBANG}\nimport x from 'y';\nconsole.log('new');\n`;

interface Route {
  status: number;
  body: string;
  /** Declare this Content-Length, send the body, then cut the connection. */
  declaredLength?: number;
}

interface Hub {
  base: string;
  routes: Record<string, Route>;
  requests: Array<{ url: string; headers: IncomingHttpHeaders }>;
}

let server: Server;
let hub: Hub;
let dir: string;
let target: string;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cw-update-'));
  target = path.join(dir, 'cortex-worker.mjs');
  writeFileSync(target, OLD, { mode: 0o755 });
  chmodSync(target, 0o755);
  hub = {
    base: '',
    routes: {
      '/conductor/worker.version': { status: 200, body: '1.2.3\n' },
      '/conductor/worker.mjs': { status: 200, body: NEW },
    },
    requests: [],
  };
  server = createServer((req, res) => {
    hub.requests.push({ url: req.url ?? '', headers: req.headers });
    const route = hub.routes[req.url ?? ''] ?? { status: 404, body: 'not found' };
    if (route.declaredLength !== undefined) {
      res.writeHead(route.status, { 'content-type': 'text/plain', 'content-length': route.declaredLength });
      res.write(route.body, () => res.socket?.destroy());
      return;
    }
    res.writeHead(route.status, { 'content-type': 'text/plain' });
    res.end(route.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  hub.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

const leftovers = (): string[] => readdirSync(dir).filter((f) => f !== 'cortex-worker.mjs');

describe('updateBundle', () => {
  it('no-op when versions match', async () => {
    expect(await updateBundle(hub.base, target, '1.2.3')).toEqual({ updated: false, version: '1.2.3' });
    expect(readFileSync(target, 'utf8')).toBe(OLD);
    expect(hub.requests.map((r) => r.url)).toEqual(['/conductor/worker.version']);
  });

  it('compares the versions trimmed', async () => {
    hub.routes['/conductor/worker.version'] = { status: 200, body: '  1.2.3 \r\n' };
    expect(await updateBundle(`${hub.base}/`, target, '1.2.3\n')).toEqual({ updated: false, version: '1.2.3' });
  });

  it('replaces the bundle atomically when newer', async () => {
    expect(await updateBundle(hub.base, target, '1.2.2')).toEqual({ updated: true, version: '1.2.3' });
    expect(readFileSync(target, 'utf8')).toBe(NEW);
    expect(leftovers()).toEqual([]);
    expect(hub.requests.map((r) => r.url)).toEqual(['/conductor/worker.version', '/conductor/worker.mjs']);
    // the endpoints are public: no key goes out
    for (const r of hub.requests) expect(r.headers.authorization).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('keeps the mode of the file it replaces', async () => {
    chmodSync(target, 0o700);
    await updateBundle(hub.base, target, '1.0.0');
    expect(statSync(target).mode & 0o777).toBe(0o700);
  });

  it('refuses a body that is not the bundle', async () => {
    hub.routes['/conductor/worker.mjs'] = { status: 200, body: '<!doctype html><title>Error</title>' };
    await expect(updateBundle(hub.base, target, '1.0.0')).rejects.toThrow(/not the worker bundle/);
    expect(readFileSync(target, 'utf8')).toBe(OLD);
    expect(leftovers()).toEqual([]);
  });

  it('refuses a body whose first line only starts like the shebang', async () => {
    hub.routes['/conductor/worker.mjs'] = { status: 200, body: `${SHEBANG}js\nx\n` };
    await expect(updateBundle(hub.base, target, '1.0.0')).rejects.toThrow(/not the worker bundle/);
    expect(readFileSync(target, 'utf8')).toBe(OLD);
  });

  it('throws on a non-200 answer from either endpoint', async () => {
    hub.routes['/conductor/worker.version'] = { status: 404, body: 'nope' };
    await expect(updateBundle(hub.base, target, '1.0.0')).rejects.toThrow(/worker\.version.*HTTP 404/);

    hub.routes['/conductor/worker.version'] = { status: 200, body: '1.2.3' };
    hub.routes['/conductor/worker.mjs'] = { status: 500, body: `${SHEBANG}\n` };
    await expect(updateBundle(hub.base, target, '1.0.0')).rejects.toThrow(/worker\.mjs.*HTTP 500/);
    expect(readFileSync(target, 'utf8')).toBe(OLD);
    expect(leftovers()).toEqual([]);
  });

  it('throws when the server cuts the bundle short of its Content-Length', async () => {
    hub.routes['/conductor/worker.mjs'] = { status: 200, body: NEW, declaredLength: Buffer.byteLength(NEW) + 100 };
    await expect(updateBundle(hub.base, target, '1.0.0')).rejects.toThrow();
    expect(readFileSync(target, 'utf8')).toBe(OLD);
    expect(leftovers()).toEqual([]);
  });

  /** A fetch that answers the version, and the bundle with `bundle`. */
  const fetchWith =
    (bundle: () => Response): typeof fetch =>
    (input) => {
      const url = input instanceof Request ? input.url : String(input);
      return Promise.resolve(url.endsWith('/worker.version') ? new Response('1.2.3\n') : bundle());
    };

  it('throws when the bundle is shorter than its Content-Length, leaving no tmp file', async () => {
    const declared = Buffer.byteLength(NEW) + 100;
    const short = fetchWith(() => new Response(NEW, { headers: { 'content-length': String(declared) } }));
    await expect(updateBundle(hub.base, target, '1.0.0', short)).rejects.toThrow(
      new RegExp(`worker\\.mjs: got ${Buffer.byteLength(NEW)} of ${declared} bytes`),
    );
    expect(readFileSync(target, 'utf8')).toBe(OLD);
    expect(leftovers()).toEqual([]);
  });

  it('accepts a bundle whose length matches its Content-Length, and skips the check for an encoded body', async () => {
    const exact = fetchWith(() => new Response(NEW, { headers: { 'content-length': String(Buffer.byteLength(NEW)) } }));
    expect(await updateBundle(hub.base, target, '1.0.0', exact)).toEqual({ updated: true, version: '1.2.3' });
    writeFileSync(target, OLD);
    // fetch hands over the decoded body, while Content-Length counts the compressed bytes
    const gzipped = fetchWith(
      () => new Response(NEW, { headers: { 'content-length': '17', 'content-encoding': 'gzip' } }),
    );
    expect(await updateBundle(hub.base, target, '1.0.0', gzipped)).toEqual({ updated: true, version: '1.2.3' });
    expect(readFileSync(target, 'utf8')).toBe(NEW);
  });

  it('throws on an empty version', async () => {
    hub.routes['/conductor/worker.version'] = { status: 200, body: ' \n' };
    await expect(updateBundle(hub.base, target, '1.0.0')).rejects.toThrow(/empty/);
  });

  it('refuses to overwrite a file that is not a worker bundle', async () => {
    const source = path.join(dir, 'cli.ts');
    writeFileSync(source, "import x from 'y';\n");
    await expect(updateBundle(hub.base, source, '0.0.0-dev')).rejects.toThrow(/not a cortex-worker bundle/);
    expect(readFileSync(source, 'utf8')).toBe("import x from 'y';\n");
    expect(existsSync(`${source}.tmp`)).toBe(false);
  });
});
