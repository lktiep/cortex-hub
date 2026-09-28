import type { Env } from '../types.js'
import { z } from 'zod'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { formatPlanScorecard } from '@cortex/shared-types'
import type { PlanQualityResult } from '@cortex/shared-types'
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

  // plan.quality — score a plan before executing it (heuristic, no LLM call)
  server.tool(
    'cortex_plan_quality',
    'Score an implementation plan against 8 criteria (completeness, specificity, feasibility, risk awareness, ' +
      'scope, ordering, testability, impact) before executing it. Returns a 0-10 scorecard; 8.0 or more passes. ' +
      'Refine and resubmit with iteration+1 when it does not — at most 3 iterations.',
    {
      plan: z.string().min(1).describe('The plan: numbered steps, the files each touches, how it will be verified'),
      request: z.string().optional().describe('The original request the plan answers; used to judge completeness and scope'),
      iteration: z.number().int().min(1).max(3).optional().describe('Which attempt this is (1-3, default 1)'),
      threshold: z.number().min(0).max(10).optional().describe('Passing score out of 10 (default 8.0)'),
      plan_type: z
        .enum(['feature', 'bugfix', 'refactor', 'architecture', 'migration', 'general'])
        .optional()
        .describe('What kind of change the plan is for'),
    },
    async ({ plan, request, iteration, threshold, plan_type }) => {
      try {
        const response = await apiCall(env, '/api/quality/plan-quality', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan, request, iteration, threshold, planType: plan_type }),
          signal: AbortSignal.timeout(10000),
        })

        if (!response.ok) {
          return {
            content: [{ type: 'text' as const, text: `Plan quality failed: HTTP ${response.status} ${await response.text()}` }],
            isError: true,
          }
        }

        const { result } = (await response.json()) as { result: PlanQualityResult }
        const verdict = result.passed
          ? 'Plan APPROVED. Proceed with implementation.'
          : result.canRetry
            ? `Refine the plan and call again with iteration: ${result.iteration + 1}.`
            : 'Out of iterations. Escalate to the user with the improvements above.'
        return {
          content: [{ type: 'text' as const, text: `${formatPlanScorecard(result)}\n\n${verdict}` }],
        }
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Plan quality network error: ${String(error)}` }],
          isError: true,
        }
      }
    }
  )

  // session.start is now registered in session.ts with enhanced identity fields
}
