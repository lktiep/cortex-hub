import type { Env } from '../types.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

/**
 * Register Session Tools
 *
 * cortex_session_start: Start a session and get project context.
 * Calls dashboard-api /api/sessions/start which:
 *   - Creates a real session record in SQLite
 *   - Looks up project by git_repo_url
 *   - Returns project info, recent quality, recent sessions
 */
export function registerSessionTools(server: McpServer, env: Env) {
  server.tool(
    'cortex_session_start',
    'Start a development session. Creates a session record and returns project context, recent quality logs, and session history.',
    {
      repo: z.string().describe('The URL of the repository being worked on'),
      mode: z.string().optional().describe('Session mode: development, onboarding, review'),
    },
    async ({ repo, mode }) => {
      try {
        const apiUrl = env.DASHBOARD_API_URL || 'http://localhost:4000'
        const response = await fetch(`${apiUrl}/api/sessions/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repo, mode }),
          signal: AbortSignal.timeout(10000),
        })

        if (!response.ok) {
          const errorText = await response.text()
          return {
            content: [
              {
                type: 'text' as const,
                text: `Session start failed: ${response.status} ${errorText}`,
              },
            ],
            isError: true,
          }
        }

        const session = (await response.json()) as Record<string, unknown>

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(session, null, 2),
            },
          ],
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Session start error: ${error instanceof Error ? error.message : 'Unknown'}`,
            },
          ],
          isError: true,
        }
      }
    }
  )
}
