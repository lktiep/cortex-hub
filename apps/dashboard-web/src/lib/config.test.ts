import { describe, expect, it } from 'vitest';
import { resolveMcpEndpoint } from './config';

const at = (hostname: string, port = '') => ({ hostname, port });

describe('resolveMcpEndpoint', () => {
  it('prefers the configured URL and appends /mcp once', () => {
    expect(resolveMcpEndpoint('https://mcp.example.com', at('hub.example.com'))).toEqual({
      url: 'https://mcp.example.com/mcp',
      source: 'configured',
    });
    expect(resolveMcpEndpoint(' https://mcp.example.com/mcp/ ', at('localhost'))).toEqual({
      url: 'https://mcp.example.com/mcp',
      source: 'configured',
    });
  });

  it('derives host:8318 when the browser reaches the host directly', () => {
    for (const loc of [at('localhost'), at('192.168.1.5'), at('[::1]'), at('devbox'), at('nas.local'), at('hub.example.com', '3000')]) {
      expect(resolveMcpEndpoint('', loc)).toEqual({
        url: `http://${loc.hostname}:8318/mcp`,
        source: 'direct',
      });
    }
  });

  it('uses the address an agent dialled when nothing is configured', () => {
    const detected = { url: 'https://mcp.example.com', agentId: 'lead' };
    expect(resolveMcpEndpoint(null, at('hub.example.com'), detected)).toEqual({
      url: 'https://mcp.example.com/mcp',
      source: 'detected',
      agentId: 'lead',
    });
    // ahead of the host:8318 guess, which only works on the LAN
    expect(resolveMcpEndpoint('', at('192.168.1.5'), detected).source).toBe('detected');
    // EXTERNAL_MCP_URL still wins
    expect(resolveMcpEndpoint('https://pinned.example.com', at('hub.example.com'), detected)).toEqual({
      url: 'https://pinned.example.com/mcp',
      source: 'configured',
    });
  });

  it('invents no address behind a domain', () => {
    expect(resolveMcpEndpoint(null, at('hub.example.com'))).toEqual({ url: null, source: 'unconfigured' });
    expect(resolveMcpEndpoint('   ', at('hub.example.com'))).toEqual({ url: null, source: 'unconfigured' });
    expect(resolveMcpEndpoint(null, at('hub.example.com'), null)).toEqual({ url: null, source: 'unconfigured' });
  });
});
