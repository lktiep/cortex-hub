import type { Env } from '../types.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { apiCall } from '../api-call.js'
import { LOAD_UP_FRONT } from './load-up-front.js'
import { taskBrief } from './task-recall.js'

// The docs indexer files each document as "[<path>] <title>". The IDE has already put these
// instruction files in the agent's context, and the session-summary query ranks them first:
// the brief and the knowledge list were the project's CLAUDE.md twice, ~2.4k of 3.4k characters.
const IN_CONTEXT = /^\[(?:.*\/)?(?:CLAUDE|AGENTS|GEMINI)\.md\]/i

export function alreadyInContext(title: string | undefined): boolean {
  return IN_CONTEXT.test(title ?? '')
}

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
    'Start the session. Pass `task` once you know it: the answer then also holds what the hub recalls for the task and the files, lines and symbols to read, in place of separate knowledge, memory and code searches.',
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
      task: z.string().max(300).optional().describe(
        'What you are about to do, in a few words (the feature, the error). The answer then holds what the hub recalls for it and the files and lines to read: no separate knowledge, memory or code search to run.'
      ),
      clientSessionId: z.string().max(128).optional().describe(
        'This conversation\'s id, as the IDE\'s SessionStart hook printed it (Claude Code\'s hook fills it in). Keeps two conversations in one checkout on separate sessions.'
      ),
    },
    async ({ repo, mode, agentId, hostname, os, ide, branch, capabilities, role, task, clientSessionId }) => {
      // Extract project name from repo URL for context
      const projectName = repo
        ? repo.replace(/\.git$/, '').replace(/\/$/, '').split('/').pop() ?? 'unknown'
        : 'unknown'

      // Register session with the dashboard API
      let sessionId = `sess_${Math.random().toString(36).substr(2, 9)}`
      let resolvedProjectId: string | undefined
      let resolvedOrgId: string | undefined
      let recentSessions: unknown[] = []
      // The hub registers a repo of a saved git account on first sight; the agent should say so.
      let autoRegistered: unknown
      let projectNote: string | undefined
      // Set when the hub did not record the session: the id above is then local only.
      let hubError: string | undefined
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
            clientSessionId,
          }),
          signal: AbortSignal.timeout(10000),
        })

        if (response.ok) {
          const data = await response.json() as {
            sessionId?: string
            project?: { id: string; orgId?: string }
            recentSessions?: unknown[]
            autoRegistered?: unknown
            projectNote?: string
          }
          if (data.sessionId) sessionId = data.sessionId
          if (data.project?.id) resolvedProjectId = data.project.id
          if (data.project?.orgId) resolvedOrgId = data.project.orgId
          if (data.recentSessions) recentSessions = data.recentSessions
          autoRegistered = data.autoRegistered
          projectNote = data.projectNote
        } else {
          const data = await response.json().catch(() => null) as { error?: unknown } | null
          hubError = `The hub refused the session (HTTP ${response.status}): ${typeof data?.error === 'string' ? data.error : response.statusText}`
        }
      } catch (err) {
        // Dashboard API unavailable — continue with local session ID
        hubError = `The hub did not answer the session start: ${err instanceof Error ? err.message : String(err)}`
      }

      // Build dynamic mission brief from knowledge base
      // Search for: recent session summaries, project context, active goals
      let missionBrief = `# ${projectName}\nMode: ${mode ?? 'development'}`
      let relevantKnowledge: Array<{ id: string; title: string; description: string; origin: string; quality: Record<string, number> }> = []
      // With the task in hand the brief below is replaced by recall on the task itself: the
      // generic query ranked indexed docs first, a workflow template more often than a summary.
      if (!task) try {
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
          const seen = new Set<string>()
          const results = (data.results ?? []).filter((r) => {
            if (!r.documentId || r.deprecated || alreadyInContext(r.title)) return false
            // A document indexed in several chunks comes back once per chunk.
            if (seen.has(r.documentId)) return false
            seen.add(r.documentId)
            return true
          })

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

      const brief = task?.trim()
        ? await taskBrief(env, {
            task: task.trim(), project: projectName, projectId: resolvedProjectId,
            agentId: agentId ?? 'claude-code', branch, alreadyInContext,
          })
        : ''

      if (task?.trim()) {
        // The agent wrote every identity field itself a moment ago; only what the hub decided goes back.
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                session_id: sessionId,
                status: 'active',
                project: resolvedProjectId ? { id: resolvedProjectId, orgId: resolvedOrgId } : undefined,
                auto_registered: autoRegistered,
                project_note: projectNote,
                hub_error: hubError,
              }),
            },
            ...(brief ? [{ type: 'text' as const, text: brief }] : []),
          ],
        }
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
                clientSessionId: clientSessionId ?? null,
              },
              // orgId is the boundary of a cross-repo search: code tools called without
              // `repo:` search every repo in this organization and nothing outside it.
              project: resolvedProjectId ? { id: resolvedProjectId, orgId: resolvedOrgId } : undefined,
              auto_registered: autoRegistered,
              project_note: projectNote,
              hub_error: hubError,
              recent_sessions: recentSessions.length > 0 ? recentSessions : undefined,
              relevant_knowledge: relevantKnowledge.length > 0 ? relevantKnowledge : undefined,
            })
          }
        ]
      }
    }
  ).update(LOAD_UP_FRONT)

  server.tool(
    'cortex_session_end',
    'Close a session with a summary of work done. Reports session duration and compliance.',
    {
      sessionId: z.string().describe('The session ID from cortex_session_start'),
      summary: z.string().describe('Brief summary of work done in this session'),
      auto: z.boolean().optional().describe(
        'Set only by the client exit hook: closes an active session as abandoned and keeps its summary out of memory. Agents leave this unset.'
      ),
    },
    async ({ sessionId, summary, auto }) => {
      try {
        const response = await apiCall(env, `/api/sessions/${encodeURIComponent(sessionId)}/end`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(auto ? { summary, auto: true } : { summary }),
          signal: AbortSignal.timeout(10000),
        })

        // The exit hook marks the session closed on any successful answer, so an automatic
        // close gets the truth, not the best-effort fallback below that reports "closed" anyway.
        if (auto && !response.ok) {
          return {
            content: [{ type: 'text' as const, text: `Session end failed: HTTP ${response.status}` }],
            isError: true,
          }
        }

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
