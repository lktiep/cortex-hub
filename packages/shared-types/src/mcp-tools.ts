// ============================================================
// MCP tool permissions — what an API key can be granted
// ============================================================

/**
 * One hub-mcp tool as the API Keys page offers it. `id` is the tool name with
 * dots for underscores: `cortex.task.tree.create` grants `cortex_task_tree_create`.
 */
export interface McpToolPermission {
  id: string
  label: string
  group: string
}

/**
 * A key holding this permission gets every tool, including tools added after
 * the key was made. A list of ids only ever grants the tools it names.
 */
export const ALL_TOOLS = '*'

/** Every tool hub-mcp registers. hub-mcp's tests fail when a tool is missing here. */
export const MCP_TOOL_PERMISSIONS: readonly McpToolPermission[] = [
  { id: 'cortex.session.start', label: 'Start Session (session_start)', group: 'Session' },
  { id: 'cortex.session.end', label: 'End Session (session_end)', group: 'Session' },
  { id: 'cortex.changes', label: 'Check Remote Changes (changes)', group: 'Changes' },
  { id: 'cortex.code.search', label: 'Code Search (code_search)', group: 'Code' },
  { id: 'cortex.code.context', label: 'Symbol Context (code_context)', group: 'Code' },
  { id: 'cortex.code.impact', label: 'Blast Radius (code_impact)', group: 'Code' },
  { id: 'cortex.code.reindex', label: 'Trigger Reindex (code_reindex)', group: 'Code' },
  { id: 'cortex.list.repos', label: 'List Repositories (list_repos)', group: 'Code' },
  { id: 'cortex.cypher', label: 'Cypher Graph Queries (cypher)', group: 'Code' },
  { id: 'cortex.detect.changes', label: 'Pre-commit Change Risk (detect_changes)', group: 'Code' },
  { id: 'cortex.memory.store', label: 'Store Memory (memory_store)', group: 'Memory' },
  { id: 'cortex.memory.search', label: 'Search Memory (memory_search)', group: 'Memory' },
  { id: 'cortex.memory.delete', label: 'Delete Memory (memory_delete)', group: 'Memory' },
  { id: 'cortex.knowledge.store', label: 'Store Team Knowledge (knowledge_store)', group: 'Knowledge' },
  { id: 'cortex.knowledge.search', label: 'Search Team Knowledge (knowledge_search)', group: 'Knowledge' },
  { id: 'cortex.file.notes', label: 'File Notes (file_notes)', group: 'Knowledge' },
  { id: 'cortex.quality.report', label: 'Report Quality Gates (quality_report)', group: 'Quality' },
  { id: 'cortex.plan.quality', label: 'Assess Plan Quality (plan_quality)', group: 'Quality' },
  { id: 'cortex.task.create', label: 'Create Task (task_create)', group: 'Tasks' },
  { id: 'cortex.task.pickup', label: 'Pickup Task (task_pickup)', group: 'Tasks' },
  { id: 'cortex.task.accept', label: 'Accept Task (task_accept)', group: 'Tasks' },
  { id: 'cortex.task.update', label: 'Update Task (task_update)', group: 'Tasks' },
  { id: 'cortex.task.list', label: 'List Tasks (task_list)', group: 'Tasks' },
  { id: 'cortex.task.status', label: 'Task Status (task_status)', group: 'Tasks' },
  { id: 'cortex.task.submit.strategy', label: 'Submit Strategy (task_submit_strategy)', group: 'Tasks' },
  { id: 'cortex.task.tree.create', label: 'Create Task Tree (task_tree_create)', group: 'Conductor lead' },
  { id: 'cortex.agents', label: 'List Agents (agents)', group: 'Conductor lead' },
  { id: 'cortex.task.review', label: 'Review Task or Gate (task_review)', group: 'Conductor lead' },
  { id: 'cortex.task.route', label: 'Reroute Task (task_route)', group: 'Conductor lead' },
  { id: 'cortex.task.cancel', label: 'Cancel Task (task_cancel)', group: 'Conductor lead' },
  { id: 'cortex.health', label: 'Health Diagnostics (health)', group: 'System' },
  { id: 'cortex.tool.stats', label: 'Tool Usage Stats (tool_stats)', group: 'System' },
]

/** The tool name a permission id grants. */
export function toolNameForPermission(id: string): string {
  return id.replace(/\./g, '_')
}

/**
 * The tools a key's permissions let through, or `null` for no filter: no list
 * at all, or one holding `ALL_TOOLS`. An empty list lets nothing through.
 */
export function allowedToolNames(permissions: readonly string[] | undefined): Set<string> | null {
  if (!permissions || permissions.includes(ALL_TOOLS)) return null
  return new Set(permissions.map(toolNameForPermission))
}
