import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { workerPaths } from '../paths.js';
import type { WorkerPaths } from '../paths.js';
import { printTranscript } from './tail.js';

const homes: string[] = [];
function freshPaths(): WorkerPaths {
  const home = mkdtempSync(path.join(tmpdir(), 'cw-tail-'));
  homes.push(home);
  return workerPaths('w1', home);
}
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

function collect(): { out: PassThrough; text: () => string } {
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on('data', (c: Buffer) => chunks.push(c));
  return { out, text: () => Buffer.concat(chunks).toString('utf8') };
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function transcript(paths: WorkerPaths, taskId: string, text: string, secondsAgo = 0): string {
  mkdirSync(paths.transcripts, { recursive: true });
  const file = path.join(paths.transcripts, `${taskId}.log`);
  writeFileSync(file, text);
  const at = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(file, at, at);
  return file;
}

const numbered = (from: number, to: number): string =>
  Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}\n`).join('');

describe('printTranscript', () => {
  it('says so when no task has a transcript yet', async () => {
    const paths = freshPaths();
    const c = collect();
    await printTranscript(paths, { follow: false, out: c.out });
    expect(c.text()).toBe(`no task transcript yet in ${paths.transcripts}\n`);
  });

  it('prints the last lines of the newest task, named', async () => {
    const paths = freshPaths();
    transcript(paths, 'older', 'old\n', 60);
    const file = transcript(paths, 'newer', numbered(1, 50));
    const c = collect();
    await printTranscript(paths, { follow: false, out: c.out });
    expect(c.text()).toBe(`==> ${file} <==\n${numbered(11, 50)}`);

    const few = collect();
    await printTranscript(paths, { follow: false, lines: 2, out: few.out });
    expect(few.text()).toBe(`==> ${file} <==\nline 49\nline 50\n`);
  });

  it('follows what is appended, then the next task when it starts', async () => {
    const paths = freshPaths();
    const first = transcript(paths, 't1', 'start\n', 60);
    const ac = new AbortController();
    const c = collect();
    const done = printTranscript(paths, { follow: true, out: c.out, signal: ac.signal, pollMs: 20 });
    await until(() => c.text().endsWith('start\n'), 'the tail');
    appendFileSync(first, 'more\n');
    await until(() => c.text().endsWith('start\nmore\n'), 'the appended line');

    const second = transcript(paths, 't2', 'next task\n');
    await until(() => c.text().endsWith('next task\n'), 'the next task');
    ac.abort();
    await done;
    expect(c.text()).toBe(`==> ${first} <==\nstart\nmore\n\n==> ${second} <==\nnext task\n`);
  });

  it('with follow, waits for the first transcript', async () => {
    const paths = freshPaths();
    const ac = new AbortController();
    const c = collect();
    const done = printTranscript(paths, { follow: true, out: c.out, signal: ac.signal, pollMs: 20 });
    await until(() => c.text().startsWith('no task transcript yet'), 'the note');
    const file = transcript(paths, 't1', 'hello\n');
    await until(() => c.text().endsWith('hello\n'), 'the new transcript');
    ac.abort();
    await done;
    expect(c.text()).toBe(`no task transcript yet in ${paths.transcripts}\n\n==> ${file} <==\nhello\n`);
  });

  it('returns at once for an aborted signal', async () => {
    const paths = freshPaths();
    transcript(paths, 't1', 'x\n');
    const ac = new AbortController();
    ac.abort();
    const c = collect();
    await printTranscript(paths, { follow: true, out: c.out, signal: ac.signal });
    expect(c.text()).toBe('');
  });
});
