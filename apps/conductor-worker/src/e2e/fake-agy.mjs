// Stands in for `agy` in worker.e2e.test.ts. It replays the recorded fixtures in
// ../engines/__fixtures__/agy/ and never touches the network.
//
//   agy --version                     prints a version
//   agy models                        prints models.txt
//   agy -p … --model claude-sonnet-*  edits a file, prints the quota transcript, exits 3
//   agy -p … --model slow             writes SLOW.md, then its pid to $E2E_AGY_PID_FILE, then sleeps
//   agy -p … (any other model)        appends to README.md and prints success.jsonl
//
// $E2E_AGY_LOG, when set, receives one JSON line per run with the model and the prompt.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = fileURLToPath(new URL('../engines/__fixtures__/agy/', import.meta.url));
/** The revoke kills the slow run within seconds; this only bounds a test that failed before it. */
const SLOW_MAX_MS = 60_000;
const QUOTA_EXIT_CODE = 3;

function fixture(name) {
  return readFileSync(path.join(FIXTURES, name), 'utf8');
}

function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function main(args) {
  if (args[0] === '--version') {
    process.stdout.write('agy 0.0.0-e2e\n');
    return;
  }
  if (args[0] === 'models') {
    process.stdout.write(fixture('models.txt'));
    return;
  }

  const model = flag(args, '--model') ?? '';
  const cwd = process.cwd();
  const log = process.env.E2E_AGY_LOG;
  if (log) appendFileSync(log, `${JSON.stringify({ model, prompt: flag(args, '-p') ?? '' })}\n`);

  if (model === 'slow') {
    // the work in progress exists before the pid does, so the revoke always has something to commit
    writeFileSync(path.join(cwd, 'SLOW.md'), 'partial work from the slow model\n');
    const pidFile = process.env.E2E_AGY_PID_FILE;
    if (pidFile) writeFileSync(pidFile, String(process.pid));
    process.stdout.write(`${fixture('success.jsonl').split('\n')[0]}\n`);
    setTimeout(() => {
      process.exitCode = 1;
    }, SLOW_MAX_MS);
    return;
  }

  if (model.startsWith('claude-sonnet-')) {
    appendFileSync(path.join(cwd, 'QUOTA.md'), 'partial work before the quota ran out\n');
    process.stdout.write(fixture('quota.stream.jsonl'));
    process.stderr.write(fixture('quota.stderr.txt'));
    process.exitCode = QUOTA_EXIT_CODE;
    return;
  }

  appendFileSync(path.join(cwd, 'README.md'), `\nedited by the fake agy (${model || 'default model'})\n`);
  process.stdout.write(fixture('success.jsonl'));
}

main(process.argv.slice(2));
