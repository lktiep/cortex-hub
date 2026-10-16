// Stands in for `gh` in the end-to-end tests; it never touches the network.
//
//   gh auth status   exits 0
//   gh pr create …   reads the body from stdin, prints the pull request URL
//   anything else    exits 1
//
// $E2E_GH_LOG, when set, receives one JSON line per call with its arguments.
import { appendFileSync } from 'node:fs';

const PR_URL = 'https://github.com/acme/demo/pull/1';

const args = process.argv.slice(2);
const log = process.env.E2E_GH_LOG;
if (log) appendFileSync(log, `${JSON.stringify({ args })}\n`);

if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write('github.com\n  Logged in to github.com account e2e (fake)\n');
} else if (args[0] === 'pr' && args[1] === 'create') {
  // drained first, so the worker never writes the body into a closed pipe
  process.stdin.resume();
  process.stdin.on('end', () => {
    process.stdout.write(`${PR_URL}\n`);
  });
} else {
  process.stderr.write(`fake gh: unsupported command: ${args.join(' ')}\n`);
  process.exitCode = 1;
}
