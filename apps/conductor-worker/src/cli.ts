import { pathToFileURL } from 'node:url';
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main(process.argv.slice(2));
}
