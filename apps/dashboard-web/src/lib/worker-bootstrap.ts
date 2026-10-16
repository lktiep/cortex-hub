export const RUN_AGENT_RAW = 'https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts';

const HOST_PLACEHOLDER = 'https://<your-mcp-host>';

export interface WorkerBootstrap {
  hubBase: string | null;
  unix: string;
  windows: string;
}

/** Build the one-line worker bootstrap commands from the hub's MCP URL. */
export function workerBootstrap(mcpUrl: string | null): WorkerBootstrap {
  const hubBase = mcpUrl === null ? null : mcpUrl.replace(/\/+$/, '').replace(/\/mcp$/, '');
  const hub = hubBase ?? HOST_PLACEHOLDER;
  return {
    hubBase,
    unix: `curl -fsSL ${RUN_AGENT_RAW}/run-agent.sh | CORTEX_API_KEY=<worker-api-key> bash -s -- start --daemon --hub ${hub}`,
    windows: `$env:CORTEX_API_KEY="<worker-api-key>"; iwr -useb ${RUN_AGENT_RAW}/run-agent.ps1 -OutFile $env:TEMP\\run-agent.ps1; & $env:TEMP\\run-agent.ps1 start --daemon --hub ${hub}`,
  };
}
