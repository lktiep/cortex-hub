// `cw tail`: what the engine of an agent's latest task printed, from the transcript on this
// machine. The hub only gets short lines; this is everything, credentials scrubbed.
import type { WorkerPaths } from '../paths.js';
import { newestTranscript } from '../transcript.js';
import { readRange, sleep, statOrNull, tailLines } from './daemon.js';

const DEFAULT_TAIL_LINES = 40;
const DEFAULT_FOLLOW_POLL_MS = 500;

export interface TailOptions {
  follow: boolean;
  lines?: number;
  out?: NodeJS.WritableStream;
  signal?: AbortSignal;
  pollMs?: number;
}

/**
 * Prints the last lines of the newest task transcript; with `follow`, keeps printing what is
 * appended, and moves on to the next task's transcript when it appears, until `signal` fires.
 */
export async function printTranscript(paths: WorkerPaths, opts: TailOptions): Promise<void> {
  const out = opts.out ?? process.stdout;
  const { signal } = opts;
  const pollMs = opts.pollMs ?? DEFAULT_FOLLOW_POLL_MS;
  const dir = paths.transcripts;
  if (signal?.aborted) return;

  let file = newestTranscript(dir);
  let offset = 0;
  if (file === null) {
    out.write(`no task transcript yet in ${dir}\n`);
    if (!opts.follow) return;
  } else {
    out.write(`==> ${file} <==\n`);
    const all = readRange(file, 0, statOrNull(file)?.size ?? 0);
    out.write(tailLines(all.toString('utf8'), opts.lines ?? DEFAULT_TAIL_LINES));
    offset = all.length;
    if (!opts.follow) return;
  }

  /** Prints what was appended to `file` since `offset`. */
  const catchUp = (): void => {
    if (file === null) return;
    const st = statOrNull(file);
    if (st === null) return;
    if (st.size < offset) offset = 0;
    if (st.size > offset) {
      const chunk = readRange(file, offset, st.size);
      out.write(chunk);
      offset += chunk.length;
    }
  };

  while (!signal?.aborted) {
    await sleep(pollMs, signal);
    if (signal?.aborted) break;
    const newest = newestTranscript(dir);
    if (newest !== null && newest !== file) {
      catchUp();
      file = newest;
      offset = 0;
      out.write(`\n==> ${file} <==\n`);
    }
    catchUp();
  }
}
