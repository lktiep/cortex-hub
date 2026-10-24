import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { EXECUTORS } from '@cortex/shared-types'
import type { Executor, TreeCreateResponse, WorkerView, SessionView } from '@cortex/shared-types'
import type { Env } from '../types.js'
import { apiCall } from '../api-call.js'
import { issueTreeUpload } from '../tree-upload.js'
import { PLAN_GUIDE } from './plan-guide.js'
import { checkPlan } from './plan-shape.js'

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

// z.enum needs a non-empty tuple; EXECUTORS is typed readonly Executor[] but is non-empty by definition.
export const executorEnum = z.enum(EXECUTORS as unknown as [Executor, ...Executor[]])
export const priorityField = z.union([z.enum(['critical', 'high', 'medium', 'low']), z.number().int().min(1).max(10)])
export const routeSpec = z.object({
  executor: executorEnum.nullable(),
  model: z.string().nullable().optional(),
  effort: z.string().nullable().optional(),
})

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] })
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true })

/** The API's `error` for a non-2xx answer (status text when the body is not JSON), plus the cycle when it sent one. */
async function errorText(res: Response, prefix = ''): Promise<string> {
  let message = res.statusText || `HTTP ${res.status}`
  let cycle: string[] | undefined
  try {
    const body = (await res.json()) as { error?: string; cycle?: string[] }
    if (body.error) message = body.error
    if (res.status === 400 && Array.isArray(body.cycle)) cycle = body.cycle
  } catch { /* not JSON: keep the status text */ }
  return `${prefix}${message}${cycle ? `\nCycle: ${cycle.join(' → ')}` : ''}`
}

async function post(env: Env, path: string, body: unknown): Promise<Response> {
  return apiCall(env, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  })
}

const treeTasks = z.array(z.object({
  key: z.string().describe('Unique key within this plan'),
  title: z.string(),
  description: z.string().optional(),
  kind: z.enum(['work', 'gate', 'group']).optional(),
  parentKey: z.string().optional().describe("Key of a task with kind 'group' in this same call"),
  dependsOn: z.array(z.string()).optional().describe('Keys of tasks that must finish first'),
  requiredCapabilities: z.array(z.string()).optional(),
  priority: priorityField.optional().describe('critical|high|medium|low or 1-10 (lower runs first)'),
  executor: executorEnum.optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  fallback: z.array(routeSpec).optional(),
  files: z.array(z.string()).optional().describe('Files the task will touch (used for locks)'),
  branch: z.string().optional(),
  pinnedAgent: z.string().optional(),
  reviewRequired: z.boolean().optional().describe('Defaults to true for work tasks'),
  approver: z.enum(['user', 'lead']).optional().describe('Who approves a gate task'),
  context: z.record(z.string(), z.unknown()).optional(),
})).min(1)

/** A whole plan: the arguments of cortex_task_tree_create, and what an uploaded plan file holds. */
export const treePlan = z.object({
  parentId: z.string().optional().describe('Existing task ID to hang the plan under'),
  projectId: z.string().optional().describe('Project the tasks belong to'),
  tasks: treeTasks.describe('Tasks of the plan'),
})
export type TreePlan = z.infer<typeof treePlan>

/** Create a plan. The text is what the agent reads, whether it called the tool or ran curl. */
export async function createPlan(env: Env, plan: TreePlan): Promise<{ ok: boolean; status: number; text: string }> {
  const { parentId, projectId, tasks } = plan
  const res = await post(env, '/api/conductor/tree', { parentId, projectId, tasks })
  if (!res.ok) return { ok: false, status: res.status, text: await errorText(res, 'Plan rejected: ') }
  const data = (await res.json()) as TreeCreateResponse
  const lines = [`**Plan created** — ${tasks.length} tasks, ${data.ready} ready now`]
  for (const t of tasks) lines.push(`- ${t.key} → ${data.ids[t.key]}`)
  // Created anyway: the lead can still reroute or replace a task, and sees why it should.
  const check = checkPlan(plan)
  if (check.problems > 0) lines.push('', check.text)
  return { ok: true, status: res.status, text: lines.join('\n') }
}

