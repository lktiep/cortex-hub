import { z } from 'zod'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Env } from '../types.js'
import { apiCall } from '../api-call.js'
import {
  calculateFromVerificationResults,
  gradeAction,
  assessPlanQuality,
  formatPlanScorecard,
  type VerificationResults,
} from '@cortex/shared-types'

const verificationResultsSchema = z.object({
  buildPassed: z.boolean(),
  typecheckPassed: z.boolean(),
  lintPassed: z.boolean(),
  testsPassed: z.boolean().optional(),
  testsBaseline: z.number().optional(),
  testsCurrent: z.number().optional(),
  isGreenfield: z.boolean().optional(),
  stubsFound: z.number().optional(),
  secretsFound: z.number().optional(),
  lintErrorCount: z.number().optional(),
  lintWarningCount: z.number().optional(),
  requirementsMapped: z.number().optional(),
  requirementsTotal: z.number().optional(),
  hasTests: z.boolean().optional(),
  hasDocs: z.boolean().optional(),
})

/**
 * Register quality reporting tools.
 * Supports both legacy (simple pass/fail) and new (4-dimension scoring) formats.
 */
export function registerQualityTools(server: McpServer, env: Env) {
  server.tool(
    'cortex_quality_report',
    'Report Quality Gate results with 4-dimension scoring: Build (25) + Regression (25) + Standards (25) + Traceability (25) = 100. Provide `results` for auto-scoring, or `score`/`passed` for legacy mode.',
    {
      gate_name: z.string().describe('Gate name (e.g. "Gate 4", "pre-push", "CI")'),
      agent_id: z.string().optional().describe('Agent identifier (defaults to "unknown")'),
      session_id: z.string().optional().describe('Current session ID'),
      project_id: z.string().optional().describe('Project ID'),
      // New format: provide raw results for auto-scoring
      results: verificationResultsSchema.optional().describe('Raw verification results — scores are calculated automatically'),
      // Legacy format: provide pre-computed values
      passed: z.boolean().optional().describe('Legacy: whether the gate passed'),
      score: z.number().optional().describe('Legacy: pre-computed score (0-100)'),
      details: z.string().optional().describe('Markdown log of evaluation'),
    },
    async ({ gate_name, agent_id, session_id, project_id, results, passed, score, details }) => {
      try {
        // If results provided, calculate scorecard locally for the response
        let scorecard: string | null = null
        if (results) {
          const calc = calculateFromVerificationResults(results as VerificationResults)
          scorecard = [
            `Quality Report: ${gate_name}`,
            '─'.repeat(50),
            `  Build:        ${calc.dimensions.build.toString().padStart(2)}/25  ${calc.dimensions.build === 25 ? 'PASS' : 'FAIL'}`,
            `  Regression:   ${calc.dimensions.regression.toString().padStart(2)}/25  ${calc.dimensions.regression === 25 ? 'PASS' : 'FAIL'}`,
            `  Standards:    ${calc.dimensions.standards.toString().padStart(2)}/25  ${calc.dimensions.standards === 0 ? 'FAIL' : calc.dimensions.standards < 25 ? 'WARN' : 'PASS'}`,
            `  Traceability: ${calc.dimensions.traceability.toString().padStart(2)}/25  ${calc.dimensions.traceability === 0 ? 'FAIL' : calc.dimensions.traceability < 25 ? 'WARN' : 'PASS'}`,
            '─'.repeat(50),
            `  Total: ${calc.total}/100  Grade: ${calc.grade}  ${calc.passed ? 'PASSED' : 'FAILED'}`,
            `  Action: ${gradeAction(calc.grade)}`,
          ].join('\n')
        }

        const response = await apiCall(env, '/api/quality/report', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            gate_name,
            // Server-resolved identity (from API key) takes precedence over self-reported
            agent_id: env.API_KEY_OWNER || agent_id || 'unknown',
            session_id,
            project_id,
            results,
            passed,
            score,
            details,
          }),
        })

        if (!response.ok) {
          return {
            content: [{ type: 'text' as const, text: `Quality report failed: HTTP ${response.status}` }],
            isError: true,
          }
        }

        const data = await response.json() as { report?: { score_total: number; grade: string; passed: boolean } }

        // Build response text
        const reportInfo = data.report
          ? `Score: ${data.report.score_total}/100 | Grade: ${data.report.grade} | ${data.report.passed ? 'PASSED' : 'FAILED'}`
          : `Gate: ${gate_name}`

        const text = scorecard
          ? `${scorecard}\n\nReport saved. ${reportInfo}`
          : `Quality Report Logged: ${gate_name}\n${reportInfo}`

        return {
          content: [{ type: 'text' as const, text }],
        }
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Quality API error: ${String(error)}` }],
          isError: true,
        }
      }
    }
  )

  // ── Plan Quality Assessment ──
  server.tool(
    'cortex_plan_quality',
    'Assess plan quality against 8 criteria before execution. Score >= 8.0/10 to proceed. Max 3 iterations. Use BEFORE implementing a complex plan.',
    {
      plan: z.string().describe('The implementation plan to assess'),
      request: z.string().describe('The original user request this plan addresses'),
      iteration: z.number().optional().describe('Iteration number (1-3, default 1)'),
      threshold: z.number().optional().describe('Minimum score to pass (default 8.0)'),
      plan_type: z.enum(['feature', 'bugfix', 'refactor', 'architecture', 'migration', 'general']).optional(),
    },
    async ({ plan, request, iteration, threshold, plan_type }) => {
      try {
        const result = assessPlanQuality({
          plan,
          request,
          iteration: iteration ?? 1,
          threshold: threshold ?? 8.0,
          planType: plan_type ?? 'general',
        })

        const scorecard = formatPlanScorecard(result)
        const statusLine = result.passed
          ? 'Plan APPROVED. Proceed with implementation.'
          : result.canRetry
            ? `Plan needs improvement. Revise and re-submit (${result.maxIterations - result.iteration} retries remaining).`
            : 'Plan failed after max iterations. Escalate to user for guidance.'

        return {
          content: [{
            type: 'text' as const,
            text: `${scorecard}\n\n${statusLine}`,
          }],
        }
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Plan quality error: ${String(error)}` }],
          isError: true,
        }
      }
    }
  )
}
