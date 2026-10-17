import { RUN_AGENT_RAW, workerBootstrap } from './worker-bootstrap';

const MCP_PLACEHOLDER = 'https://<your-mcp-host>/mcp';
const KEY_PLACEHOLDER = '<api-key>';

export interface QuickStartSet {
  claude: string;
  extension: string;
  worker: string;
}

export interface QuickStartCommands {
  /** The MCP URL the commands use, or null while the host is still the placeholder. */
  mcpUrl: string | null;
  unix: QuickStartSet;
  windows: QuickStartSet;
}

/** `<origin><path>/mcp` from an http(s) hub or MCP URL; query, fragment and credentials dropped. */
function normalizeMcpUrl(raw: string | null): string | null {
  let url: URL;
  try {
    url = new URL((raw ?? '').trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const path = url.pathname.replace(/\/+$/, '').replace(/\/mcp$/, '');
  return `${url.origin}${path}/mcp`;
}

/** Copy-ready commands that connect one machine with a freshly created key. */
export function quickStartCommands(mcpUrl: string | null, apiKey: string): QuickStartCommands {
  const url = normalizeMcpUrl(mcpUrl);
  // Keys are sk_ctx_<hex>; anything else stays out of a shell line.
  const key = /^[\w-]+$/.test(apiKey) ? apiKey : KEY_PLACEHOLDER;
  const claude = `claude mcp add --transport http --scope user cortex-hub ${url ?? MCP_PLACEHOLDER} --header "Authorization: Bearer ${key}"`;
  const worker = workerBootstrap(url, key);
  return {
    mcpUrl: url,
    unix: {
      claude,
      extension: `curl -fsSL ${RUN_AGENT_RAW}/install-extension.sh | bash`,
      worker: worker.unix,
    },
    windows: {
      claude,
      extension: `& ([scriptblock]::Create((irm ${RUN_AGENT_RAW}/install-extension.ps1)))`,
      worker: worker.windows,
    },
  };
}