/** A one-time link for the plan file, and the command that sends it. */
function uploadInstructions(env: Env): string {
  const { token, expiresAt } = issueTreeUpload(env.API_KEY_OWNER)
  return [
    `**Upload link ready** — one plan, valid until ${new Date(expiresAt).toISOString()}`,
    '1. Write the whole plan to a JSON file: {"parentId"?, "projectId"?, "tasks": [...]}, with the same task fields as this tool.',
    '2. Run this, with your file in place of plan.json:',
    `curl -sS --fail-with-body -H "Content-Type: application/json" --data-binary "@plan.json" ${env.PUBLIC_ORIGIN ?? ''}/tree-upload/${token}`,
    'In Windows PowerShell call curl.exe, not curl.',
    'It answers like this tool: each key → id. A rejected file does not use up the link: fix the file and run the command again. A created plan does.',
  ].join('\n')
}

function workerLine(w: WorkerView): string {
  const parts = [
    `${w.agentId} @ ${w.hostname ?? '?'} (${w.os ?? '?'})`,
    w.status + (w.currentTaskId ? ` · on ${w.currentTaskId}` : ''),
    `engines: ${w.engines.map((e) => e.executor + (e.models.length ? `[${e.models.join(',')}]` : '')).join(', ')}`,
  ]
  // What a plan routes on: requiredCapabilities match these, and a scoped worker takes only its project's tasks.
  if (w.capabilities?.length) parts.push(`capabilities: ${w.capabilities.join(', ')}`)
  if (w.projectId) parts.push(`project: ${w.projectId}`)
  if (w.quota.length) parts.push(`quota: ${w.quota.map((q) => `${q.executor}/${q.model} until ${q.exhaustedUntil}`).join(' ')}`)
  return `- ${parts.join(' · ')}`
}

