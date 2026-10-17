import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';

export interface McpEntry {
  url: string;
  apiKey: string | null;
  source: string;
}

export interface HubConfig {
  hubBase: string;
  mcpUrl: string;
  wsUrl: string;
  apiKey: string;
  source: { hub: string; key: string };
}

export interface DetectInput {
  flags: { hub?: string; apiKey?: string };
  env: NodeJS.ProcessEnv;
  homeDir: string;
  repoPath: string;
}

const SERVER_NAME = 'cortex-hub';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

export function hubBaseFromUrl(url: string): string {
  let base = url.trim().replace(/\/+$/, '');
  if (base.endsWith('/mcp')) base = base.slice(0, -'/mcp'.length);
  return base.replace(/\/+$/, '');
}

export function wsUrlFromHubBase(base: string): string {
  return `${base.replace(/^http/i, 'ws')}/ws/conductor`;
}

/** Resolves `${VAR}` from the entry's env, then the process env. Null when any is unresolved. */
function expand(value: string, entryEnv: Obj, env: NodeJS.ProcessEnv): string | null {
  let missing = false;
  const out = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
    const v = str(entryEnv[name]) ?? str(env[name]);
    if (v === null) missing = true;
    return v ?? '';
  });
  return missing ? null : out;
}

function bearer(header: string): string | null {
  const m = /^\s*Bearer\s+(\S+)\s*$/i.exec(header);
  return m?.[1] ?? null;
}

function authFromHeaders(headers: unknown, entryEnv: Obj, env: NodeJS.ProcessEnv): string | null {
  if (!isObj(headers)) return null;
  const raw = str(headers['Authorization']) ?? str(headers['authorization']);
  if (raw === null) return null;
  const value = expand(raw, entryEnv, env);
  return value === null ? null : bearer(value);
}

function headerFromArgs(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a === '--header' || a === '-H') {
      const next = args[i + 1];
      if (next !== undefined && /^authorization\s*:/i.test(next)) return next.replace(/^authorization\s*:/i, '');
    } else if (/^--header=authorization\s*:/i.test(a)) {
      return a.replace(/^--header=authorization\s*:/i, '');
    }
  }
  return null;
}

