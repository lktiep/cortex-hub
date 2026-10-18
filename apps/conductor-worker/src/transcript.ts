import fs from 'node:fs';
import path from 'node:path';

/** How many task transcripts a worker keeps; older ones are removed when a task starts. */
export const TRANSCRIPTS_KEPT = 10;
/** A transcript stops growing here, with a note saying so. */
export const TRANSCRIPT_MAX_BYTES = 10 * 1024 * 1024;

const TASK_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** A task's full engine output on this machine. Writing never throws: a transcript is a convenience. */
export interface Transcript {
  /** The file, or null when it could not be opened. */
  readonly file: string | null;
  write(text: string): void;
  close(): void;
}

export interface TranscriptOptions {
  kept?: number;
  maxBytes?: number;
  platform?: NodeJS.Platform;
}

function logFiles(dir: string): Array<{ file: string; mtimeMs: number }> {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const found: Array<{ file: string; mtimeMs: number }> = [];
  for (const name of names) {
    if (!name.endsWith('.log')) continue;
    const file = path.join(dir, name);
    try {
      const st = fs.statSync(file);
      if (st.isFile()) found.push({ file, mtimeMs: st.mtimeMs });
    } catch {
      // removed meanwhile
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** The most recently written transcript in `dir`, or null. */
export function newestTranscript(dir: string): string | null {
  return logFiles(dir)[0]?.file ?? null;
}

/** Removes all but the newest `kept` transcripts, never `current`. */
function prune(dir: string, kept: number, current: string): void {
  const others = logFiles(dir).filter((f) => f.file !== current);
  for (const { file } of others.slice(Math.max(0, kept - 1))) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // best effort
    }
  }
}

/**
 * Opens `<dir>/<taskId>.log` for appending, readable by its owner only, writes `header`, and
 * removes the oldest transcripts beyond `kept`. A retry of a task appends to its file.
 */
export function openTranscript(
  dir: string,
  taskId: string,
  header: string,
  opts: TranscriptOptions = {},
): Transcript {
  const kept = opts.kept ?? TRANSCRIPTS_KEPT;
  const maxBytes = opts.maxBytes ?? TRANSCRIPT_MAX_BYTES;
  const posix = (opts.platform ?? process.platform) !== 'win32';
  let file: string | null = null;
  let fd: number | null = null;
  let size = 0;
  let full = false;
  try {
    if (!TASK_ID.test(taskId)) throw new Error(`unsafe task id: ${taskId}`);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (posix) fs.chmodSync(dir, 0o700);
    const target = path.join(dir, `${taskId}.log`);
    fd = fs.openSync(target, 'a', 0o600);
    if (posix) fs.fchmodSync(fd, 0o600);
    size = fs.fstatSync(fd).size;
    file = target;
    prune(dir, kept, target);
  } catch {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
    }
    fd = null;
    file = null;
  }

  const append = (text: string): void => {
    if (fd === null || full) return;
    const line = text.endsWith('\n') ? text : `${text}\n`;
    const bytes = Buffer.byteLength(line);
    if (size + bytes > maxBytes) {
      full = true;
      fs.writeSync(fd, `(the transcript reached ${Math.round(maxBytes / 1024 / 1024)} MB; the rest is not kept)\n`);
      return;
    }
    fs.writeSync(fd, line);
    size += bytes;
  };
  const write = (text: string): void => {
    try {
      append(text);
    } catch {
      // a full disk must not break the task
    }
  };
  write(header);

  return {
    file,
    write,
    close() {
      if (fd === null) return;
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
      fd = null;
    },
  };
}
