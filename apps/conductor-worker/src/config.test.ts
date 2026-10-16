import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  detectHubBase,
  detectHubConfig,
  entryFromServer,
  hubBaseFromUrl,
  readClaudeJson,
  readCodexToml,
  readMcpJson,
  wsUrlFromHubBase,
} from './config.js';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./__fixtures__/config/${name}`, import.meta.url));

let root: string;
let n = 0;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'cortex-config-test-'));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A fresh fake home; `files` maps a relative path to a fixture name (or raw content via `raw:`). */
function fakeHome(files: Record<string, string>, repoPath = '/unused'): string {
  const home = path.join(root, `home${n++}`);
  for (const [rel, src] of Object.entries(files)) {
    const dest = path.join(home, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    if (src.startsWith('raw:')) writeFileSync(dest, src.slice(4));
    else if (src === 'claude.json') {
      writeFileSync(dest, readFileSync(fixture(src), 'utf8').replaceAll('__REPO__', repoPath));
    } else copyFileSync(fixture(src), dest);
  }
  return home;
}

describe('url helpers', () => {
  it('hubBaseFromUrl strips /mcp and a trailing slash, and leaves a bare origin unchanged', () => {
    expect(hubBaseFromUrl('https://h.example/mcp')).toBe('https://h.example');
    expect(hubBaseFromUrl('https://h.example/mcp/')).toBe('https://h.example');
    expect(hubBaseFromUrl('https://h.example/')).toBe('https://h.example');
    expect(hubBaseFromUrl('https://h.example')).toBe('https://h.example');
  });

  it('wsUrlFromHubBase maps http to ws and https to wss', () => {
    expect(wsUrlFromHubBase('https://h.example')).toBe('wss://h.example/ws/conductor');
    expect(wsUrlFromHubBase('http://localhost:8318')).toBe('ws://localhost:8318/ws/conductor');
  });
});

describe('readers', () => {
  it('reads the Claude Code url+headers form', () => {
    const home = fakeHome({ '.claude.json': 'claude.json' }, '/nowhere/repo');
    const e = readClaudeJson(path.join(home, '.claude.json'), '/nowhere/repo-x', {});
    expect(e).toEqual({
      url: 'https://h.example/mcp',
      apiKey: 'ctx_test_key_1',
      source: '~/.claude.json mcpServers',
    });
  });

  it('prefers the per-project entry in ~/.claude.json for the repo path', () => {
    const repo = path.join(root, 'proj-repo');
    mkdirSync(repo, { recursive: true });
    const home = fakeHome({ '.claude.json': 'claude.json' }, repo);
    const e = readClaudeJson(path.join(home, '.claude.json'), repo, {});
    expect(e?.url).toBe('https://p.example/mcp/');
    expect(e?.apiKey).toBe('ctx_test_key_proj');
    expect(e?.source).toBe('~/.claude.json projects[…]');
  });

  it('matches a per-project key stored under a path that is not the realpath', () => {
    const real = path.join(root, 'real-dir');
    const link = path.join(root, 'link-dir');
    mkdirSync(real, { recursive: true });
    // Claude Code stores the path it was launched from; here that is the unresolved one.
    const home = fakeHome({ '.claude.json': 'claude.json' }, path.resolve(link));
    const e = readClaudeJson(path.join(home, '.claude.json'), link, {});
    expect(e?.apiKey).toBe('ctx_test_key_proj');
  });

  it('reads the mcp-remote form with the url at any args index and HUB_API_KEY from env', () => {
    const home = fakeHome({ '.gemini/antigravity/mcp_config.json': 'agy-mcp-remote.json' });
    const e = readMcpJson(path.join(home, '.gemini/antigravity/mcp_config.json'), {}, 'agy');
    expect(e).toEqual({ url: 'https://h.example/mcp', apiKey: 'ctx_test_key_4', source: 'agy' });
  });

  it('reads the mcp-remote form key from the --header value when the entry has no env', () => {
    const e = entryFromServer(
      { command: 'npx', args: ['mcp-remote', 'https://h.example/mcp', '--header', 'Authorization: Bearer ${K}'] },
      { K: 'ctx_test_key_7' },
      'x',
    );
    expect(e?.apiKey).toBe('ctx_test_key_7');
    expect(e?.url).toBe('https://h.example/mcp');
  });

  it('reads Codex [mcp_servers.cortex-hub] with a [.env] sub-table', () => {
    const home = fakeHome({ '.codex/config.toml': 'codex-remote.toml' });
    const e = readCodexToml(path.join(home, '.codex/config.toml'), {});
    expect(e?.url).toBe('https://h.example/mcp');
    expect(e?.apiKey).toBe('ctx_test_key_2');
  });

  it('reads Codex url + http_headers (quoted table name)', () => {
    const home = fakeHome({ '.codex/config.toml': 'codex-url.toml' });
    const e = readCodexToml(path.join(home, '.codex/config.toml'), {});
    expect(e?.url).toBe('https://h.example/mcp');
    expect(e?.apiKey).toBe('ctx_test_key_3');
  });

  it('reads Codex bearer_token_env_var from env', () => {
    const home = fakeHome({
      '.codex/config.toml': 'raw:[mcp_servers.cortex-hub]\nurl = "https://h.example/mcp"\nbearer_token_env_var = "MY_TOK"\n',
    });
    const file = path.join(home, '.codex/config.toml');
    expect(readCodexToml(file, { MY_TOK: 'ctx_test_key_8' })?.apiKey).toBe('ctx_test_key_8');
    expect(readCodexToml(file, {})?.apiKey).toBeNull();
  });

  it('accepts serverUrl and httpUrl aliases', () => {
    const home = fakeHome({ 'w.json': 'windsurf-serverurl.json', '.cursor/mcp.json': 'cursor.json' });
    expect(readMcpJson(path.join(home, 'w.json'), {}, 'w')?.url).toBe('https://h.example/mcp');
    expect(readMcpJson(path.join(home, '.cursor/mcp.json'), {}, 'c')?.apiKey).toBe('ctx_test_key_5');
    expect(
      entryFromServer({ httpUrl: 'https://h.example/mcp', headers: { Authorization: 'Bearer k' } }, {}, 's')?.apiKey,
    ).toBe('k');
  });

  it('skips malformed JSON and a missing file without throwing', () => {
    const home = fakeHome({ 'bad.json': 'raw:{ nope', 'bad.toml': 'raw:[[[' });
    expect(readMcpJson(path.join(home, 'bad.json'), {}, 'x')).toBeNull();
    expect(readCodexToml(path.join(home, 'bad.toml'), {})).toBeNull();
    expect(readClaudeJson(path.join(home, 'missing.json'), '/r', {})).toBeNull();
  });

  it('never puts the key in source', () => {
    const home = fakeHome({ '.claude.json': 'claude.json' });
    const e = readClaudeJson(path.join(home, '.claude.json'), '/r', {});
    expect(e?.source).not.toContain('ctx_test_key');
  });
});

describe('detectHubConfig', () => {
  it('flags beat env beat config for both the URL and the key', () => {
    const home = fakeHome({ '.claude.json': 'claude.json' });
    const base = { homeDir: home, repoPath: '/r' };
    const fromConfig = detectHubConfig({ ...base, flags: {}, env: {} });
    expect(fromConfig).toMatchObject({ hubBase: 'https://h.example', apiKey: 'ctx_test_key_1' });

    const env = { CORTEX_HUB_URL: 'https://e.example/mcp', CORTEX_API_KEY: 'ctx_test_key_env' };
    expect(detectHubConfig({ ...base, flags: {}, env })).toMatchObject({
      hubBase: 'https://e.example',
      mcpUrl: 'https://e.example/mcp',
      wsUrl: 'wss://e.example/ws/conductor',
      apiKey: 'ctx_test_key_env',
    });

    expect(
      detectHubConfig({ ...base, flags: { hub: 'https://f.example', apiKey: 'ctx_test_key_flag' }, env }),
    ).toMatchObject({ hubBase: 'https://f.example', apiKey: 'ctx_test_key_flag' });
  });

  it('never reports the key in source', () => {
    const home = fakeHome({ '.claude.json': 'claude.json' });
    const r = detectHubConfig({ homeDir: home, repoPath: '/r', flags: { apiKey: 'ctx_test_key_flag' }, env: {} });
    expect(JSON.stringify(r)).toContain('ctx_test_key_flag');
    expect(JSON.stringify((r as { source: unknown }).source)).not.toContain('ctx_test_key');
  });

  it('does not use a config key for a different hub', () => {
    const home = fakeHome({ '.claude.json': 'claude.json' });
    const r = detectHubConfig({ homeDir: home, repoPath: '/r', flags: { hub: 'https://b.example' }, env: {} });
    expect(r).toEqual({ error: expect.stringMatching(/api key/i) });
  });

  it('uses a key from a later config file when it matches the chosen hub', () => {
    const home = fakeHome({ '.codex/config.toml': 'codex-url.toml', '.cursor/mcp.json': 'cursor.json' });
    const r = detectHubConfig({ homeDir: home, repoPath: '/r', flags: { hub: 'http://localhost:8318' }, env: {} });
    expect(r).toMatchObject({ hubBase: 'http://localhost:8318', apiKey: 'ctx_test_key_5' });
  });

  it('follows file order: claude, codex, agy, cursor', () => {
    const home = fakeHome({
      '.codex/config.toml': 'codex-url.toml',
      '.gemini/antigravity/mcp_config.json': 'agy-mcp-remote.json',
      '.cursor/mcp.json': 'cursor.json',
    });
    const r = detectHubConfig({ homeDir: home, repoPath: '/r', flags: {}, env: {} });
    expect(r).toMatchObject({ apiKey: 'ctx_test_key_3' });
  });

  it('skips malformed JSON and keeps looking', () => {
    const home = fakeHome({ '.claude.json': 'raw:{ broken', '.cursor/mcp.json': 'cursor.json' });
    const r = detectHubConfig({ homeDir: home, repoPath: '/r', flags: {}, env: {} });
    expect(r).toMatchObject({ hubBase: 'http://localhost:8318', apiKey: 'ctx_test_key_5' });
  });

  it('returns an error naming --hub when nothing is configured', () => {
    const home = fakeHome({});
    const r = detectHubConfig({ homeDir: home, repoPath: '/r', flags: {}, env: {} });
    expect(r).toEqual({ error: expect.stringContaining('--hub') });
  });
});

describe('detectHubBase', () => {
  it('flags beat env beat config, and names where the URL came from', () => {
    const home = fakeHome({ '.claude.json': 'claude.json' });
    const base = { homeDir: home, repoPath: '/r' };
    expect(detectHubBase({ ...base, flags: {}, env: {} })).toEqual({
      hubBase: 'https://h.example',
      source: '~/.claude.json mcpServers',
    });
    const env = { CORTEX_HUB_URL: 'https://e.example/mcp/' };
    expect(detectHubBase({ ...base, flags: {}, env })).toEqual({
      hubBase: 'https://e.example',
      source: 'env CORTEX_HUB_URL',
    });
    expect(detectHubBase({ ...base, flags: { hub: 'https://f.example/mcp' }, env })).toEqual({
      hubBase: 'https://f.example',
      source: '--hub',
    });
  });

  it('needs no key: a configured URL without one still resolves', () => {
    const home = fakeHome({
      '.cursor/mcp.json': 'raw:{"mcpServers":{"cortex-hub":{"url":"https://k.example/mcp"}}}',
    });
    const input = { homeDir: home, repoPath: '/r', flags: {}, env: {} };
    expect(detectHubBase(input)).toEqual({ hubBase: 'https://k.example', source: '~/.cursor/mcp.json mcpServers' });
    expect(detectHubConfig(input)).toEqual({ error: expect.stringMatching(/api key/i) });
  });

  it('agrees with detectHubConfig on the hub and its source', () => {
    const home = fakeHome({ '.codex/config.toml': 'codex-url.toml', '.cursor/mcp.json': 'cursor.json' });
    const input = { homeDir: home, repoPath: '/r', flags: {}, env: {} };
    const hub = detectHubBase(input);
    const full = detectHubConfig(input);
    expect(full).toMatchObject({ hubBase: (hub as { hubBase: string }).hubBase });
    expect((full as { source: { hub: string } }).source.hub).toBe((hub as { source: string }).source);
  });

  it('returns the --hub error when nothing is configured', () => {
    const home = fakeHome({});
    expect(detectHubBase({ homeDir: home, repoPath: '/r', flags: {}, env: {} })).toEqual({
      error: expect.stringContaining('--hub'),
    });
  });
});
