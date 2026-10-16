import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONDUCTOR_PROTOCOL_VERSION } from '@cortex/shared-types';
import { WORKER_VERSION } from './version.js';

export type CliArgs = { command: 'version' } | { command: 'help' };

// Stub: Task 12 replaces this with the full command set.
export function parseCli(argv: string[]): CliArgs | { error: string } {
  const first = argv[0];
  if (first === undefined || first === 'help' || first === '--help' || first === '-h') {
    return { command: 'help' };
  }
  if (first === 'version' || first === '--version' || first === '-v') {
    return { command: 'version' };
  }
  return { error: `unknown command: ${first}` };
}

function helpText(): string {
  return [
    `cortex-worker ${WORKER_VERSION} (protocol ${CONDUCTOR_PROTOCOL_VERSION})`,
    '',
    'Usage: cortex-worker <command>',
    '  version   print the worker version',
    '  help      show this help',
  ].join('\n');
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** True when this module is the process entry script (follows symlinks; win32 paths compare case-insensitively). */
export function isEntrypoint(
  metaUrl: string,
  argv1: string | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!argv1) return false;
  try {
    const self = canonical(fileURLToPath(metaUrl));
    const entry = canonical(argv1);
    return platform === 'win32' ? self.toLowerCase() === entry.toLowerCase() : self === entry;
  } catch {
    return false;
  }
}

export async function main(argv: string[]): Promise<number> {
  const args = parseCli(argv);
  if ('error' in args) {
    console.error(args.error);
    console.error(helpText());
    return 2;
  }
  console.log(args.command === 'version' ? WORKER_VERSION : helpText());
  return 0;
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
