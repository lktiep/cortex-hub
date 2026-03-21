import type { Env } from '../types.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

/**
 * Register Session Tools
 * 
 * cortex.session.start: Mandatory tool to begin a session.
 * Returns the project mission brief and quality standards.
 */
export function registerSessionTools(server: McpServer, env: Env) {
  server.tool(
    'cortex.session.start',
    {
      repo: z.string().describe('The URL of the repository being worked on'),
      mode: z.string().optional().describe('Session mode: development, onboarding, review'),
    },
    async ({ repo, mode }) => {
      // In a real implementation, we would look up project-specific standards here.
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

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              session_id: `sess_${Math.random().toString(36).substr(2, 9)}`,
              mission_brief: missionBrief,
              status: 'active',
              standards: ['SOLID', 'Clean Architecture', 'Phase Gate Enforcement']
            }, null, 2)
          }
        ]
      }
    }
  )
}
