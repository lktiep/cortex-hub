import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';

export interface Logger {
  info(m: string): void;
  warn(m: string): void;
  error(m: string): void;
  addSecret(s: string): void;
}

export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  const sorted = secrets.filter((s) => s !== '').sort((a, b) => b.length - a.length);
  for (const s of sorted) out = out.split(s).join('***');
  return out.replace(/(apikey=)[^&\s"']*/gi, '$1***');
}

let stdoutGuarded = false;
function guardStdout(): void {
  if (stdoutGuarded) return;
  stdoutGuarded = true;
  process.stdout.on('error', () => {
    // a closed stdout (EPIPE) must not crash the daemon
  });
}

export function createLogger(opts: {
  file?: string;
  stdout?: boolean;
  maxBytes?: number;
  now?: () => Date;
}): Logger {
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const now = opts.now ?? (() => new Date());
  const secrets: string[] = [];

  const writeFile = (file: string, line: string): void => {
    mkdirSync(path.dirname(file), { recursive: true });
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      size = 0;
    }
    if (size > 0 && size + Buffer.byteLength(line) > maxBytes) renameSync(file, `${file}.1`);
    appendFileSync(file, line);
  };

  const emit = (level: string, m: string): void => {
    let line: string;
    try {
      line = `${now().toISOString()} ${level} ${redact(m, secrets)}\n`;
    } catch {
      return;
    }
    if (opts.stdout !== false) {
      try {
        guardStdout();
        process.stdout.write(line);
      } catch {
        // logging must never throw
      }
    }
    if (opts.file) {
      try {
        writeFile(opts.file, line);
      } catch {
        // logging must never throw
      }
    }
  };

  return {
    info: (m) => emit('INFO', m),
    warn: (m) => emit('WARN', m),
    error: (m) => emit('ERROR', m),
    addSecret: (s) => {
      if (s !== '') secrets.push(s);
    },
  };
}
