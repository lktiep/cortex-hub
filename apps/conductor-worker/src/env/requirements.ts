import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/** A tool the project needs on this machine. */
export interface Requirement {
  tool: string;
  /** A semver range its version must satisfy; none = any version. */
  range?: string;
  /** The version to install when it is missing or out of range (pnpm from packageManager). */
  installVersion?: string;
  /** Why the project needs it, for the person reading `cw check`. */
  why: string;
  /** false: a warning; tasks can still run without it. */
  required: boolean;
}

/** The `worker` section of the project's .cortex/project-profile.json. */
export interface WorkerProfile {
  /** Runs in each task's fresh worktree before the engine; "" turns the inferred install off. */
  setupCommand?: string;
  testCommand?: string;
  /** Tools the project needs that the files do not show; when given, it replaces the hook scan. */
  requires?: string[];
}

export interface Needs {
  requirements: Requirement[];
  /** The profile's setup command, else the lockfile's frozen install; null = none. */
  setupCommand: string | null;
  testCommand: string | null;
  /** What could not be read, or was left out on purpose. */
  notes: string[];
}

export const PROFILE_FILE = path.join('.cortex', 'project-profile.json');
/** The oldest Node the worker itself runs on. */
const MIN_NODE = '>=20';
const TOOL_NAME = /^[A-Za-z0-9][\w.+-]*$/;
const HOOK_FILES = [
  'lefthook.yml',
  'lefthook.yaml',
  '.lefthook.yml',
  '.lefthook.yaml',
  'lefthook-local.yml',
  'lefthook-local.yaml',
  '.lefthook-local.yml',
  '.lefthook-local.yaml',
];
const HOOK_DIRS = ['.husky', '.githooks'];
/** What the hooks are scanned for: a call, not just a mention. */
const HOOK_TOOLS: ReadonlyArray<{ tool: string; pattern: RegExp }> = [
  {
    tool: 'docker',
    pattern:
      /\bdocker-compose\b|\bdocker\s+(?:compose|run|build|exec|info|ps|up|down|pull|push|start|stop|image|images|container|network|volume)\b|['"`]docker['"`]/,
  },
  { tool: 'python3', pattern: /\bpython3(?=\s|['"`]|$)/m },
];
const SCRIPT_FILE = /^(?:\.\/)?[\w./-]+\.(?:m?js|cjs|m?ts|sh|bash|py|ps1)$/;
const MAX_FOLLOWED_FILES = 20;
const MAX_TEXT = 256 * 1024;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function readText(file: string): string | null {
  try {
    if (statSync(file).size > MAX_TEXT) return null;
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readJson(file: string): { value: unknown } | { error: 'missing' | 'invalid' } {
  const text = readText(file);
  if (text === null) return { error: 'missing' };
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return { error: 'invalid' };
  }
}

/** The profile's `worker` section; anything malformed is left out and named in `notes`. */
export function readWorkerProfile(repo: string): { profile: WorkerProfile; notes: string[] } {
  const r = readJson(path.join(repo, PROFILE_FILE));
  if ('error' in r) {
    return { profile: {}, notes: r.error === 'invalid' ? [`${PROFILE_FILE} is not valid JSON; its worker section is ignored`] : [] };
  }
  const worker = isObj(r.value) ? r.value['worker'] : undefined;
  if (worker === undefined) return { profile: {}, notes: [] };
  if (!isObj(worker)) return { profile: {}, notes: [`${PROFILE_FILE}: worker must be an object; ignored`] };

  const profile: WorkerProfile = {};
  const notes: string[] = [];
  for (const key of ['setupCommand', 'testCommand'] as const) {
    const v = worker[key];
    if (v === undefined) continue;
    if (typeof v === 'string') profile[key] = v.trim();
    else notes.push(`${PROFILE_FILE}: worker.${key} must be a string; ignored`);
  }
  const requires = worker['requires'];
  if (requires !== undefined) {
    if (Array.isArray(requires) && requires.every((t): t is string => typeof t === 'string' && TOOL_NAME.test(t))) {
      profile.requires = [...new Set(requires)];
    } else {
      notes.push(`${PROFILE_FILE}: worker.requires must be a list of command names, like ["docker", "python3"]; ignored`);
    }
  }
  return { profile, notes };
}

// --- versions ---

type Ver = [number, number, number];
type Bound = { op: '>=' | '<'; v: Ver };

/** The first x.y[.z] in `text` (`v22.3.0`, `Python 3.12.1`, `git version 2.47.1`). */
export function parseVersion(text: string): string | null {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  return m === null ? null : `${m[1]}.${m[2]}.${m[3] ?? '0'}`;
}

function cmp(a: Ver, b: Ver): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** `1`, `1.2`, `1.2.3`, `1.x`, `*`, with a `v` and a prerelease allowed; a wildcard ends it. */
function partial(s: string): Array<number | null> | null {
  const m = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:[-+][\w.-]*)?$/.exec(s);
  if (m === null) return null;
  const parts: Array<number | null> = [];
  for (const p of [m[1], m[2], m[3]]) {
    parts.push(p === undefined || /^[xX*]$/.test(p) || parts.includes(null) ? null : Number(p));
  }
  return parts;
}

function bounds(comparator: string): Bound[] | null {
  const m = /^(\^|~>?|>=|<=|>|<|=)?(.*)$/.exec(comparator);
  const p = m === null ? null : partial(m[2] ?? '');
  if (m === null || p === null) return null;
  const op = m[1] ?? '';
  const [a, b, c] = p;
  if (a === null || a === undefined) return op === '<' || op === '>' ? [{ op: '<', v: [0, 0, 0] }] : [];
  const lo: Ver = [a, b ?? 0, c ?? 0];
  // the first version past what was written: 1 -> 2.0.0, 1.2 -> 1.3.0, 1.2.3 -> 1.2.4
  const next: Ver = b === null || b === undefined ? [a + 1, 0, 0] : c === null || c === undefined ? [a, b + 1, 0] : [a, b, c + 1];
  switch (op) {
    case '':
    case '=':
      return [{ op: '>=', v: lo }, { op: '<', v: next }];
    case '>=':
      return [{ op: '>=', v: lo }];
    case '>':
      return [{ op: '>=', v: next }];
    case '<':
      return [{ op: '<', v: lo }];
    case '<=':
      return [{ op: '<', v: next }];
    case '^': {
      const upper: Ver =
        a > 0 || b === null || b === undefined ? [a + 1, 0, 0] : b > 0 || c === null || c === undefined ? [0, b + 1, 0] : [0, 0, c + 1];
      return [{ op: '>=', v: lo }, { op: '<', v: upper }];
    }
    default: // ~ and ~>
      return [{ op: '>=', v: lo }, { op: '<', v: b === null || b === undefined ? [a + 1, 0, 0] : [a, b + 1, 0] }];
  }
}

/**
 * Whether `version` is in the npm-style `range` (`>=20`, `^9.1`, `~3.12`, `20.x`, `>=18 <23`,
 * `^18 || ^20`, `1.2 - 2`). null when either cannot be read; prerelease tags are ignored.
 */
export function satisfies(version: string, range: string): boolean | null {
  const ver = parseVersion(version);
  if (ver === null) return null;
  const v = ver.split('.').map(Number) as Ver;
  let result = false;
  for (const alt of range.split('||')) {
    const tokens = alt.replace(/(\^|~>?|>=|<=|>|<|=)\s+/g, '$1').trim().split(/\s+/).filter((t) => t !== '');
    let comparators = tokens;
    if (tokens.length === 3 && tokens[1] === '-') comparators = [`>=${tokens[0]}`, `<=${tokens[2]}`];
    const all: Bound[] = [];
    for (const c of comparators) {
      const b = bounds(c);
      if (b === null) return null;
      all.push(...b);
    }
    if (all.every((b) => (b.op === '>=' ? cmp(v, b.v) >= 0 : cmp(v, b.v) < 0))) result = true;
  }
  return result;
}

// --- the hook scan ---

const isFile = (file: string): boolean => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

function list(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/** The hook files: lefthook configs, .husky/* (not its _ plumbing), .githooks/*, .lefthook/<hook>/*. */
function hookTexts(repo: string, pkg: Obj | null): Array<{ where: string; text: string }> {
  const rel: string[] = [...HOOK_FILES];
  for (const dir of HOOK_DIRS) rel.push(...list(path.join(repo, dir)).map((f) => `${dir}/${f}`));
  for (const hook of list(path.join(repo, '.lefthook'))) {
    rel.push(...list(path.join(repo, '.lefthook', hook)).map((f) => `.lefthook/${hook}/${f}`));
  }
  const out: Array<{ where: string; text: string }> = [];
  for (const where of rel) {
    const file = path.join(repo, where);
    const text = isFile(file) ? readText(file) : null;
    if (text !== null) out.push({ where, text });
  }
  if (pkg !== null) {
    for (const key of ['simple-git-hooks', 'husky']) {
      const v = pkg[key];
      if (isObj(v)) out.push({ where: `package.json ${key}`, text: JSON.stringify(v) });
    }
  }
  return out;
}

/** The package.json scripts the text runs (`pnpm verify`, `npm run lint`), and theirs, transitively. */
function followScripts(texts: string[], scripts: Record<string, string>): Array<{ name: string; text: string }> {
  const seen = new Set<string>();
  const out: Array<{ name: string; text: string }> = [];
  const queue = [...texts];
  while (queue.length > 0) {
    const text = queue.shift() ?? '';
    for (const line of text.split('\n')) {
      if (!/\b(?:pnpm|npm|yarn|bun)\b/.test(line)) continue;
      for (const token of line.split(/[\s'"`;&|()]+/)) {
        const body = scripts[token];
        if (body === undefined || seen.has(token)) continue;
        seen.add(token);
        out.push({ name: token, text: body });
        queue.push(body);
      }
    }
  }
  return out;
}

/** Files of the repo that `text` runs by path (`node scripts/verify.mjs`), one level deep. */
function namedFiles(repo: string, text: string): string[] {
  const root = path.resolve(repo);
  const out: string[] = [];
  for (const token of text.split(/[\s'"`;&|()]+/)) {
    if (!SCRIPT_FILE.test(token)) continue;
    const full = path.resolve(root, token);
    if (!full.startsWith(root + path.sep)) continue;
    out.push(path.relative(root, full).split(path.sep).join('/'));
  }
  return out;
}

/** The tools the git hooks call, and where: hooks, the scripts they run, the files those name. */
export function scanHooks(repo: string, pkg: Obj | null): Map<string, string> {
  const hooks = hookTexts(repo, pkg);
  const found = new Map<string, string>();
  if (hooks.length === 0) return found;
  const scripts: Record<string, string> = {};
  const raw = pkg?.['scripts'];
  if (isObj(raw)) for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') scripts[k] = v;

  const texts: Array<{ where: string; text: string }> = [...hooks];
  for (const s of followScripts(hooks.map((h) => h.text), scripts)) {
    texts.push({ where: `package.json script "${s.name}"`, text: s.text });
  }
  const files = [...new Set(texts.flatMap((t) => namedFiles(repo, t.text)))].slice(0, MAX_FOLLOWED_FILES);
  for (const f of files) {
    const text = readText(path.join(repo, f));
    if (text !== null) texts.push({ where: f, text });
  }
  for (const { tool, pattern } of HOOK_TOOLS) {
    const hit = texts.find((t) => pattern.test(t.text));
    if (hit !== undefined) found.set(tool, hit.where);
  }
  return found;
}

// --- inference ---

const LOCKFILES: ReadonlyArray<{ file: string; pm: string; install: string }> = [
  { file: 'pnpm-lock.yaml', pm: 'pnpm', install: 'pnpm install --frozen-lockfile' },
  { file: 'yarn.lock', pm: 'yarn', install: 'yarn install --frozen-lockfile' },
  { file: 'bun.lock', pm: 'bun', install: 'bun install --frozen-lockfile' },
  { file: 'bun.lockb', pm: 'bun', install: 'bun install --frozen-lockfile' },
  { file: 'package-lock.json', pm: 'npm', install: 'npm ci' },
];

/** What `inferNeeds` reads: a trial run's result holds until one of these changes. */
export const NEEDS_INPUTS: readonly string[] = [
  'package.json',
  ...LOCKFILES.map((l) => l.file),
  '.nvmrc',
  '.node-version',
  '.cortex/project-profile.json',
  ...HOOK_FILES,
  ...HOOK_DIRS,
  '.lefthook',
];

/** What `repo` needs on this machine, read from its files and its profile's `worker` section. */
export function inferNeeds(repo: string): Needs {
  const { profile, notes } = readWorkerProfile(repo);
  const reqs: Requirement[] = [
    { tool: 'git', why: 'clones the project and pushes the task branches', required: true },
    { tool: 'gh', why: 'opens the pull requests (without it a task ends with a compare link)', required: false },
  ];

  const pkgRead = readJson(path.join(repo, 'package.json'));
  let pkg: Obj | null = null;
  if ('value' in pkgRead && isObj(pkgRead.value)) pkg = pkgRead.value;
  else if ('error' in pkgRead && pkgRead.error === 'invalid') notes.push('package.json is not valid JSON; it was not read');

  let inferredSetup: string | null = null;
  if (pkg !== null) {
    const engines = isObj(pkg['engines']) ? pkg['engines'] : {};
    const nodeRange = typeof engines['node'] === 'string' && engines['node'].trim() !== '' ? engines['node'].trim() : null;
    reqs.push({
      tool: 'node',
      range: nodeRange ?? MIN_NODE,
      why: nodeRange === null ? 'runs the worker and the project' : `package.json engines.node is ${nodeRange}`,
      required: true,
    });
    for (const file of ['.nvmrc', '.node-version']) {
      const want = (readText(path.join(repo, file)) ?? '').trim();
      const major = /^v?(\d+)(?:\.|$)/.exec(want)?.[1];
      if (major !== undefined) {
        reqs.push({ tool: 'node', range: `${major}.x`, why: `${file} asks for Node ${want}`, required: false });
        break;
      }
    }

    const lock = LOCKFILES.find((l) => isFile(path.join(repo, l.file)));
    const pmField = typeof pkg['packageManager'] === 'string' ? pkg['packageManager'] : '';
    const pm = /^(pnpm|yarn|npm|bun)@(\d+)\.(\d+)\.(\d+)/.exec(pmField);
    if (pm !== null) {
      const [, name = '', major, minor, patch] = pm;
      const version = `${major}.${minor}.${patch}`;
      if (name !== 'npm') {
        reqs.push({
          tool: name,
          range: `${major}.x`,
          installVersion: version,
          why: `package.json packageManager is ${name}@${version}`,
          required: true,
        });
      }
    } else if (lock !== undefined && lock.pm !== 'npm') {
      reqs.push({ tool: lock.pm, why: `the project has ${lock.file}`, required: true });
    }
    // only a frozen install: one without a lockfile would write one into the task's commit
    inferredSetup = lock?.install ?? null;
    if (lock === undefined && profile.setupCommand === undefined) {
      notes.push(`no lockfile, so no install runs before a task; set worker.setupCommand in ${PROFILE_FILE} if one is needed`);
    }
  }

  const hookTools = scanHooks(repo, pkg);
  if (profile.requires !== undefined) {
    for (const tool of profile.requires) reqs.push({ tool, why: `${PROFILE_FILE} worker.requires lists it`, required: true });
    for (const [tool, where] of hookTools) {
      if (!profile.requires.includes(tool)) notes.push(`${where} mentions ${tool}, but worker.requires does not list it`);
    }
  } else {
    for (const [tool, where] of hookTools) {
      reqs.push({ tool, why: `the git hooks run it (${where})`, required: true });
    }
  }

  return {
    requirements: reqs,
    setupCommand: profile.setupCommand !== undefined ? profile.setupCommand || null : inferredSetup,
    testCommand: profile.testCommand || null,
    notes,
  };
}

const fromEnv = (env: NodeJS.ProcessEnv, key: string): string | null => {
  const v = env[key];
  return v !== undefined && v.trim() !== '' ? v : null;
};

/**
 * The setup and test commands a task runs in `dir`: this machine's CORTEX_SETUP_CMD and
 * CORTEX_TEST_CMD, else the project's own. A task's context can still override both.
 */
export function projectCommands(dir: string, env: NodeJS.ProcessEnv): { setup: string | null; test: string | null } {
  const needs = inferNeeds(dir);
  return {
    setup: fromEnv(env, 'CORTEX_SETUP_CMD') ?? needs.setupCommand,
    test: fromEnv(env, 'CORTEX_TEST_CMD') ?? needs.testCommand,
  };
}
