import type { Env } from '../types.js'
import { z } from 'zod'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { apiCall } from '../api-call.js'

/**
 * Register quality and session trackers.
 * Captures Agent Quality Gate scores and records task lifecycles directly to the Dashboard SQLite database.
 */
export function registerQualityTools(server: McpServer, env: Env) {
  // quality.report — upload AWF gate checks
  server.tool(
    'cortex_quality_report',
    'Report the results of a Quality Gate check (e.g. Forgewright Phase/Gate checks, test outputs, lint records)',
    {
      gate_name: z.string().describe('The name of the gate evaluated (e.g. "Gate 4")'),
      passed: z.boolean().describe('Whether the gate passed or failed'),
      score: z.number().optional().describe('Optional numerical score out of 100'),
      details: z.string().optional().describe('Markdown or technical log of the evaluation criteria'),
    },
    async ({ gate_name, passed, score, details }) => {
      try {
        const response = await apiCall(env, '/api/quality/report', {
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

        // Auto-track knowledge usage feedback (OpenSpace-inspired)
        // If knowledge was searched in this session, update completion/fallback counters
        try {
          const feedbackAction = passed ? 'completed' : 'fallback'
          await apiCall(env, '/api/knowledge/track-feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: feedbackAction, gate_name }),
            signal: AbortSignal.timeout(5000),
          })
        } catch {
          // Non-critical — don't fail quality report for feedback tracking
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

  // session.start is now registered in session.ts with enhanced identity fields
}