/** Lead tools: plan trees, worker inspection, review, routing and cancel. Each is one REST call. */
export function registerConductorLeadTools(server: McpServer, env: Env): void {
  server.tool(
    'cortex_task_tree_create',
    'Create a whole plan as a tree of tasks in one call. Before your first plan, call this with guide: true and follow the guide: it says how to cut the work, draw dependencies and route tasks to the machines cortex_agents lists. Check a plan with dryRun: true before creating it. Use this for multi-step plans instead of many cortex_task_create calls. Tasks reference each other by key (parentKey, dependsOn); the hub rejects cycles. Put the whole plan under ONE root task with kind group and set the key of that root as the parentKey of every top-level item, or the dashboard shows a flat plan as N one-task plans. Give `files` on work tasks so parallel tasks do not collide (lock safety). reviewRequired defaults to true for work tasks. For a big plan (more than about 15 tasks, or long descriptions) do not type it into this call or split it into batches: write it to a JSON file and call this with only upload: true. You get a one-time curl command that imports the whole file in one request.',
    {
      ...treePlan.shape,
      tasks: treeTasks.optional().describe('Tasks of the plan. Leave out with upload: true'),
      upload: z.boolean().optional().describe('Import the plan from a JSON file instead: returns a one-time curl command for the file'),
      guide: z.boolean().optional().describe('Return the planning guide instead of creating anything. Read it before your first plan'),
      dryRun: z.boolean().optional().describe("Check the plan's shape (chains, missing files, thin descriptions, files shared by parallel tasks) without creating it"),
    },
    async ({ parentId, projectId, tasks, upload, guide, dryRun }) => {
      if (guide) return ok(PLAN_GUIDE)
      if (upload) {
        if (tasks || parentId || projectId) return fail('With upload: true, put parentId, projectId and tasks in the file, not in this call.')
        return ok(uploadInstructions(env))
      }
      if (!tasks) return fail('Give tasks, or upload: true to import the plan from a JSON file, or guide: true for the planning guide.')
      if (dryRun) return ok(`${checkPlan({ parentId, tasks }).text}\nNothing was created.`)
      try {
        const created = await createPlan(env, { parentId, projectId, tasks })
        return created.ok ? ok(created.text) : fail(created.text)
      } catch (err) {
        return fail(`Plan creation failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  )

  server.tool(
    'cortex_agents',
    'List connected conductor workers (engines, models, busy/idle, exhausted quota) and live MCP sessions. Call this before choosing routes for tasks.',
    {},
    async () => {
      try {
        const res = await apiCall(env, '/api/conductor/agents', { signal: AbortSignal.timeout(15000) })
        if (!res.ok) return fail(await errorText(res))
        const data = (await res.json()) as { agents: WorkerView[]; online: number; sessions: SessionView[] }
        const lines = [`**Workers (${data.online} online)**`]
        if (data.agents.length) for (const w of data.agents) lines.push(workerLine(w))
        else lines.push('- none')
        lines.push('**MCP sessions**')
        if (data.sessions.length) {
          for (const s of data.sessions) lines.push(`- ${s.agentId} · ${s.ide ?? '?'} · ${s.branch ?? '?'} · ${s.lastActivity}`)
        } else lines.push('- none')
        return ok(lines.join('\n'))
      } catch (err) {
        return fail(`Agent listing failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  )

  server.tool(
    'cortex_task_review',
    'Approve or reject a task whose status is `review`, or decide a lead gate (kind `gate`, approver `lead`). User gates are dashboard-only and are refused with 403.',
    {
      taskId: z.string().describe('Task ID'),
      verdict: z.enum(['approve', 'reject']),
      feedback: z.string().optional().describe('Why; sent back to the worker on reject'),
    },
    async ({ taskId, verdict, feedback }) => {
      try {
        const res = await post(env, `/api/conductor/${encodeURIComponent(taskId)}/review`, { verdict, feedback })
        if (!res.ok) return fail(await errorText(res))
        const { task } = (await res.json()) as { task: { id: string; task_key: string | null; status: string } }
        return ok(`**Review recorded** — ${task.task_key ?? task.id} is now ${task.status}`)
      } catch (err) {
        return fail(`Review failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  )

  server.tool(
    'cortex_task_route',
    'Change how a task is routed: executor, model, effort, fallbacks, pinned agent, priority, files or dependencies. Use it to resolve an escalation (set clearEscalation) or to pick a fallback. Only the fields you pass change; null clears a field.',
    {
      taskId: z.string().describe('Task ID'),
      executor: executorEnum.nullable().optional(),
      model: z.string().nullable().optional(),
      effort: z.string().nullable().optional(),
      fallback: z.array(routeSpec).nullable().optional(),
      pinnedAgent: z.string().nullable().optional(),
      priority: priorityField.optional(),
      files: z.array(z.string()).optional(),
      dependsOn: z.array(z.string()).optional().describe('Stored task IDs (not plan keys); unknown IDs are rejected'),
      clearEscalation: z.boolean().optional(),
    },
    async ({ taskId, ...patch }) => {
      try {
        const body = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))
        const res = await post(env, `/api/conductor/${encodeURIComponent(taskId)}/route`, body)
        if (!res.ok) return fail(await errorText(res))
        const { task } = (await res.json()) as { task: { id: string; task_key: string | null; executor: string | null; model: string | null } }
        return ok(`**Route updated** — ${task.task_key ?? task.id}: ${task.executor ?? 'any'}/${task.model ?? 'default'}`)
      } catch (err) {
        return fail(`Route update failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  )

  server.tool(
    'cortex_task_cancel',
    'Cancel a task you give up on. Its dependents stay blocked until you reroute them. Cancelling a group cancels every unfinished task under it and stops the ones running; to stop a whole plan, cancel its root group.',
    {
      taskId: z.string().describe('Task ID'),
      reason: z.string().optional(),
    },
    async ({ taskId, reason }) => {
      try {
        const res = await post(env, `/api/conductor/${encodeURIComponent(taskId)}/cancel`, { reason })
        if (!res.ok) return fail(await errorText(res))
        return ok(`**Cancelled** — ${taskId}`)
      } catch (err) {
        return fail(`Cancel failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  )
}
