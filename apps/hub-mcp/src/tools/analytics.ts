import { z } from 'zod'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Env } from '../types.js'
import { apiCall } from '../api-call.js'

/**
 * Register analytics tools.
 * Exposes Cortex tool usage statistics to agents and team members.
 * This enables self-evaluation: "Is Cortex making me more effective?"
 */
export function registerAnalyticsTools(server: McpServer, env: Env) {
  const apiUrl = () => env.DASHBOARD_API_URL || 'http://localhost:4000'

  // ── cortex_tool_stats — view tool usage analytics ──
  server.tool(
    'cortex_tool_stats',
    'View Cortex MCP tool usage analytics: success rates, latency, token estimates, and trends. Use to measure Cortex effectiveness and identify flaky tools. Available to all team members.',
    {
      days: z.number().optional().describe('Time window in days (default: 7)'),
      agentId: z.string().optional().describe('Filter by agent ID'),
      projectId: z.string().optional().describe('Filter by project ID'),
    },
    async ({ days, agentId, projectId }) => {
      try {
        const params = new URLSearchParams()
        if (days) params.set('days', String(days))
        if (agentId) params.set('agentId', agentId)
        if (projectId) params.set('projectId', projectId)

        const response = await apiCall(env, `/api/metrics/tool-analytics?${params.toString()}`, {
          method: 'GET',
          signal: AbortSignal.timeout(10000),
        })

        if (!response.ok) {
          const errorText = await response.text()
          return {
            content: [{ type: 'text' as const, text: `Analytics error: ${response.status} ${errorText}` }],
            isError: true,
          }
        }

        const data = (await response.json()) as {
          summary: {
            totalCalls: number
            overallSuccessRate: number
            estimatedTokensSaved: number
            totalDataBytes: number
            activeAgents: number
          }
          tools: Array<{
            tool: string
            totalCalls: number
            successRate: number
            errorCount: number
            avgLatencyMs: number
          }>
          agents: Array<{ agentId: string; totalCalls: number; successRate: number }>
          trend: Array<{ day: string; calls: number; errors: number }>
        }

        // Format as readable markdown for agents
        const lines: string[] = []
        lines.push(`## Cortex Tool Analytics (last ${days ?? 7} days)\n`)
        lines.push(`**Total calls:** ${data.summary.totalCalls}`)
        lines.push(`**Success rate:** ${data.summary.overallSuccessRate}%`)
        lines.push(`**Active agents:** ${data.summary.activeAgents}`)
        lines.push(`**Estimated tokens saved:** ~${data.summary.estimatedTokensSaved.toLocaleString()}\n`)

        if (data.tools.length > 0) {
          lines.push(`### Per-Tool Breakdown\n`)
          lines.push(`| Tool | Calls | Success % | Errors | Avg Latency |`)
          lines.push(`|------|------:|----------:|-------:|------------:|`)
          for (const t of data.tools) {
            const flag = t.successRate < 90 ? '⚠️ ' : t.successRate === 100 ? '✅ ' : ''
            lines.push(`| ${flag}${t.tool} | ${t.totalCalls} | ${t.successRate}% | ${t.errorCount} | ${t.avgLatencyMs}ms |`)
          }
        }

        if (data.agents.length > 0) {
          lines.push(`\n### Per-Agent Breakdown\n`)
          for (const a of data.agents) {
            lines.push(`- **${a.agentId}**: ${a.totalCalls} calls (${a.successRate}% success)`)
          }
        }

        if (data.trend.length > 0) {
          lines.push(`\n### Daily Trend\n`)
          for (const t of data.trend) {
            const bar = '█'.repeat(Math.min(Math.ceil(t.calls / 5), 20))
            lines.push(`${t.day}: ${bar} ${t.calls} calls${t.errors > 0 ? ` (${t.errors} errors)` : ''}`)
          }
        }

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
        }
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: `Tool stats error: ${error instanceof Error ? error.message : 'Unknown'}`,
          }],
          isError: true,
        }
      }
    }
  )
}
