import type { Executor } from '@cortex/shared-types';

/** How to install an engine's CLI; the agy installer differs on Windows. */
export function installHint(executor: Executor, platform: NodeJS.Platform = process.platform): string {
  switch (executor) {
    case 'agy':
      return platform === 'win32'
        ? 'the PowerShell installer from https://antigravity.google/docs/getting-started?tab=cli'
        : 'curl -fsSL https://antigravity.google/cli/install.sh | bash';
    case 'claude':
      return 'npm install -g @anthropic-ai/claude-code';
    case 'codex':
      return 'npm install -g @openai/codex';
    case 'gemini':
      return 'npm install -g @google/gemini-cli';
  }
}
