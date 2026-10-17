export const RUN_AGENT_RAW = 'https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts';

const HOST_PLACEHOLDER = 'https://<your-mcp-host>';

export interface WorkerBootstrap {
  hubBase: string | null;
  unix: string;
  windows: string;
}

/** Build the one-line worker bootstrap commands from the hub's MCP URL. `apiKey` goes in as is. */
export function workerBootstrap(mcpUrl: string | null, apiKey = '<worker-api-key>'): WorkerBootstrap {
  // Cut at the first ? or # so a query token never reaches the shell command.
  const cleaned = mcpUrl === null ? '' : (mcpUrl.trim().split(/[?#]/)[0] ?? '');
  const hubBase = cleaned === '' ? null : cleaned.replace(/\/+$/, '').replace(/\/mcp$/, '');
  const hub = hubBase ?? HOST_PLACEHOLDER;
  return {
    hubBase,
    unix: `curl -fsSL ${RUN_AGENT_RAW}/run-agent.sh | CORTEX_API_KEY=${apiKey} bash -s -- start --daemon --hub ${hub}`,
    windows: `$env:CORTEX_API_KEY="${apiKey}"; iwr -useb ${RUN_AGENT_RAW}/run-agent.ps1 -OutFile $env:TEMP\\run-agent.ps1; powershell -NoProfile -ExecutionPolicy Bypass -File $env:TEMP\\run-agent.ps1 start --daemon --hub ${hub}`,
  };
}
