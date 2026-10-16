import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { isEntrypoint, main, parseCli } from './cli.js';
import { WORKER_VERSION } from './version.js';

describe('parseCli', () => {
  it('parses --version', () => {
    expect(parseCli(['--version'])).toEqual({ command: 'version' });
  });

  it('defaults to help', () => {
    expect(parseCli([])).toEqual({ command: 'help' });
  });

  it('rejects unknown commands', () => {
    expect(parseCli(['bogus'])).toEqual({ error: expect.stringMatching(/unknown command/) });
  });
});

describe('WORKER_VERSION', () => {
  it('is the dev placeholder under vitest', () => {
    expect(WORKER_VERSION).toBe('0.0.0-dev');
  });
});

describe('isEntrypoint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cw-entry-'));
  const file = join(dir, 'Entry.mjs');
  writeFileSync(file, '');
  const url = pathToFileURL(file).href;

  it('follows a symlink to the real file', () => {
    if (process.platform === 'win32') return;
    const link = join(dir, 'link.mjs');
    symlinkSync(file, link);
    expect(isEntrypoint(url, link)).toBe(true);
  });

  it('ignores path casing only on win32', () => {
    const swapped = join(dir, 'entry.mjs');
    expect(isEntrypoint(url, swapped, 'win32')).toBe(true);
    expect(isEntrypoint(url, swapped, 'linux')).toBe(false);
  });

  it('is false without argv1', () => {
    expect(isEntrypoint(url, undefined)).toBe(false);
    expect(isEntrypoint(url, '')).toBe(false);
  });
});

describe('main', () => {
  it('returns 2 for unknown commands and 0 for --version', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await main(['bogus'])).toBe(2);
    expect(await main(['--version'])).toBe(0);
    expect(log).toHaveBeenCalledWith('0.0.0-dev');
    err.mockRestore();
    log.mockRestore();
  });
});
