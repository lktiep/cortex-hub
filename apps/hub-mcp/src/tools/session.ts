import type { Env } from '../types.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { apiCall } from '../api-call.js'

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
      // Extract project name from repo URL for context
      const projectName = repo
        ? repo.replace(/\.git$/, '').replace(/\/$/, '').split('/').pop() ?? 'unknown'
        : 'unknown'

      // Register session with the dashboard API
      let sessionId = `sess_${Math.random().toString(36).substr(2, 9)}`
      let resolvedProjectId: string | undefined
      let recentSessions: unknown[] = []
      try {
        const response = await apiCall(env, '/api/sessions/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: `session_start:${mode ?? 'development'}`,
            repo,
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
          const data = await response.json() as { sessionId?: string; project?: { id: string }; recentSessions?: unknown[] }
          if (data.sessionId) sessionId = data.sessionId
          if (data.project?.id) resolvedProjectId = data.project.id
          if (data.recentSessions) recentSessions = data.recentSessions
        }
      } catch {
        // Dashboard API unavailable — continue with local session ID
      }

      // Build dynamic mission brief from knowledge base
      // Search for: recent session summaries, project context, active goals
      let missionBrief = `# ${projectName}\nMode: ${mode ?? 'development'}`
      let relevantKnowledge: Array<{ id: string; title: string; description: string; origin: string; quality: Record<string, number> }> = []
      try {
        const searchQuery = `session summary progress next session ${projectName}`
        const knowledgeRes = await apiCall(env, '/api/knowledge/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: searchQuery,
            projectId: resolvedProjectId,
            limit: 5
          }),
          signal: AbortSignal.timeout(5000),
        })
        if (knowledgeRes.ok) {
          const data = await knowledgeRes.json() as {
            results?: Array<{
              documentId?: string
              title?: string
              content?: string
              origin?: string
              quality?: Record<string, number>
              deprecated?: boolean
            }>
          }
          const results = (data.results ?? []).filter(r => r.documentId && !r.deprecated)

          // Build mission from top knowledge hit (most relevant session summary)
          if (results.length > 0) {
            const topHit = results[0]
            missionBrief = `# ${projectName}\n\n## Last Session Context\n${topHit?.title ?? ''}\n\n${(topHit?.content ?? '').slice(0, 500)}`
          }

          relevantKnowledge = results
            .slice(0, 3)
            .map(r => ({
              id: r.documentId!,
              title: r.title ?? '',
              description: (r.content ?? '').slice(0, 200),
              origin: r.origin ?? 'manual',
              quality: r.quality ?? {},
            }))
        }
      } catch {
        // Knowledge search unavailable — continue with basic mission
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              session_id: sessionId,
              mission_brief: missionBrief,
              status: 'active',
              identity: {
                agentId: agentId ?? 'claude-code',
                hostname: hostname ?? null,
                os: os ?? null,
                ide: ide ?? null,
                branch: branch ?? null,
                capabilities: capabilities ?? [],
                role: role ?? null,
              },
              project: resolvedProjectId ? { id: resolvedProjectId } : undefined,
              recent_sessions: recentSessions.length > 0 ? recentSessions : undefined,
              relevant_knowledge: relevantKnowledge.length > 0 ? relevantKnowledge : undefined,
            }, null, 2)
          }
        ]
      }
    }
  )

  server.tool(
    'cortex_session_end',
    'Close a session with a summary of work done. Reports session duration and compliance.',
    {
      sessionId: z.string().describe('The session ID from cortex_session_start'),
      summary: z.string().describe('Brief summary of work done in this session'),
    },
    async ({ sessionId, summary }) => {
      try {
        const response = await apiCall(env, `/api/sessions/${encodeURIComponent(sessionId)}/end`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ summary }),
          signal: AbortSignal.timeout(10000),
        })

        if (response.ok) {
          const data = await response.json() as { session?: { id: string; status: string; duration?: number } }
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                status: 'closed',
                sessionId,
                summary,
                session: data.session ?? null,
              }, null, 2),
            }],
          }
        }

        // Fallback: mark session completed directly if endpoint doesn't exist
        try {
          await apiCall(env, '/api/sessions/handoff', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sessionId,
              action: 'session_end',
              status: 'completed',
              summary,
            }),
            signal: AbortSignal.timeout(5000),
          })
        } catch { /* ignore */ }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ status: 'closed', sessionId, summary }, null, 2),
          }],
        }
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: `Session end error: ${error instanceof Error ? error.message : 'Unknown'}`,
          }],
          isError: true,
        }
      }
    }
  )
}
