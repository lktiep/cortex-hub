# Hub MCP Tool Reference

Complete reference for all 25 tools exposed by the Cortex Hub MCP Server.

## Authentication

All MCP requests require a Bearer token in the `Authorization` header:

```
Authorization: Bearer <API_KEY>
```

API keys are created in the Cortex Hub Dashboard under **Settings > API Keys**. Each key is scoped to an agent identity. Invalid or missing keys return a JSON-RPC error with code `-32001`.

---

## Session

Tools for managing agent session lifecycle.

### `cortex_session_start`

Start a new execution session with optional agent identity metadata. Returns a session ID, dynamic mission brief assembled from the knowledge base, and relevant knowledge hits.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repo` | string | yes | Repository URL being worked on |
| `mode` | string | no | Session mode: `development`, `onboarding`, `review` |
| `agentId` | string | no | Agent identifier (e.g. `claude-code`) |
| `hostname` | string | no | Machine hostname |
| `os` | string | no | Operating system (`macOS`/`Windows`/`Linux`) |
| `ide` | string | no | IDE type (`claude-code-cli`/`claude-code-vscode`/`cursor`/`windsurf`/`codex`) |
| `branch` | string | no | Current git branch |
| `capabilities` | string[] | no | Agent capabilities list |
| `role` | string | no | Agent role from `agent-identity.json` |

**Returns:** `session_id`, `mission_brief`, `status`, `identity` object, `relevant_knowledge` array.

---

### `cortex_session_end`

Close a session with a summary of work done. Reports session duration and compliance score.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | string | yes | Session ID from `cortex_session_start` |
| `summary` | string | yes | Brief summary of work done in this session |

**Returns:** `status` (`closed`), `sessionId`, `summary`, optional `session` object with duration.

---

## Code Intelligence

Tools for searching, reading, and analyzing code via the GitNexus AST graph and vector search.

### `cortex_code_search`

Query the codebase for architecture concepts, execution flows, and file matches using GitNexus hybrid vector/AST search. Omit `repo` to search across all indexed projects.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Natural language or code query |
| `repo` | string | no | Repository name (e.g. `cortex-hub`) or git URL |
| `projectId` | string | no | Project ID (use `repo` instead if possible) |
| `branch` | string | no | Git branch to search |
| `limit` | number | no | Max results (default: 5) |

**Returns:** Formatted execution flows, source code matches from semantic search, and follow-up suggestions.

---

### `cortex_code_read`

Read raw source code from an indexed repository. Returns full file content or a line range. Use after `cortex_code_search` to view complete files.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file` | string | yes | Relative file path within the repo (e.g. `src/utils/auth.ts`) |
| `repo` | string | no | Repository name or git URL |
| `projectId` | string | no | Project ID |
| `startLine` | number | no | Start line (1-indexed, inclusive) |
| `endLine` | number | no | End line (1-indexed, inclusive) |

**Returns:** Syntax-highlighted file content with line count and file size.

---

### `cortex_code_context`

Get a 360-degree view of a code symbol: methods, callers, callees, and related execution flows.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | yes | Function, class, or symbol name to explore |
| `repo` | string | no | Repository name or git URL |
| `projectId` | string | no | Project ID |
| `file` | string | no | File path to disambiguate when multiple symbols share the same name |

**Returns:** Raw context output showing the symbol's relationships in the code graph.

---

### `cortex_code_impact`

Analyze the blast radius of changing a specific symbol to verify downstream impact before making edits. Auto-retries with class method lookup when a class-level target appears isolated.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `target` | string | yes | Function, class, or file name to analyze |
| `repo` | string | no | Repository name or git URL |
| `projectId` | string | no | Project ID |
| `branch` | string | no | Git branch to analyze |
| `direction` | string | no | `upstream` or `downstream` (default: `downstream`) |

**Returns:** Affected symbols, risk level, and impacted execution flows. For classes, lists methods with individual impact.

---

### `cortex_code_reindex`

Trigger re-indexing of a project after code changes. Looks up the project by repo URL and starts a GitNexus re-index job.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repo` | string | yes | Git repository URL (e.g. `https://github.com/org/repo`) |
| `branch` | string | no | Branch to index (default: `main`) |

**Returns:** `status` (`started`), `projectId`, `jobId`, `branch`.

---

### `cortex_list_repos`

List all indexed repositories with project ID mapping. Use to find which `projectId` or repo name to pass to other code tools.

*No parameters.*

**Returns:** Table of indexed repositories with name, slug, symbol count, and flow count.

---

### `cortex_cypher`

