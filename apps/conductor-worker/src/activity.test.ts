import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createActivity, hubLine, pathStripper, scrubSecrets, transcriptEntry } from './activity.js';
import type { Transcript } from './transcript.js';

describe('scrubSecrets', () => {
  it('removes token shapes', () => {
    const gh = `ghp_${'a'.repeat(20)}`;
    const pat = `github_pat_${'b'.repeat(20)}`;
    const ant = `sk-ant-${'c'.repeat(20)}`;
    const aws = `AKIA${'D'.repeat(16)}`;
    const slack = `xoxb-${'1'.repeat(10)}`;
    const text = `hub sk_ctx_k1 gh ${gh} pat ${pat} ant ${ant} aws ${aws} slack ${slack}`;
    expect(scrubSecrets(text)).toBe('hub *** gh *** pat *** ant *** aws *** slack ***');
  });
  it('removes bearer values and values given to secret-sounding names', () => {
    expect(scrubSecrets('Authorization: Bearer abc.def-123')).toBe('Authorization: Bearer ***');
    expect(scrubSecrets('API_KEY=k-sekrit ./run')).toBe('API_KEY=*** ./run');
    expect(scrubSecrets('{"password": "k-sekrit", "user": "u"}')).toBe('{"password": "***", "user": "u"}');
    expect(scrubSecrets('token: k-sekrit')).toBe('token: ***');
  });
  it('removes the credentials of a URL', () => {
    expect(scrubSecrets('push https://u:k-sekrit@example.com/o/r.git')).not.toContain('k-sekrit');
  });
  it('leaves ordinary text alone', () => {
    const text = 'Edit: src/token-store.ts, the tokens are fine; sk-short';
    expect(scrubSecrets(text)).toBe(text);
  });
});

describe('pathStripper', () => {
  it('makes worktree paths relative and the home folder ~', () => {
    const strip = pathStripper('/home/u/.cortex/worker/w1/worktrees/t1', '/home/u');
    expect(strip('Read: /home/u/.cortex/worker/w1/worktrees/t1/src/a.ts')).toBe('Read: src/a.ts');
    expect(strip('cd /home/u/.cortex/worker/w1/worktrees/t1 && ls')).toBe('cd . && ls');
    expect(strip('cat /home/u/.npmrc')).toBe('cat ~/.npmrc');
  });
  it('handles both slashes on Windows', () => {
    const strip = pathStripper('C:\\Users\\u\\.cortex\\worker\\w1\\worktrees\\t1', 'C:\\Users\\u');
    expect(strip('Read: C:\\Users\\u\\.cortex\\worker\\w1\\worktrees\\t1\\src\\a.ts')).toBe('Read: src\\a.ts');
    expect(strip('Read: C:/Users/u/.cortex/worker/w1/worktrees/t1/src/a.ts')).toBe('Read: src/a.ts');
    expect(strip('type C:\\Users\\u\\notes.txt')).toBe('type ~\\notes.txt');
  });
});

describe('hubLine', () => {
  it('marks each kind and keeps one short line', () => {
    expect(hubLine({ kind: 'text', text: 'Looking at\n  the parser' })).toBe('Looking at the parser');
    expect(hubLine({ kind: 'thinking', text: 'why' })).toBe('(thinking) why');
    expect(hubLine({ kind: 'tool', text: 'Bash: pnpm test' })).toBe('→ Bash: pnpm test');
    expect(hubLine({ kind: 'error', text: 'exit 1' })).toBe('✗ exit 1');
    expect(hubLine({ kind: 'info', text: 'tests passed' })).toBe('• tests passed');
    expect(hubLine({ kind: 'text', text: 'x'.repeat(500) })).toHaveLength(300);
    expect(hubLine({ kind: 'thinking', text: 'y'.repeat(500) })).toHaveLength('(thinking) '.length + 200);
  });
  it('keeps tool output and stderr out of the hub', () => {
    expect(hubLine({ kind: 'result', text: 'file contents' })).toBeNull();
    expect(hubLine({ kind: 'log', text: 'stderr line' })).toBeNull();
  });
});

