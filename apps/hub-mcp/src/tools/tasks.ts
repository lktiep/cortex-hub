import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Env } from '../types.js'

/**
 * Register Cortex Conductor task management tools.
 * Enables agents to create, pick up, accept, update, and query tasks
 * via the Dashboard API task endpoints.
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
        const response = await fetch(`${env.DASHBOARD_API_URL}/api/tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title,
            description,
            assignTo,
            priority,
            requiredCapabilities,
            dependsOn,
            notifyOnComplete,
            context,
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
          id: string
          title: string
          status: string
          assignedTo?: string
          priority?: string
        }

        const lines = [
          `**Task Created**`,
          `- **ID:** ${data.id}`,
          `- **Title:** ${data.title}`,
          `- **Status:** ${data.status}`,
        ]
        if (data.assignedTo) lines.push(`- **Assigned To:** ${data.assignedTo}`)
        if (data.priority) lines.push(`- **Priority:** ${data.priority}`)

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
        // Query all tasks, filter by any matching identity
        const url = `${env.DASHBOARD_API_URL}/api/tasks?status=assigned,accepted,in_progress`
        const response = await fetch(url, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(10000),
        })

        if (!response.ok) {
          const errorText = await response.text()
          return {
            content: [{ type: 'text' as const, text: `Task pickup failed: ${response.status} ${errorText}` }],
            isError: true,
          }
        }

        const data = (await response.json()) as { tasks?: Array<{ id: string; title: string; status: string; priority?: string; description?: string }> }
        const tasks = data.tasks ?? []

        if (tasks.length === 0) {
          return { content: [{ type: 'text' as const, text: `No pending tasks for agent **${agentId}**.` }] }
        }

        const lines = [`**Tasks for ${agentId}** (${tasks.length} found):\n`]
        for (const task of tasks) {
          lines.push(`### ${task.title}`)
          lines.push(`- **ID:** ${task.id}`)
          lines.push(`- **Status:** ${task.status}`)
          if (task.priority) lines.push(`- **Priority:** ${task.priority}`)
          if (task.description) lines.push(`- **Description:** ${task.description}`)
          lines.push('')
        }

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
        const response = await fetch(`${env.DASHBOARD_API_URL}/api/tasks/${encodeURIComponent(taskId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: 'accepted',
            acceptedAt: new Date().toISOString(),
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

        const data = (await response.json()) as { id: string; title: string; status: string }
        return {
          content: [{ type: 'text' as const, text: `**Task Accepted**\n- **ID:** ${data.id}\n- **Title:** ${data.title}\n- **Status:** ${data.status}` }],
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
    'Update the status of a task. Use to transition tasks through their lifecycle: in_progress, review, completed, or failed.',
    {
      taskId: z.string().describe('The ID of the task to update'),
      status: z.enum(['in_progress', 'review', 'completed', 'failed']).describe('The new status for the task'),
      message: z.string().optional().describe('Progress message or note about the status change'),
      result: z.record(z.string(), z.unknown()).optional().describe('Result data when completing or failing a task'),
    },
    async ({ taskId, status, message, result }) => {
      try {
        const response = await fetch(`${env.DASHBOARD_API_URL}/api/tasks/${encodeURIComponent(taskId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status, message, result }),
          signal: AbortSignal.timeout(10000),
        })

        if (!response.ok) {
          const errorText = await response.text()
          return {
            content: [{ type: 'text' as const, text: `Task update failed: ${response.status} ${errorText}` }],
            isError: true,
          }
        }

        const data = (await response.json()) as { id: string; title: string; status: string }
        return {
          content: [{ type: 'text' as const, text: `**Task Updated**\n- **ID:** ${data.id}\n- **Title:** ${data.title}\n- **Status:** ${data.status}` }],
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

        const url = `${env.DASHBOARD_API_URL}/api/tasks?${params.toString()}`
        const response = await fetch(url, {
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
        const response = await fetch(`${env.DASHBOARD_API_URL}/api/tasks/${encodeURIComponent(taskId)}`, {
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

        const task = (await response.json()) as {
          id: string
          title: string
          status: string
          description?: string
          assignedTo?: string
          priority?: string
          createdAt?: string
          acceptedAt?: string
          completedAt?: string
          parentTaskId?: string
          dependsOn?: string[]
          logs?: Array<{ timestamp: string; message: string }>
          result?: Record<string, unknown>
        }

        const lines = [
          `## Task: ${task.title}`,
          `- **ID:** ${task.id}`,
          `- **Status:** ${task.status}`,
        ]
        if (task.description) lines.push(`- **Description:** ${task.description}`)
        if (task.assignedTo) lines.push(`- **Assigned To:** ${task.assignedTo}`)
        if (task.priority) lines.push(`- **Priority:** ${task.priority}`)
        if (task.parentTaskId) lines.push(`- **Parent Task:** ${task.parentTaskId}`)
        if (task.dependsOn && task.dependsOn.length > 0) lines.push(`- **Depends On:** ${task.dependsOn.join(', ')}`)
        if (task.createdAt) lines.push(`- **Created:** ${task.createdAt}`)
        if (task.acceptedAt) lines.push(`- **Accepted:** ${task.acceptedAt}`)
        if (task.completedAt) lines.push(`- **Completed:** ${task.completedAt}`)

        if (task.result) {
          lines.push(`\n### Result`)
          lines.push('```json')
          lines.push(JSON.stringify(task.result, null, 2))
          lines.push('```')
        }

        if (task.logs && task.logs.length > 0) {
          lines.push(`\n### Activity Log`)
          for (const log of task.logs) {
            lines.push(`- **${log.timestamp}:** ${log.message}`)
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
}
