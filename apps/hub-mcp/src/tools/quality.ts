import { z } from 'zod'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Env } from '../types.js'

/**
 * Register quality and session trackers.
 * Captures Agent Quality Gate scores and records task lifecycles directly to the Dashboard SQLite database.
 */
export function registerQualityTools(server: McpServer, env: Env) {
  // quality.report — upload AWF gate checks
  server.tool(
    'cortex.quality.report',
    'Report the results of a Quality Gate check (e.g. Forgewright Phase/Gate checks, test outputs, lint records)',
    {
      gate_name: z.string().describe('The name of the gate evaluated (e.g. "Gate 4")'),
      passed: z.boolean().describe('Whether the gate passed or failed'),
      score: z.number().optional().describe('Optional numerical score out of 100'),
      details: z.string().optional().describe('Markdown or technical log of the evaluation criteria'),
    },
    async ({ gate_name, passed, score, details }) => {
      try {
        const response = await fetch(`${env.DASHBOARD_API_URL}/api/quality/report`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ gate_name, passed, score, details }),
          signal: AbortSignal.timeout(10000),
        })

        if (!response.ok) {
          return {
            content: [{ type: 'text' as const, text: `Quality track failed: HTTP ${response.status}` }],
            isError: true,
          }
        }

        return {
          content: [{ type: 'text' as const, text: `Quality Report Logged: ${gate_name} (Passed: ${passed})` }],
        }
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Quality API network error: ${String(error)}` }],
          isError: true,
        }
      }
    }
  )

  // session.start — Start task context
  server.tool(
    'cortex.session.start',
    'Start a new execution session to track progress against product requirements.',
    {
      action: z.string().describe('The primary action (e.g., "Implement Provider Auth")'),
      project: z.string().optional().describe('The specific project being worked on'),
    },
    async ({ action, project }) => {
      try {
        const response = await fetch(`${env.DASHBOARD_API_URL}/api/sessions/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, project }),
          signal: AbortSignal.timeout(10000),
        })

        if (!response.ok) return { content: [{ type: 'text' as const, text: `Fail: ${response.status}` }], isError: true }
        
        const data = await response.json() as { sessionId: string }
        return { content: [{ type: 'text' as const, text: `Tracking session started. Session ID: ${data.sessionId}` }] }
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Network error: ${String(error)}` }], isError: true }
      }
    }
  )
}