Run Cypher queries directly against the GitNexus knowledge graph for exploring code relationships.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Cypher query (e.g. `MATCH (n:Function) RETURN n.name LIMIT 10`) |
| `repo` | string | no | Repository name or git URL |
| `projectId` | string | no | Project ID |

**Available node properties:** `name`, `filePath`. Use `labels(n)` for node type.

**Returns:** Query results as JSON.

---

## Knowledge

Shared knowledge base with semantic search, chunking, and embedding.

### `cortex_knowledge_store`

Store a knowledge document. Auto-chunks and embeds content for semantic search. Use to contribute discovered patterns, resolved issues, architecture decisions, and reusable solutions.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | yes | Document title (concise, descriptive) |
| `content` | string | yes | Full document content to store |
| `tags` | string[] | no | Tags for categorization (e.g. `["typescript", "patterns"]`) |
| `projectId` | string | no | Project ID to scope this knowledge to |
| `agentId` | string | no | Contributing agent identifier |
| `hallType` | string | no | MemPalace hall type: `fact`, `event`, `discovery`, `preference`, `advice`, `general` |
| `validFrom` | string | no | ISO date when this fact became valid (temporal validity) |

**Returns:** The stored document object with ID.

---

### `cortex_knowledge_search`

Search the knowledge base by semantic similarity. Supports filtering by tags, project, hall type, and temporal validity.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Text query (auto-embedded) |
| `tags` | string[] | no | Filter by tags |
| `projectId` | string | no | Filter by project ID |
| `limit` | number | no | Max results (default: 5) |
| `hallType` | string | no | Filter by hall type: `fact`, `event`, `discovery`, `preference`, `advice`, `general` |
| `asOf` | string | no | ISO date -- return only facts valid at this point in time |

**Returns:** Matching documents with metadata, tags, and relevance scores.

---

## Memory

Per-agent memory with branch-scoped namespacing and semantic recall.

### `cortex_memory_store`

Store a memory for an AI agent. Memories persist across sessions and can be recalled by semantic search. Supports branch-scoped namespacing via `projectId` + `branch`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `content` | string | yes | The memory content to store |
| `agentId` | string | no | Agent identifier (default: `default`) |
| `projectId` | string | no | Project ID to scope this memory to |
| `branch` | string | no | Git branch to scope this memory to (requires `projectId`) |
| `metadata` | object | no | Optional metadata tags |

**Returns:** Confirmation with `stored: true`, resolved `userId`, `projectId`, `branch`.

---

### `cortex_memory_search`

Search agent memories by semantic similarity. Uses a branch-aware fallback chain: branch-specific -> project-level -> agent-level.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Search query for memory recall |
| `agentId` | string | no | Filter by agent (default: all agents) |
| `projectId` | string | no | Project ID to search within |
| `branch` | string | no | Git branch to search (with fallback to project-level) |
| `limit` | number | no | Max results (default: 5) |

**Returns:** `query`, `scopes` searched, `count`, and `memories` array with `_scope` annotation.

---

## Quality

Quality gate reporting and change detection.

### `cortex_quality_report`

Report the results of a quality gate check (e.g. build, typecheck, lint, test outputs).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `gate_name` | string | yes | Name of the gate evaluated (e.g. `Gate 4`, `pre-push`) |
| `passed` | boolean | yes | Whether the gate passed or failed |
| `score` | number | no | Numerical score out of 100 |
| `details` | string | no | Markdown or technical log of the evaluation criteria |

**Returns:** Confirmation message with gate name and pass/fail status.

---

### `cortex_detect_changes`

Detect uncommitted changes and analyze their risk level across the indexed codebase. Shows changed symbols, affected processes, and risk assessment.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `scope` | string | no | Scope: `all` (default), `staged`, or `unstaged` |
| `projectId` | string | no | Project ID to scope analysis to |

**Returns:** JSON with changed symbols, affected execution flows, and risk assessment.

---

### `cortex_changes`

