import { describe, expect, it } from 'vitest';
import { workerBootstrap } from './worker-bootstrap';

describe('workerBootstrap', () => {
  it('drops /mcp from an https URL', () => {
    const b = workerBootstrap('https://mcp.example.com/mcp');
    expect(b.hubBase).toBe('https://mcp.example.com');
    expect(b.unix).toContain('--hub https://mcp.example.com');
    expect(b.unix.endsWith('/mcp')).toBe(false);
  });

  it('keeps host and port of a private address', () => {
    const b = workerBootstrap('http://192.168.1.5:8318/mcp');
    expect(b.hubBase).toBe('http://192.168.1.5:8318');
    expect(b.unix).toContain('--hub http://192.168.1.5:8318');
    expect(b.windows).toContain('--hub http://192.168.1.5:8318');
  });

  it('removes a trailing slash and one /mcp, keeping the path prefix', () => {
    expect(workerBootstrap('https://example.com/hub/mcp/').hubBase).toBe('https://example.com/hub');
  });

  it('uses a placeholder host when the URL is unknown', () => {
    const b = workerBootstrap(null);
    expect(b.hubBase).toBeNull();
    expect(b.unix).toContain('https://<your-mcp-host>');
    expect(b.windows).toContain('https://<your-mcp-host>');
  });

  it('never fills in a key and never uses Bearer', () => {
    for (const url of ['https://mcp.example.com/mcp', null]) {
      const b = workerBootstrap(url);
      for (const cmd of [b.unix, b.windows]) {
        expect(cmd).toContain('<worker-api-key>');
        expect(cmd).toContain('run-agent.');
        expect(cmd).toContain('start --daemon --hub');
        expect(cmd).not.toContain('Bearer');
      }
    }
  });

  it('strips exactly one /mcp', () => {
    expect(workerBootstrap('https://x.example.com/mcp/mcp').hubBase).toBe('https://x.example.com/mcp');
  });

  it('trims surrounding whitespace', () => {
    expect(workerBootstrap(' https://mcp.example.com/mcp ').hubBase).toBe('https://mcp.example.com');
  });

  it('drops query and fragment so no token reaches the shell command', () => {
    const b = workerBootstrap('https://mcp.example.com/mcp?token=abc#x');
    expect(b.hubBase).toBe('https://mcp.example.com');
    for (const cmd of [b.unix, b.windows]) {
      expect(cmd).not.toContain('token');
      expect(cmd).not.toContain('?');
      expect(cmd).not.toContain('#');
    }
  });

  it.each(['', '   '])('treats blank input %j like null', (v) => {
    const b = workerBootstrap(v);
    expect(b.hubBase).toBeNull();
    expect(b.unix).toContain('https://<your-mcp-host>');
    expect(b.windows).toContain('https://<your-mcp-host>');
  });
});
