# Hub MCP Tool Reference

Complete reference for all 31 tools exposed by the Cortex Hub MCP Server.

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

**Returns:** `session_id`, `mission_brief`, `status`, `identity` object, `project` (`id`, `orgId`), `relevant_knowledge` array. `orgId` is the boundary of a cross-repo code search.

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

Query the codebase for architecture concepts, execution flows, and file matches using GitNexus hybrid vector/AST search. Omit `repo` to search every indexed repo **in your organization** — the intended way to answer a question that spans repos (a product's client, server and tools). Projects are isolated per organization, so the search never crosses into another one.

The organization is taken from, in order: `org`; the organization of the project you named; your latest `cortex_session_start`; the only organization with indexed code. If several organizations have code and none of those applies, the search is refused with the list of organizations rather than widened to all of them.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Natural language or code query |
| `repo` | string | no | Repository name (e.g. `cortex-hub`) or git URL |
| `projectId` | string | no | Project ID (use `repo` instead if possible) |
| `org` | string | no | Organization ID. Omit it: the hub uses the organization of your latest session |
| `branch` | string | no | Git branch to search |
| `limit` | number | no | Max results (default: 5) |

**Returns:** Formatted execution flows, source code matches from semantic search, and follow-up suggestions.

---

### `cortex_code_context`

Get a 360-degree view of a code symbol: methods, callers, callees, and related execution flows.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | yes | Function, class, or symbol name to explore |
| `repo` | string | no | Repository name or git URL |
| `projectId` | string | no | Project ID |
| `org` | string | no | Organization ID. Omit it: the hub uses the organization of your latest session |
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
| `org` | string | no | Organization ID. Omit it: the hub uses the organization of your latest session |
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

List the indexed repositories of your organization with project ID mapping — exactly the set a search without `repo` covers. Use it to find which repo name to pass to other code tools.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `org` | string | no | Organization ID. Omit it: the hub uses the organization of your latest session |

**Returns:** Table of indexed repositories with name, slug, symbol count, and flow count.

---

### `cortex_cypher`

Run Cypher queries directly against the GitNexus knowledge graph for exploring code relationships.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Cypher query (e.g. `MATCH (n:Function) RETURN n.name LIMIT 10`) |
| `repo` | string | no | Repository name or git URL |
| `projectId` | string | no | Project ID |
| `org` | string | no | Organization ID. Omit it: the hub uses the organization of your latest session |

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

### `cortex_recall`

What one project already knows about a piece of text: its knowledge documents and its project memories, in one call. The `recall-prompt` hook calls it on every user prompt. Only hits above a relevance floor are returned, archived documents are left out, and nothing counts as a selection in the quality metrics.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Text to recall for, such as the user's prompt |
| `repo` | string | no | Git remote URL or repo name; defaults to your session project |
| `projectId` | string | no | Project ID, when `repo` is not given |
| `limit` | number | no | Max results of each kind (default: 3, max: 10) |

**Returns:** JSON `{projectId, knowledge: [{id, title, snippet, score}], memories: [{id, text, score}]}`. `projectId` is `null` when no project is resolved.

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

### `cortex_memory_delete`

Delete a memory by its ID. Delete obsolete or wrong memories so they stop showing up in recall.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | The memory ID to delete (the `ID` shown by `cortex_memory_search`) |

**Returns:** The API's JSON response, or `Failed to delete memory` with the status.

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

### `cortex_plan_quality`

Score an implementation plan before executing it, against 8 criteria: completeness, specificity, feasibility, risk awareness, scope, ordering, testability and impact. A plan that does not pass is refined and resubmitted with `iteration` + 1, at most 3 times.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `plan` | string | yes | The plan: numbered steps, the files each touches, how it will be verified |
| `request` | string | no | The original request the plan answers; used to judge completeness and scope |
| `iteration` | number | no | Which attempt this is, 1-3 (default: 1) |
| `threshold` | number | no | Passing score out of 10 (default: 8.0) |
| `plan_type` | string | no | `feature`, `bugfix`, `refactor`, `architecture`, `migration` or `general` |

**Returns:** A 0-10 scorecard per criterion, the total, and whether the plan passes the threshold.

---

### `cortex_detect_changes`

Check a change before committing it: the indexed symbols it touches, the execution flows those symbols are steps of, and a risk level. The hub cannot see your working tree, so the caller passes its diff.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `diff` | string | yes, unless `scope: "compare"` | Unified diff: the output of `git diff --staged` (the next commit) or `git diff HEAD` (all uncommitted work). Any context size. For a large change, hunk bodies may be left out: `git diff --staged -U0 \| grep -E '^(diff \|--- \|\+\+\+ \|@@ )'` |
| `repo` | string | no | Repository the diff belongs to. Defaults to the repo of your active session |
| `projectId` | string | no | Project ID, instead of `repo` |
| `org` | string | no | Organization to scope the call to |
| `scope` | string | no | `compare` compares the indexed code with `baseRef`; it is the only scope that works without a diff |
| `baseRef` | string | no | Branch, tag or commit for `scope: "compare"` |

Lines are matched against the last indexed commit, so reindex after pushing. Without a `diff` and without `scope: "compare"` the call is refused (400) with these instructions, rather than reporting "no changes".

**Returns:** `summary` (`changed_count`, `affected_count`, `risk_level`, `files`, `new_files`, `files_without_symbols`), `changed_symbols`, `affected_processes`. `risk_level` is `none` for an empty diff, `low` / `medium` / `high` / `critical` by the number of affected flows (0 / ≤5 / ≤15 / more), and `unknown` with `partial: true` when a graph lookup failed: a lower bound, not a pass.

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

Multi-agent task orchestration: a lead plans, workers on other machines run the tasks, and results come back for review. The lifecycle, gates and worker setup are described in [Conductor](../conductor.md) and the [setup guide](../conductor/setup.md).

Shared values used by several tools below:

- **Executor:** `claude`, `codex`, `agy` or `gemini`.
- **Priority:** `critical`, `high`, `medium`, `low`, or a number 1-10 (lower runs first).
- **Route** (an item of `fallback`): `{ executor, model?, effort? }`. `executor: null` means any engine.

### `cortex_task_tree_create`

Create a whole plan as a tree of tasks in one call. Use it for multi-step plans instead of many `cortex_task_create` calls. Tasks refer to each other by `key`; the hub rejects a plan with a cycle and names the cycle. Put the plan under one root task with `kind: "group"` and give every top-level task that root's key as `parentKey`, or the dashboard shows N one-task plans.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `tasks` | object[] | yes | The tasks of the plan, at least one (fields below) |
| `parentId` | string | no | Existing task ID to hang the plan under |
| `projectId` | string | no | Project the tasks belong to |

Each item of `tasks`:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `key` | string | yes | Unique key within this plan |
| `title` | string | yes | Short title |
| `description` | string | no | What needs to be done |
| `kind` | string | no | `work` (default), `gate` or `group` |
| `parentKey` | string | no | Key of a `group` task in this same call |
| `dependsOn` | string[] | no | Keys of tasks that must finish first |
| `requiredCapabilities` | string[] | no | Capabilities a worker needs |
| `priority` | string \| number | no | Priority |
| `executor` | string | no | Executor to run it with |
| `model` | string | no | Model for the executor |
| `effort` | string | no | Reasoning effort for the executor |
| `fallback` | object[] | no | Routes tried in order when the first is unavailable |
| `files` | string[] | no | Files the task will touch. Locks are built from this list, so give it on every work task |
| `branch` | string | no | Branch the task works on |
| `pinnedAgent` | string | no | Agent ID that must run the task |
| `reviewRequired` | boolean | no | Defaults to `true` for work tasks |
| `approver` | string | no | Who decides a gate: `user` (dashboard only) or `lead` |
| `context` | object | no | Arbitrary context passed to the worker |

```json
{
  "tasks": [
    { "key": "plan", "title": "Billing export", "kind": "group" },
    { "key": "api", "title": "Export endpoint", "parentKey": "plan",
      "files": ["apps/api/src/billing/export.ts"], "executor": "claude" },
    { "key": "ui", "title": "Export button", "parentKey": "plan", "dependsOn": ["api"],
      "files": ["apps/web/src/billing/ExportButton.tsx"] },
    { "key": "ship", "title": "Approve the release", "parentKey": "plan",
      "kind": "gate", "approver": "user", "dependsOn": ["ui"] }
  ]
}
```

**Returns:** `Plan created`, the number of tasks ready to run now, and the task ID created for each key. A rejected plan returns the hub's error, with the cycle when there is one.

---

### `cortex_task_create`

Create a single task and optionally pin it to an agent. Supports dependencies, capabilities, routing and parent-child relationships.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | yes | Short title describing the task |
| `description` | string | no | Detailed description of what needs to be done |
| `assignTo` | string | no | Agent ID to pin the task to; the dispatcher hands it over when that agent is connected and idle |
| `priority` | string \| number | no | Priority |
| `requiredCapabilities` | string[] | no | Capabilities required to complete this task |
| `dependsOn` | string[] | no | Task IDs that must complete before this task can start |
| `notifyOnComplete` | string[] | no | Agent IDs to notify when this task completes |
| `context` | object | no | Arbitrary context object to pass to the assigned agent |
| `parentTaskId` | string | no | Parent task ID if this is a sub-task |
| `executor` | string | no | Executor to run the task with |
| `model` | string | no | Model for the executor |
| `effort` | string | no | Reasoning effort for the executor |
| `fallback` | object[] | no | Routes tried in order when the first is unavailable |
| `files` | string[] | no | Files the task will touch (used for locks) |
| `branch` | string | no | Branch the task works on |
| `reviewRequired` | boolean | no | Whether the result needs review before completing |
| `projectId` | string | no | Project ID from `cortex_session_start`; workers and pickup in other projects do not see the task |

**Returns:** Created task with `id`, `title`, `status`, and `assigned_to_agent` / `priority` when set.

---

### `cortex_task_pickup`

Retrieve tasks assigned to the calling agent. Automatically checks both `agentId` and API key name.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agentId` | string | no | Agent ID (auto-detected if not provided) |
| `projectId` | string | no | Project ID from `cortex_session_start`; limits unpinned tasks to that project |

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

### `cortex_agents`

List connected Conductor workers and live MCP sessions. Call it before choosing routes for tasks. Takes no parameters.

**Returns:** One line per worker: agent ID, hostname, OS, `busy`/`idle` and the current task, engines with their models, and any exhausted quota with the time it resets. Then one line per MCP session: agent ID, IDE, branch, last activity.

---

### `cortex_task_review`

Approve or reject a task whose status is `review`, or decide a gate task whose `approver` is `lead`. Gates with `approver: "user"` are refused with 403; they are decided on the dashboard.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | yes | Task ID |
| `verdict` | string | yes | `approve` or `reject` |
| `feedback` | string | no | Why; sent back to the worker on reject |

**Returns:** `Review recorded` with the task's new status.

---

### `cortex_task_route`

Change how a task is routed. Use it to resolve an escalation (`clearEscalation`) or to pick a fallback. Only the fields you pass change; `null` clears a field.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | yes | Task ID |
| `executor` | string \| null | no | Executor to run the task with |
| `model` | string \| null | no | Model for the executor |
| `effort` | string \| null | no | Reasoning effort for the executor |
| `fallback` | object[] \| null | no | Routes tried in order when the first is unavailable |
| `pinnedAgent` | string \| null | no | Agent ID that must run the task |
| `priority` | string \| number | no | Priority |
| `files` | string[] | no | Files the task will touch (used for locks) |
| `dependsOn` | string[] | no | Stored task IDs, not plan keys; unknown IDs are rejected |
| `clearEscalation` | boolean | no | Clear the task's escalation once you have resolved it |

**Returns:** `Route updated` with the task's executor and model.

---

### `cortex_task_cancel`

Cancel a task you give up on. Tasks that depend on it stay blocked until you reroute them with `cortex_task_route`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | yes | Task ID |
| `reason` | string | no | Why the task was cancelled |

**Returns:** `Cancelled` with the task ID.

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