Check for recent code changes pushed by other agents or team members. Returns unseen commits and affected files.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agentId` | string | yes | Your agent identifier |
| `projectId` | string | yes | Project ID to check changes for |
| `acknowledge` | boolean | no | Mark changes as seen (default: `true`) |

**Returns:** `hasChanges`, `count`, human-readable `summary`, and `events` array with commit details and affected files.

---

## Conductor Tasks

Multi-agent task orchestration: create, assign, track, and coordinate work across agents.

### `cortex_task_create`

Create a task and optionally assign it to another agent. Supports dependencies, capabilities, and parent-child relationships.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | yes | Short title describing the task |
| `description` | string | no | Detailed description of what needs to be done |
| `assignTo` | string | no | Agent ID to assign the task to |
| `priority` | string | no | Priority: `low`, `medium`, `high`, `critical` |
| `requiredCapabilities` | string[] | no | Capabilities required to complete this task |
| `dependsOn` | string[] | no | Task IDs that must complete before this task can start |
| `notifyOnComplete` | string[] | no | Agent IDs to notify when this task completes |
| `context` | object | no | Arbitrary context object to pass to the assigned agent |
| `parentTaskId` | string | no | Parent task ID if this is a sub-task |

**Returns:** Created task with `id`, `title`, `status`, `assigned_to_agent`, `priority`.

---

### `cortex_task_pickup`

Retrieve tasks assigned to the calling agent. Automatically checks both `agentId` and API key name.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agentId` | string | no | Agent ID (auto-detected if not provided) |

**Returns:** Next pending task with `id`, `title`, `status`, `priority`, `description`, or a message if no tasks are pending.

---

### `cortex_task_accept`

Accept an assigned task, signaling that work will begin. Updates task status to `accepted`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | yes | The ID of the task to accept |

**Returns:** Task `id`, `title`, `status` (`accepted`).

---

### `cortex_task_update`

Update the status of a task. Transitions tasks through their lifecycle. Can also re-parent orphan tasks.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | yes | The ID of the task to update |
| `status` | string | yes | New status: `in_progress`, `review`, `completed`, `failed` |
| `message` | string | no | Progress message or note about the status change |
| `result` | object | no | Result data when completing or failing a task |
| `parentTaskId` | string | no | Set or change the parent task ID |

**Returns:** Updated task `id`, `title`, `status`.

---

### `cortex_task_list`

List tasks with optional filters for project, status, and assignee.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `projectId` | string | no | Filter by project ID |
| `status` | string | no | Filter by status (e.g. `assigned`, `in_progress`, `completed`) |
| `assignedTo` | string | no | Filter by assigned agent ID |
| `limit` | number | no | Max tasks to return (default: 20) |

**Returns:** List of tasks with `id`, `title`, `status`, `assigned_to_agent`, `priority`.

---

### `cortex_task_status`

Get detailed status of a specific task including subtasks, logs, and full history.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | yes | The ID of the task to inspect |

**Returns:** Full task detail with `description`, `assigned_to_agent`, `priority`, `parent_task_id`, timestamps, `result`, subtask list, and activity log.

---

### `cortex_task_submit_strategy`

Submit a task execution strategy for user review. The Lead Agent calls this after analyzing a task to propose team roles, subtasks, and execution plan.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | yes | Task ID to submit strategy for |
| `summary` | string | yes | Brief summary of analysis and proposed approach |
| `roles` | object[] | yes | Team roles (each: `role`, `label`, `agent`, `rationale`) |
| `subtasks` | object[] | yes | Work items (each: `title`, `description?`, `role`, `dependsOn?`) |
| `estimatedEffort` | string | no | Estimated effort (e.g. `Small (~1 session)`) |

**Returns:** Confirmation with roles, subtask count, and status (`Awaiting user approval on dashboard`).

---

## Analytics

Tool usage statistics and self-evaluation metrics.

### `cortex_health`

Check health status of all Cortex Hub backend services (Qdrant, Dashboard API, mem9, GitNexus, CLIProxy).

*No parameters.*

**Returns:** `overall` status (`healthy` or `degraded`), per-service `status`, `statusCode`, `latencyMs`, and `checkedAt` timestamp.

---

### `cortex_tool_stats`

View Cortex MCP tool usage analytics: success rates, latency, token estimates, and trends.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `days` | number | no | Time window in days (default: 7) |
| `agentId` | string | no | Filter by agent ID |
| `projectId` | string | no | Filter by project ID |

**Returns:** Per-tool breakdown (success rate, latency, errors), per-agent breakdown, daily trend, and summary (total calls, success rate, estimated tokens saved, active agents).

---

## Error Handling

All tools return MCP-standard responses. On failure, the response includes `isError: true` and a descriptive error message. Common error patterns:

| Scenario | Behavior |
|----------|----------|
| Invalid API key | JSON-RPC error `-32001`, HTTP 401 |
| Backend service down | Tool returns error text with service name |
| Request timeout | 10-15 second timeout per tool call |
| Project not found | Error with suggestion to register in Dashboard |
| Symbol not found | Auto-retry with context lookup; returns suggestions |

Adaptive hints are automatically appended to tool responses based on the agent's usage patterns in the current session.
