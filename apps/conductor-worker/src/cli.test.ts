import { describe, expect, it } from 'vitest';
import { parseCli } from './cli.js';
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
