import { describe, expect, it } from 'vitest';
import { quickStartCommands } from './quick-start';

const KEY = 'sk_ctx_ab12';

function all(q: ReturnType<typeof quickStartCommands>): string[] {
  return [q.unix.claude, q.unix.extension, q.unix.worker, q.windows.claude, q.windows.extension, q.windows.worker];
}

describe('quickStartCommands', () => {
  it('fills the new key and the MCP URL into the Claude Code and worker commands', () => {
    const q = quickStartCommands('https://mcp.example.com/mcp', KEY);
    expect(q.mcpUrl).toBe('https://mcp.example.com/mcp');
    for (const claude of [q.unix.claude, q.windows.claude]) {
      expect(claude).toBe(
        `claude mcp add --transport http --scope user cortex-hub https://mcp.example.com/mcp --header "Authorization: Bearer ${KEY}"`,
      );
    }
    expect(q.unix.worker).toContain(`CORTEX_API_KEY=${KEY} bash -s -- start --daemon --hub https://mcp.example.com`);
    expect(q.windows.worker).toContain(`$env:CORTEX_API_KEY="${KEY}"`);
    expect(q.windows.worker).toContain('--hub https://mcp.example.com');
  });

  it('installs the extension without the key, which goes into the Agent Panel', () => {
    const q = quickStartCommands('https://mcp.example.com/mcp', KEY);
    expect(q.unix.extension).toMatch(/^curl -fsSL https:\/\/raw\.githubusercontent\.com\/.+\/install-extension\.sh \| bash$/);
    expect(q.windows.extension).toMatch(/^& \(\[scriptblock\]::Create\(\(irm https:\/\/raw\.githubusercontent\.com\/.+\/install-extension\.ps1\)\)\)$/);
    for (const cmd of [q.unix.extension, q.windows.extension]) expect(cmd).not.toContain(KEY);
  });

  it.each([
    ['https://mcp.example.com', 'https://mcp.example.com/mcp'],
    ['https://mcp.example.com/', 'https://mcp.example.com/mcp'],
    [' http://localhost:8318/mcp/ ', 'http://localhost:8318/mcp'],
    ['https://example.com/hub/mcp?token=abc#x', 'https://example.com/hub/mcp'],
  ])('normalizes %j to %j', (raw, mcpUrl) => {
    const q = quickStartCommands(raw, KEY);
    expect(q.mcpUrl).toBe(mcpUrl);
    expect(q.unix.claude).toContain(` ${mcpUrl} `);
    for (const cmd of all(q)) expect(cmd).not.toContain('token');
  });

  it.each([null, '', '   ', 'mcp.example.com/mcp', 'ftp://mcp.example.com/mcp'])(
    'keeps the host placeholder for %j',
    (raw) => {
      const q = quickStartCommands(raw, KEY);
      expect(q.mcpUrl).toBeNull();
      expect(q.unix.claude).toContain('https://<your-mcp-host>/mcp');
      expect(q.windows.worker).toContain('--hub https://<your-mcp-host>');
      expect(q.unix.claude).toContain(KEY);
    },
  );

  it('never puts a key with shell characters into a command', () => {
    const q = quickStartCommands('https://mcp.example.com/mcp', 'k"; rm -rf ~');
    for (const cmd of all(q)) expect(cmd).not.toContain('rm -rf');
    expect(q.unix.claude).toContain('Bearer <api-key>');
    expect(q.unix.worker).toContain('CORTEX_API_KEY=<api-key>');
  });
});
