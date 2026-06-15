import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Env } from '../types.js'
import { apiCall } from '../api-call.js'

/**
 * Register Cortex Conductor task management tools.
 * All tools use the /api/conductor endpoints (orchestration-aware).
 */
export function registerTaskTools(server: McpServer, env: Env) {
  // task.create — create a new task and optionally assign to another agent
  server.tool(
    'cortex_task_create',
    'Create a task and optionally assign it to another agent. Use for delegating work, tracking sub-tasks, or creating follow-ups.',
    {
      title: z.string().describe('Short title describing the task'),
      description: z.string().optional().describe('Detailed description of what needs to be done'),
      assignTo: z.string().optional().describe('Agent ID to assign the task to'),
      priority: z.string().optional().describe('Priority level: low, medium, high, critical'),
      requiredCapabilities: z.array(z.string()).optional().describe('Capabilities required to complete this task'),
      dependsOn: z.array(z.string()).optional().describe('Task IDs that must complete before this task can start'),
      notifyOnComplete: z.array(z.string()).optional().describe('Agent IDs to notify when this task completes'),
      context: z.record(z.string(), z.unknown()).optional().describe('Arbitrary context object to pass to the assigned agent'),
      parentTaskId: z.string().optional().describe('Parent task ID if this is a sub-task'),
    },
    async ({ title, description, assignTo, priority, requiredCapabilities, dependsOn, notifyOnComplete, context, parentTaskId }) => {
      try {
        const response = await apiCall(env, '/api/conductor', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title,
            description,
            assignedTo: assignTo,
            priority,
            requiredCapabilities,
            dependsOn,
            notifyOnComplete,
            metadata: context,
            parentTaskId,
          }),
          signal: AbortSignal.timeout(10000),
        })

        if (!response.ok) {
          const errorText = await response.text()
          return {
            content: [{ type: 'text' as const, text: `Task creation failed: ${response.status} ${errorText}` }],
            isError: true,
          }
        }

        const data = (await response.json()) as {
          task: { id: string; title: string; status: string; assigned_to_agent?: string; priority?: number }
        }
        const task = data.task

        const lines = [
          `**Task Created**`,
          `- **ID:** ${task.id}`,
          `- **Title:** ${task.title}`,
          `- **Status:** ${task.status}`,
        ]
        if (task.assigned_to_agent) lines.push(`- **Assigned To:** ${task.assigned_to_agent}`)
        if (task.priority) lines.push(`- **Priority:** ${task.priority}`)

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Task create error: ${error instanceof Error ? error.message : 'Unknown'}` }],
          isError: true,
        }
      }
    }
  )

  // task.pickup — get tasks assigned to the calling agent
  server.tool(
    'cortex_task_pickup',
    'Retrieve tasks assigned to you. Automatically checks both your agentId and API key name.',
    {
      agentId: z.string().optional().describe('Agent ID (auto-detected if not provided)'),
    },
    async ({ agentId }) => {
      try {
        const effectiveAgentId = agentId || env.API_KEY_OWNER
        const response = await apiCall(env, '/api/conductor/pickup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: effectiveAgentId,
            apiKeyOwner: env.API_KEY_OWNER,
          }),
          signal: AbortSignal.timeout(10000),
        })

        if (!response.ok) {
          const errorText = await response.text()
          return {
            content: [{ type: 'text' as const, text: `Task pickup failed: ${response.status} ${errorText}` }],
            isError: true,
          }
        }

        const data = (await response.json()) as { task?: { id: string; title: string; status: string; priority?: number; description?: string } | null }

        if (!data.task) {
          const displayAgentId = effectiveAgentId || 'unknown'
          return { content: [{ type: 'text' as const, text: `No pending tasks for agent **${displayAgentId}**.` }] }
        }

        const task = data.task
        const lines = [
          `**Task Picked Up**`,
          `### ${task.title}`,
          `- **ID:** ${task.id}`,
          `- **Status:** ${task.status}`,
        ]
        if (task.priority) lines.push(`- **Priority:** ${task.priority}`)
        if (task.description) lines.push(`- **Description:** ${task.description}`)

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Task pickup error: ${error instanceof Error ? error.message : 'Unknown'}` }],
          isError: true,
        }
      }
    }
  )

  // task.accept — accept an assigned task
  server.tool(
    'cortex_task_accept',
    'Accept an assigned task, signaling that work will begin. Updates task status to accepted.',
    {
      taskId: z.string().describe('The ID of the task to accept'),
    },
    async ({ taskId }) => {
      try {
        const response = await apiCall(env, `/api/conductor/${encodeURIComponent(taskId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: 'accepted',
          }),
          signal: AbortSignal.timeout(10000),
        })

        if (!response.ok) {
          const errorText = await response.text()
          return {
            content: [{ type: 'text' as const, text: `Task accept failed: ${response.status} ${errorText}` }],
            isError: true,
          }
        }

        const data = (await response.json()) as { task: { id: string; title: string; status: string } }
        return {
          content: [{ type: 'text' as const, text: `**Task Accepted**\n- **ID:** ${data.task.id}\n- **Title:** ${data.task.title}\n- **Status:** ${data.task.status}` }],
        }
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Task accept error: ${error instanceof Error ? error.message : 'Unknown'}` }],
          isError: true,
        }
      }
    }
  )

  // task.update — update task status and add progress messages
  server.tool(
    'cortex_task_update',
    'Update the status of a task. Use to transition tasks through their lifecycle: in_progress, review, completed, or failed. Can also re-parent orphan tasks.',
    {
      taskId: z.string().describe('The ID of the task to update'),
      status: z.enum(['in_progress', 'review', 'completed', 'failed']).describe('The new status for the task'),
      message: z.string().optional().describe('Progress message or note about the status change'),
      result: z.record(z.string(), z.unknown()).optional().describe('Result data when completing or failing a task'),
      parentTaskId: z.string().optional().describe('Set or change the parent task ID (for re-parenting orphan tasks)'),
    },
    async ({ taskId, status, message, result, parentTaskId }) => {
      try {
        const response = await apiCall(env, `/api/conductor/${encodeURIComponent(taskId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status, message, result, parentTaskId }),
          signal: AbortSignal.timeout(10000),
        })

        if (!response.ok) {
          const errorText = await response.text()
          return {
            content: [{ type: 'text' as const, text: `Task update failed: ${response.status} ${errorText}` }],
            isError: true,
          }
        }

        const data = (await response.json()) as { task: { id: string; title: string; status: string } }
        return {
          content: [{ type: 'text' as const, text: `**Task Updated**\n- **ID:** ${data.task.id}\n- **Title:** ${data.task.title}\n- **Status:** ${data.task.status}` }],
        }
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Task update error: ${error instanceof Error ? error.message : 'Unknown'}` }],
          isError: true,
        }
      }
    }
  )

  // task.list — query tasks with optional filters
  server.tool(
    'cortex_task_list',
    'List tasks with optional filters for project, status, and assignee. Use to get an overview of task state.',
    {
      projectId: z.string().optional().describe('Filter by project ID'),
      status: z.string().optional().describe('Filter by status (e.g. assigned, in_progress, completed)'),
      assignedTo: z.string().optional().describe('Filter by assigned agent ID'),
      limit: z.number().optional().describe('Maximum number of tasks to return (default: 20)'),
    },
    async ({ projectId, status, assignedTo, limit }) => {
      try {
        const params = new URLSearchParams()
        if (projectId) params.set('projectId', projectId)
        if (status) params.set('status', status)
        if (assignedTo) params.set('assignedTo', assignedTo)
        if (limit) params.set('limit', String(limit))

        const url = `/api/conductor?${params.toString()}`
        const response = await apiCall(env, url, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(10000),
        })

        if (!response.ok) {
          const errorText = await response.text()
          return {
            content: [{ type: 'text' as const, text: `Task list failed: ${response.status} ${errorText}` }],
            isError: true,
          }
        }

        const data = (await response.json()) as { tasks?: Array<{ id: string; title: string; status: string; assigned_to_agent?: string; priority?: number; created_at?: string }> }
        const tasks = data.tasks ?? []

        if (tasks.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No tasks found matching the given filters.' }] }
        }

        const lines = [`**Tasks** (${tasks.length} found):\n`]
        for (const task of tasks) {
          const parts = [`| ${task.id} | ${task.title} | ${task.status}`]
          if (task.assigned_to_agent) parts.push(` | ${task.assigned_to_agent}`)
          if (task.priority) parts.push(` | ${task.priority}`)
          lines.push(parts.join(''))
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Task list error: ${error instanceof Error ? error.message : 'Unknown'}` }],
          isError: true,
        }
      }
    }
  )

  // task.status — get detailed status of a single task
  server.tool(
    'cortex_task_status',
    'Get the detailed status of a specific task including its logs and history.',
    {
      taskId: z.string().describe('The ID of the task to inspect'),
    },
    async ({ taskId }) => {
      try {
        const response = await apiCall(env, `/api/conductor/${encodeURIComponent(taskId)}`, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(10000),
        })

        if (!response.ok) {
          const errorText = await response.text()
          return {
            content: [{ type: 'text' as const, text: `Task status failed: ${response.status} ${errorText}` }],
            isError: true,
          }
        }

        // Response shape: { task: {...}, subtasks?: [...], logs?: [...] }
        const data = (await response.json()) as {
          task: {
            id: string; title: string; status: string; description?: string
            assigned_to_agent?: string; priority?: number; created_at?: string
            accepted_at?: string; completed_at?: string; parent_task_id?: string
            depends_on?: string; context?: string; result?: string
          }
          subtasks?: Array<{ id: string; title: string; status: string; assigned_to_agent?: string }>
          logs?: Array<{ action: string; agent_id: string; message: string; created_at: string }>
        }
        const task = data.task

        const lines = [
          `## Task: ${task.title}`,
          `- **ID:** ${task.id}`,
          `- **Status:** ${task.status}`,
        ]
        if (task.description) lines.push(`- **Description:** ${task.description}`)
        if (task.assigned_to_agent) lines.push(`- **Assigned To:** ${task.assigned_to_agent}`)
        if (task.priority) lines.push(`- **Priority:** ${task.priority}`)
        if (task.parent_task_id) lines.push(`- **Parent Task:** ${task.parent_task_id}`)
        if (task.created_at) lines.push(`- **Created:** ${task.created_at}`)
        if (task.accepted_at) lines.push(`- **Accepted:** ${task.accepted_at}`)
        if (task.completed_at) lines.push(`- **Completed:** ${task.completed_at}`)

        if (task.result) {
          lines.push(`\n### Result`)
          lines.push('```json')
          try {
            lines.push(JSON.stringify(JSON.parse(task.result), null, 2))
          } catch {
            lines.push(task.result)
          }
          lines.push('```')
        }

        if (data.subtasks && data.subtasks.length > 0) {
          lines.push(`\n### Subtasks (${data.subtasks.length})`)
          for (const sub of data.subtasks) {
            lines.push(`- **${sub.status}** ${sub.title} → ${sub.assigned_to_agent ?? 'unassigned'}`)
          }
        }

        if (data.logs && data.logs.length > 0) {
          lines.push(`\n### Activity Log`)
          for (const log of data.logs) {
            lines.push(`- **${log.created_at}** [${log.action}] ${log.message ?? ''}`)
          }
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Task status error: ${error instanceof Error ? error.message : 'Unknown'}` }],
          isError: true,
        }
      }
    }
  )

  // task.submit_strategy — Lead Agent submits strategy after analyzing a task
  server.tool(
    'cortex_task_submit_strategy',
    'Submit a task execution strategy for user review. The Lead Agent calls this after analyzing a task to propose team roles, subtasks, and execution plan. The dashboard wizard will display the strategy for user approval.',
    {
      taskId: z.string().describe('The task ID to submit strategy for'),
      summary: z.string().describe('Brief summary of the analysis and proposed approach'),
      roles: z.array(z.object({
        role: z.string().describe('Role identifier (e.g. ui, backend, review)'),
        label: z.string().describe('Display label (e.g. "UI / Frontend")'),
        agent: z.string().describe('Agent ID to assign this role'),
        rationale: z.string().describe('Why this role is needed'),
      })).describe('Team roles needed for this task'),
      subtasks: z.array(z.object({
        title: z.string().describe('Subtask title'),
        description: z.string().optional().describe('Subtask description'),
        role: z.string().describe('Role this subtask belongs to'),
        dependsOn: z.array(z.string()).optional().describe('Role names this subtask depends on'),
      })).describe('Work items to execute'),
      estimatedEffort: z.string().optional().describe('Estimated effort (e.g. "Small (~1 session)")'),
    },
    async ({ taskId, summary, roles, subtasks, estimatedEffort }) => {
      try {
        const response = await apiCall(env, `/api/conductor/${encodeURIComponent(taskId)}/strategy`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            strategy: { summary, roles, subtasks, estimatedEffort },
          }),
          signal: AbortSignal.timeout(10000),
        })

        if (!response.ok) {
          const errorText = await response.text()
          return {
            content: [{ type: 'text' as const, text: `Strategy submission failed: ${response.status} ${errorText}` }],
            isError: true,
          }
        }

        const lines = [
          `**Strategy Submitted** for task ${taskId}`,
          `- **Roles:** ${roles.map(r => `${r.label} → ${r.agent}`).join(', ')}`,
          `- **Subtasks:** ${subtasks.length}`,
          `- **Status:** Awaiting user approval on dashboard`,
        ]
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Strategy submit error: ${error instanceof Error ? error.message : 'Unknown'}` }],
          isError: true,
        }
      }
    }
  )
}
