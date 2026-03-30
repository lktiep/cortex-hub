import type { Env } from '../types.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

/**
 * Register Session Tools
 *
 * cortex_session_start: Mandatory tool to begin a session.
 * Returns the project mission brief and quality standards.
 * Enhanced with Conductor Phase 1v2 identity fields.
 */
export function registerSessionTools(server: McpServer, env: Env) {
  server.tool(
    'cortex_session_start',
    'Start a new execution session with optional agent identity metadata.',
    {
      repo: z.string().describe('The URL of the repository being worked on'),
      mode: z.string().optional().describe('Session mode: development, onboarding, review'),
      agentId: z.string().optional().describe('Agent identifier (e.g. claude-code)'),
      hostname: z.string().optional().describe('Machine hostname'),
      os: z.string().optional().describe('Operating system (macOS/Windows/Linux)'),
      ide: z.string().optional().describe('IDE type (claude-code-cli/claude-code-vscode/antigravity/cursor/windsurf/codex)'),
      branch: z.string().optional().describe('Current git branch'),
      capabilities: z.array(z.string()).optional().describe('Agent capabilities'),
      role: z.string().optional().describe('Agent role from agent-identity.json'),
    },
    async ({ repo, mode, agentId, hostname, os, ide, branch, capabilities, role }) => {
      const missionBrief = `
# Mission Brief: Cortex Hub (Phase 6)
Current Goal: Polish, GA Release, and Quality Enforcement.

## Mandatory Standards:
- SOLID Principles: Applied to all shared packages.
- Clean Architecture: Decoupled services (hub-mcp, dashboard-api).
- Quality Gates: pnpm build, typecheck, and lint MUST pass before commit.

## Active Task:
Resuming current objective from STATE.md.
      `.trim()

      // Register session with the dashboard API
      let sessionId = `sess_${Math.random().toString(36).substr(2, 9)}`
      try {
        const response = await fetch(`${env.DASHBOARD_API_URL}/api/sessions/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: `session_start:${mode ?? 'development'}`,
            project: repo,
            agentId: agentId ?? 'claude-code',
            hostname,
            os,
            ide,
            branch,
            capabilities,
            role,
          }),
          signal: AbortSignal.timeout(10000),
        })

        if (response.ok) {
          const data = await response.json() as { sessionId?: string }
          if (data.sessionId) sessionId = data.sessionId
        }
      } catch {
        // Dashboard API unavailable — continue with local session ID
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              session_id: sessionId,
              mission_brief: missionBrief,
              status: 'active',
              standards: ['SOLID', 'Clean Architecture', 'Phase Gate Enforcement'],
              identity: {
                agentId: agentId ?? 'claude-code',
                hostname: hostname ?? null,
                os: os ?? null,
                ide: ide ?? null,
                branch: branch ?? null,
                capabilities: capabilities ?? [],
                role: role ?? null,
              },
            }, null, 2)
          }
        ]
      }
    }
  )
}
