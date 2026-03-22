import { z } from 'zod'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Env } from '../types.js'
import { apiCall } from '../api-call.js'

interface ChangeEvent {
  id: string
  project_id: string
  branch: string
  agent_id: string
  commit_sha: string
  commit_message: string
  files_changed: string
  created_at: string
}

/**
 * Fetch unseen changes for an agent from dashboard-api.
 * Shared helper used by the cortex_changes tool and piggyback injection.
 */
export async function fetchUnseenChanges(
  env: Env,
  agentId: string,
  projectId: string
): Promise<{ events: ChangeEvent[]; count: number }> {
  try {
    const response = await apiCall(
      env,
      `/api/webhooks/changes?agentId=${encodeURIComponent(agentId)}&projectId=${encodeURIComponent(projectId)}`
    )
    if (!response.ok) return { events: [], count: 0 }
    return (await response.json()) as { events: ChangeEvent[]; count: number }
  } catch {
    return { events: [], count: 0 }
  }
}

/**
 * Acknowledge that an agent has seen changes up to a given event ID.
 */
export async function acknowledgeChanges(
  env: Env,
  agentId: string,
  projectId: string,
  lastSeenEventId: string
): Promise<void> {
  try {
    await apiCall(env, '/api/webhooks/changes/ack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, projectId, lastSeenEventId }),
    })
  } catch {
    // Non-critical — don't fail the tool call
  }
}

/**
 * Format change events into a human-readable summary for injection into tool responses.
 */
export function formatChangeSummary(events: ChangeEvent[]): string | null {
  if (events.length === 0) return null

  const allFiles = new Set<string>()
  const summaryLines: string[] = []

  for (const event of events) {
    const files = JSON.parse(event.files_changed || '[]') as string[]
    files.forEach((f) => allFiles.add(f))
    summaryLines.push(
      `- ${event.agent_id}: "${event.commit_message}" (${files.length} files, ${event.created_at})`
    )
  }

  return [
    `${events.length} change(s) by other agents since your last check:`,
    ...summaryLines,
    '',
    `Affected files: ${[...allFiles].join(', ')}`,
    'Action: Run `git pull` before editing these files to avoid conflicts.',
  ].join('\n')
}

/**
 * Register change awareness tools.
 */
export function registerChangeTools(server: McpServer, env: Env) {
  server.tool(
    'cortex_changes',
    'Check for recent code changes pushed by other agents/team members. Returns unseen commits and affected files. Call this before starting work on shared branches to avoid conflicts.',
    {
      agentId: z.string().describe('Your agent identifier'),
      projectId: z.string().describe('Project ID to check changes for'),
      acknowledge: z
        .boolean()
        .optional()
        .default(true)
        .describe('Mark these changes as seen to avoid repeat noise (default: true)'),
    },
    async ({ agentId, projectId, acknowledge }) => {
      try {
        const { events, count } = await fetchUnseenChanges(env, agentId, projectId)

        // Auto-acknowledge (default: true) to reduce repeat noise
        if (acknowledge !== false && events.length > 0) {
          const latestId = (events as ChangeEvent[])[0]?.id
          if (latestId) {
            await acknowledgeChanges(env, agentId, projectId, latestId)
          }
        }

        const summary = formatChangeSummary(events as ChangeEvent[])

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  hasChanges: count > 0,
                  count,
                  summary: summary ?? 'No unseen changes.',
                  events: (events as ChangeEvent[]).map((e) => ({
                    id: e.id,
                    agent: e.agent_id,
                    branch: e.branch,
                    commit: e.commit_sha?.slice(0, 7),
                    message: e.commit_message,
                    files: JSON.parse(e.files_changed || '[]'),
                    time: e.created_at,
                  })),
                },
                null,
                2
              ),
            },
          ],
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Changes check error: ${error instanceof Error ? error.message : 'Unknown'}`,
            },
          ],
          isError: true,
        }
      }
    }
  )
}