export function entryFromServer(server: unknown, env: NodeJS.ProcessEnv, source: string): McpEntry | null {
  if (!isObj(server)) return null;
  const entryEnv = isObj(server['env']) ? server['env'] : {};

  const remote = str(server['url']) ?? str(server['serverUrl']) ?? str(server['httpUrl']);
  if (remote !== null) {
    let apiKey =
      authFromHeaders(server['headers'], entryEnv, env) ?? authFromHeaders(server['http_headers'], entryEnv, env);
    const tokenVar = str(server['bearer_token_env_var']);
    if (apiKey === null && tokenVar !== null) apiKey = str(env[tokenVar]);
    return { url: remote, apiKey, source };
  }

  const args = Array.isArray(server['args']) ? server['args'].filter((a): a is string => typeof a === 'string') : [];
  const url = args.find((a) => /^https?:\/\//i.test(a));
  if (url === undefined) return null;
  let apiKey = str(entryEnv['HUB_API_KEY']);
  if (apiKey === null) {
    const header = headerFromArgs(args);
    const expanded = header === null ? null : expand(header, entryEnv, env);
    apiKey = expanded === null ? null : bearer(expanded);
  }
  return { url, apiKey, source };
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function serverIn(container: unknown, key: string): unknown {
  return isObj(container) && isObj(container[key]) ? (container[key] as Obj)[SERVER_NAME] : undefined;
}

export function readClaudeJson(file: string, repoPath: string, env: NodeJS.ProcessEnv): McpEntry | null {
  const json = readJson(file);
  if (!isObj(json)) return null;

  const resolved = path.resolve(repoPath);
  let real = resolved;
  try {
    real = realpathSync(repoPath);
  } catch {
    // keep the resolved path
  }
  const projects = isObj(json['projects']) ? json['projects'] : {};
  for (const key of new Set([real, resolved])) {
    const e = entryFromServer(serverIn(projects[key], 'mcpServers'), env, '~/.claude.json projects[…]');
    if (e !== null) return e;
  }
  return entryFromServer(serverIn(json, 'mcpServers'), env, '~/.claude.json mcpServers');
}

export function readCodexToml(file: string, env: NodeJS.ProcessEnv): McpEntry | null {
  try {
    const toml: unknown = parseToml(readFileSync(file, 'utf8'));
    return entryFromServer(serverIn(toml, 'mcp_servers'), env, '~/.codex/config.toml mcp_servers');
  } catch {
    return null;
  }
}

export function readMcpJson(file: string, env: NodeJS.ProcessEnv, source: string): McpEntry | null {
  return entryFromServer(serverIn(readJson(file), 'mcpServers'), env, source);
}

/** The cortex-hub entries in the agent configs, read once and only when first asked for. */
function mcpEntries(input: DetectInput): () => McpEntry[] {
  const { env, homeDir, repoPath } = input;
  const readers: Array<() => McpEntry | null> = [
    () => readClaudeJson(path.join(homeDir, '.claude.json'), repoPath, env),
    () => readCodexToml(path.join(homeDir, '.codex', 'config.toml'), env),
    () =>
      readMcpJson(
        path.join(homeDir, '.gemini', 'antigravity', 'mcp_config.json'),
        env,
        '~/.gemini/antigravity/mcp_config.json mcpServers',
      ),
    // Antigravity 2.x keeps its MCP servers here; the path above is often a symlink to this file.
    () =>
      readMcpJson(path.join(homeDir, '.gemini', 'config', 'mcp_config.json'), env, '~/.gemini/config/mcp_config.json mcpServers'),
    () => readMcpJson(path.join(homeDir, '.cursor', 'mcp.json'), env, '~/.cursor/mcp.json mcpServers'),
  ];
  let cache: McpEntry[] | null = null;
  return () => {
    cache ??= readers.map((r) => r()).filter((e): e is McpEntry => e !== null);
    return cache;
  };
}

function hubBaseOf(input: DetectInput, entries: () => McpEntry[]): { hubBase: string; source: string } | { error: string } {
  const { flags, env } = input;
  let hubUrl: string | null;
  let source: string;
  if ((hubUrl = str(flags.hub)) !== null) source = '--hub';
  else if ((hubUrl = str(env['CORTEX_HUB_URL'])) !== null) source = 'env CORTEX_HUB_URL';
  else {
    const first = entries()[0];
    hubUrl = first?.url ?? null;
    source = first?.source ?? '';
  }
  if (hubUrl === null) {
    return { error: 'No hub URL found. Pass --hub <url>, set CORTEX_HUB_URL, or configure the cortex-hub MCP server.' };
  }
  return { hubBase: hubBaseFromUrl(hubUrl), source };
}

/** The hub base URL alone (flags, env, then agent configs); needs no api key. */
export function detectHubBase(input: DetectInput): { hubBase: string; source: string } | { error: string } {
  return hubBaseOf(input, mcpEntries(input));
}

export function detectHubConfig(input: DetectInput): HubConfig | { error: string } {
  const { flags, env } = input;
  const entries = mcpEntries(input);

  const hub = hubBaseOf(input, entries);
  if ('error' in hub) return hub;
  const { hubBase, source: hubSource } = hub;

  let apiKey: string | null;
  let keySource: string;
  if ((apiKey = str(flags.apiKey)) !== null) keySource = '--api-key';
  else if ((apiKey = str(env['CORTEX_API_KEY'])) !== null) keySource = 'env CORTEX_API_KEY';
  else {
    const match = entries().find((e) => e.apiKey !== null && hubBaseFromUrl(e.url) === hubBase);
    apiKey = match?.apiKey ?? null;
    keySource = match?.source ?? '';
  }
  if (apiKey === null) {
    return { error: `No api key found for ${hubBase}. Pass --api-key <key> or set CORTEX_API_KEY.` };
  }

  return {
    hubBase,
    mcpUrl: `${hubBase}/mcp`,
    wsUrl: wsUrlFromHubBase(hubBase),
    apiKey,
    source: { hub: hubSource, key: keySource },
  };
}
