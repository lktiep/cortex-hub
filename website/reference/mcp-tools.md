# MCP tools

The hub's MCP server (`apps/hub-mcp`) exposes 32 tools, all named `cortex_*`. An agent reaches
them through the `cortex-hub` entry the [installer](./installer) writes. Each call carries the API
key; what a key can see depends on its project and organization scope.

This page lists each tool and its parameters. The guides explain when to use them.

## Session {#session}

| Tool | Parameters | What it does |
|---|---|---|
| `cortex_session_start` | `repo`, `mode`, `agentId`, `hostname`, `os`, `ide`, `branch`, `capabilities`, `role`, `clientSessionId` | Opens a session and returns the project, a mission brief, relevant knowledge and recent sessions. A `clientSessionId` that matches an active session reuses it |
| `cortex_session_end` | `sessionId`, `summary`, `auto` | Closes the session; the summary is saved as memory. `auto: true` is what the exit hook sends: the session is recorded as `abandoned` |
| `cortex_changes` | `agentId`, `projectId` | Commits and files other agents pushed that this agent has not seen |
| `cortex_health` | none | Health of the hub's backend services |

See [Sessions](../guide/sessions).

## Code intelligence {#code}

| Tool | Parameters | What it does |
|---|---|---|
| `cortex_code_search` | `query`, `repo`, `projectId`, `org`, `branch`, `limit` | Ranked hybrid search (vector and BM25) over the index. Without `repo`, every repo in your organization |
| `cortex_code_context` | `name`, `repo`, `projectId`, `org`, `file` | A symbol's callers, callees, imports and the flows it is part of |
| `cortex_code_impact` | `target`, `repo`, `projectId`, `org`, `branch`, `direction` | What a change to a symbol reaches. `direction` is `downstream` (default) or `upstream` |
| `cortex_cypher` | `query`, `repo`, `projectId`, `org` | A Cypher query against the code graph |
| `cortex_detect_changes` | `diff`, `repo`, `projectId`, `org`, `scope`, `baseRef` | The symbols and flows a diff touches, with a risk level. `unknown` means a lookup failed |
| `cortex_list_repos` | `org` | The indexed repos of your organization and their project ids |
| `cortex_code_reindex` | `repo`, `branch` | Starts a re-index of a branch. Run it after a push |

See [Code intelligence](../guide/code-intelligence).

## Knowledge and memory {#knowledge}

| Tool | Parameters | What it does |
|---|---|---|
| `cortex_knowledge_store` | `title`, `content`, `tags`, `projectId`, `agentId`, `hallType`, `validFrom`, `files`, `category` | Stores a document for the team. With `files`, it becomes a file note for those paths |
| `cortex_knowledge_search` | `query`, `tags`, `projectId`, `limit`, `hallType`, `asOf` | Semantic search over the knowledge base |
| `cortex_file_notes` | `repo`, `projectId`, `files` | Risks, lessons and fixes linked to files, as JSON. Without `files`, every linked path of the project |
| `cortex_memory_store` | `content`, `agentId`, `projectId`, `branch`, `metadata` | Stores a memory for this agent. `branch` needs `projectId` |
| `cortex_memory_search` | `query`, `agentId`, `projectId`, `branch`, `limit` | Searches memories: the branch first, then the project, then the agent |
| `cortex_memory_delete` | `id` | Deletes a memory that is wrong or out of date |

See [Knowledge and memory](../guide/knowledge-memory).

## Quality {#quality}

| Tool | Parameters | What it does |
|---|---|---|
| `cortex_plan_quality` | `plan`, `request`, `iteration`, `threshold`, `plan_type` | Scores a plan on eight criteria, 0 to 10; it passes at 8.0 |
| `cortex_quality_report` | `gate_name`, `passed`, `score`, `details` | Records the result of a quality gate for the dashboard |
| `cortex_tool_stats` | `days`, `agentId`, `projectId` | Tool usage: success rates, latency, token estimates, trends |

See [Quality gates](../guide/quality-gates).

## Tasks {#tasks}

| Tool | Parameters | What it does |
|---|---|---|
| `cortex_task_create` | `title`, `description`, `assignTo`, `requiredCapabilities`, `dependsOn`, `notifyOnComplete`, `context`, `parentTaskId`, `model`, `effort`, `fallback`, `files`, `branch`, `reviewRequired`, `projectId` | Creates one task, optionally for another agent |
| `cortex_task_pickup` | `agentId`, `projectId` | Tasks assigned to this agent or its API key |
| `cortex_task_accept` | `taskId` | Accepts an assigned task |
| `cortex_task_update` | `taskId`, `status`, `message`, `result`, `parentTaskId` | Moves a task to `in_progress`, `review`, `completed` or `failed` |
| `cortex_task_list` | `projectId`, `status`, `assignedTo`, `limit` | Lists tasks |
| `cortex_task_status` | `taskId` | A task with its logs and history |
| `cortex_task_submit_strategy` | `taskId`, `summary`, `roles`, `subtasks`, `estimatedEffort` | Proposes roles and subtasks for the dashboard to show for approval |

## Conductor {#conductor}

Tools for the lead agent that plans and reviews. See [Conductor](../conductor/overview).

| Tool | Parameters | What it does |
|---|---|---|
| `cortex_task_tree_create` | `parentId`, `projectId`, `tasks`, `upload` | Creates a whole plan as a tree of tasks; tasks refer to each other by key. `upload: true` returns a one-time `curl` command for a JSON file instead, valid for 15 minutes |
| `cortex_agents` | none | Connected workers (engines, models, busy or idle, exhausted quota) and live MCP sessions |
| `cortex_task_review` | `taskId`, `verdict`, `feedback` | Approves or rejects a task in `review`, or decides a lead gate. User gates are refused (403) |
| `cortex_task_route` | `taskId`, `executor`, `model`, `effort`, `fallback`, `pinnedAgent`, `priority`, `files`, `dependsOn`, `clearEscalation` | Changes how a task is routed. Only the fields you pass change; `null` clears one. `dependsOn` takes stored task ids |
| `cortex_task_cancel` | `taskId`, `reason` | Cancels a task; its dependents stay blocked. Cancelling a group cancels everything under it |

The task fields of a plan are listed under [Write the plan](../conductor/overview).

## Notices in tool results

Two kinds of text can be added to the result of any hub tool call:

- **Conductor notices** for the lead, under `📋 Conductor:`. See [Review](../conductor/review#notices-not-polling).
- **File notes** for the files a code tool's result points at. See
  [File notes](../guide/knowledge-memory#file-notes).