describe('transcriptEntry', () => {
  it('stamps the local time and indents the following lines', () => {
    const at = new Date(2026, 9, 18, 9, 5, 7);
    expect(transcriptEntry({ kind: 'tool', text: 'Bash: ls' }, at)).toBe('09:05:07 → Bash: ls');
    expect(transcriptEntry({ kind: 'result', text: 'a\nb' }, at)).toBe('09:05:07 ← a\n         b');
    expect(transcriptEntry({ kind: 'log', text: 'warn' }, at)).toBe('09:05:07 stderr: warn');
    expect(transcriptEntry({ kind: 'text', text: 'hi' }, at)).toBe('09:05:07 hi');
  });
});

function memoryTranscript(): Transcript & { lines: string[]; closed: boolean } {
  const t = {
    file: '/x/t1.log',
    lines: [] as string[],
    closed: false,
    write(text: string) {
      t.lines.push(text);
    },
    close() {
      t.closed = true;
    },
  };
  return t;
}

describe('createActivity', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes every item to the transcript and short, scrubbed lines to the hub', () => {
    const sent: Array<[string, number | undefined]> = [];
    const transcript = memoryTranscript();
    const a = createActivity({
      send: (m, idle) => sent.push([m, idle]),
      transcript,
      strip: pathStripper('/w/t1', '/home/u'),
    });
    a.engine({ kind: 'tool', text: 'Bash: TOKEN=k-sekrit /w/t1/run.sh' });
    a.engine({ kind: 'result', text: 'secret output' });
    a.stop();

    expect(sent).toEqual([['→ Bash: TOKEN=*** run.sh', undefined]]);
    expect(transcript.lines.join('\n')).toContain('→ Bash: TOKEN=*** /w/t1/run.sh');
    expect(transcript.lines.join('\n')).toContain('← secret output');
    expect(transcript.lines.join('\n')).not.toContain('k-sekrit');
    expect(transcript.closed).toBe(true);
  });

  it('sends a heartbeat naming the step after a minute without output, then once a minute', () => {
    const sent: Array<[string, number | undefined]> = [];
    const a = createActivity({ send: (m, idle) => sent.push([m, idle]) });
    a.phase('engine: claude (opus)');
    a.engine({ kind: 'tool', text: 'Bash: pnpm test' });
    const beats = (): Array<[string, number | undefined]> => sent.filter(([, idle]) => idle !== undefined);
    vi.advanceTimersByTime(59_999);
    expect(beats()).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(beats()).toEqual([['still running: Bash: pnpm test, no output for 1 min', 60_000]]);
    expect(sent.map(([m]) => m)).toEqual(['• engine: claude (opus)', '→ Bash: pnpm test', beats()[0]?.[0]]);

    vi.advanceTimersByTime(59_999);
    expect(beats()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(beats().at(-1)).toEqual(['still running: Bash: pnpm test, no output for 2 min', 120_000]);
    a.stop();
  });

  it('sends the lines still waiting in a batch before the heartbeat', () => {
    const sent: Array<[string, number | undefined]> = [];
    const a = createActivity({ send: (m, idle) => sent.push([m, idle]), batch: { intervalMs: 600_000 } });
    a.engine({ kind: 'text', text: 'one' });
    a.engine({ kind: 'text', text: 'two' });
    vi.advanceTimersByTime(60_000);
    expect(sent).toEqual([
      ['one', undefined],
      ['two', undefined],
      ['still running: starting, no output for 1 min', 60_000],
    ]);
    a.stop();
  });

  it('new output resets the quiet clock', () => {
    const sent: Array<[string, number | undefined]> = [];
    const a = createActivity({ send: (m, idle) => sent.push([m, idle]) });
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(30_000);
      a.engine({ kind: 'text', text: `step ${i}` });
    }
    expect(sent.filter(([, idle]) => idle !== undefined)).toEqual([]);
    a.stop();
  });

  it('stop sends what is waiting, ends the heartbeat and ignores later items', () => {
    const sent: string[] = [];
    const a = createActivity({ send: (m) => sent.push(m) });
    a.engine({ kind: 'text', text: 'one' });
    a.engine({ kind: 'text', text: 'two' });
    a.stop();
    expect(sent).toEqual(['one', 'two']);
    a.engine({ kind: 'text', text: 'three' });
    vi.advanceTimersByTime(600_000);
    expect(sent).toEqual(['one', 'two']);
  });

  it('a throwing send breaks neither the items nor the heartbeat', () => {
    const a = createActivity({
      send: () => {
        throw new Error('socket closed');
      },
    });
    expect(() => a.engine({ kind: 'text', text: 'x' })).not.toThrow();
    expect(() => vi.advanceTimersByTime(120_000)).not.toThrow();
    a.stop();
  });
});
