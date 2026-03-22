import type { Env } from '../types.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { apiCall } from '../api-call.js'
import { fetchUnseenChanges, formatChangeSummary, acknowledgeChanges } from './changes.js'

/**
 * Register Session Tools
 *
 * cortex_session_start: Start a session and get project context.
 * Calls dashboard-api /api/sessions/start via apiCall (in-memory when co-located).
 */
export function registerSessionTools(server: McpServer, env: Env) {
  // End/complete a session
  server.tool(
    'cortex_session_end',
    'End/complete the current session. Call this when your conversation is finishing to avoid leaving stale sessions.',
    {
      sessionId: z.string().describe('The session ID returned by cortex_session_start'),
      summary: z.string().optional().describe('Brief summary of work done in this session'),
    },
    async ({ sessionId, summary }) => {
      try {
        const response = await apiCall(env, `/api/sessions/${sessionId}/complete`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: 'completed',
            task_summary: summary,
          }),
        })

        if (!response.ok) {
          const errorText = await response.text()
          return {
            content: [{ type: 'text' as const, text: `Session end failed: ${response.status} ${errorText}` }],
            isError: true,
          }
        }

        const result = await response.json()
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        }
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Session end error: ${error instanceof Error ? error.message : 'Unknown'}` }],
          isError: true,
        }
      }
    }
  )

  server.tool(
    'cortex_session_start',
    'Start a development session. Creates a session record and returns project context, recent quality logs, session history, and unseen code changes from other agents.',
    {
      repo: z.string().describe('The URL of the repository being worked on'),
      mode: z.string().optional().describe('Session mode: development, onboarding, review'),
      agentId: z.string().optional().describe('Your agent identifier for change tracking'),
    },
    async ({ repo, mode, agentId }) => {
      try {
        const response = await apiCall(env, '/api/sessions/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repo, mode, agentId }),
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

        // Inject recent changes if project was found
        const projectData = session.project as Record<string, unknown> | null
        if (projectData?.id && agentId) {
          const projectId = projectData.id as string
          const { events } = await fetchUnseenChanges(env, agentId, projectId)
          const changeSummary = formatChangeSummary(events)

          if (changeSummary) {
            session.recentChanges = {
              count: events.length,
              summary: changeSummary,
              warning: 'Code has changed since your last session. Run git pull before editing.',
              events: events.map((e) => ({
                agent: e.agent_id,
                branch: e.branch,
                commit: e.commit_sha?.slice(0, 7),
                message: e.commit_message,
                files: JSON.parse(e.files_changed || '[]'),
                time: e.created_at,
              })),
            }

            // Auto-acknowledge these changes
            const latestId = events[0]?.id
            if (latestId) {
              await acknowledgeChanges(env, agentId, projectId, latestId)
            }
          } else {
            session.recentChanges = { count: 0, summary: 'No unseen changes.' }
          }
        }

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
