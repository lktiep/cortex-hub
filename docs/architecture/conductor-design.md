# Cortex Conductor — Multi-Agent Task Orchestration (v2 Design)

> Updated 2026-03-30: Corrected scope model, agent identity, and communication architecture.

## Core Principles

1. **Tasks scoped per API key** — each API key = one user. Users only see their own agents/tasks.
2. **Agents are uniquely identified** — not just API key name, but agentId + hostname + IDE + project + branch.
3. **Real-time communication** — agents must receive tasks without manual polling.

## Scope Model

```
API Key "team-alpha" (User: Alice)
├── Agent: claude-mac (macOS, Claude Code CLI, cortex-hub, master)
├── Agent: claude-vps-1 (Windows, Claude Code CLI, my-backend, feat/auth)
├── Agent: antigravity-mac (macOS, Antigravity, cortex-hub, master)
└── Agent: cursor-win (Windows, Cursor, my-backend, feat/ui)

API Key "team-beta" (User: Bob)
├── Agent: claude-bob-1 (macOS, Claude Code, project-x, main)
└── Agent: codex-thai (Linux, Codex, project-x, main)
```

**Rule:** Each user can only create/assign tasks to agents under their own API key.
Dashboard Conductor page filters by authenticated user's API key.

## Agent Identity (Enhanced)

### What `cortex_session_start` must send

```json
{
  "repo": "https://github.com/lktiep/cortex-hub.git",
  "mode": "development",
  "agentId": "claude-code",
  "identity": {
    "sessionName": "claude-mac-cortex",
    "hostname": "Tieps-MacBook-Pro",
    "os": "macOS",
    "ide": "claude-code-cli",
    "project": "cortex-hub",
    "branch": "master",
    "role": "godot-game-builder",
    "capabilities": ["godot", "build", "test"]
  }
}
```

### What Dashboard shows per agent

```
┌─ claude-mac-cortex ──────────────────────────────┐
│ 🟢 online (last seen: 2s ago)                    │
│                                                   │
│ Host: Tieps-MacBook-Pro (macOS arm64)             │
│ IDE:  Claude Code CLI                             │
│ Project: cortex-hub @ master                      │
│ Role: godot-game-builder                          │
│ Caps: godot, build, test                          │
│                                                   │
│ Current task: [task_abc] Build Godot scene (60%)  │
└───────────────────────────────────────────────────┘
```

### Online detection

Agent is "online" if `last_activity` < 5 minutes ago.
`last_activity` updated on every MCP tool call (already tracked in `query_logs`).

## Communication Architecture

### Problem

```
Dashboard creates task → assigns to Agent B
Agent B is idle (waiting for user input)
Agent B never calls MCP tool → never receives task
```

### Solution: Agent Worker Daemon

A lightweight background process per machine that:
1. Polls `cortex_task_pickup` every 30 seconds
2. When task arrives, spawns `claude -p` (or `codex exec`) to execute
3. Reports progress/completion back to Hub

```bash
# scripts/cortex-worker.sh — runs in background
#!/bin/bash
AGENT_ID="${1:-$(hostname)}"
API_KEY="${HUB_API_KEY}"
POLL_INTERVAL=30

while true; do
  # Check for assigned tasks
  TASKS=$(curl -s "${CORTEX_MCP_URL}" \
    -H "Authorization: Bearer $API_KEY" \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
         "params":{"name":"cortex_task_pickup","arguments":{"agentId":"'$AGENT_ID'"}}}')

  # If tasks found, execute with claude -p
  TASK_COUNT=$(echo "$TASKS" | jq '.result.content[0].text' | grep -c "TASK")
  if [ "$TASK_COUNT" -gt 0 ]; then
    TASK_PROMPT=$(echo "$TASKS" | jq -r '.result.content[0].text')
    claude -p "$TASK_PROMPT" \
      --allowedTools "Bash,Read,Write,Edit" \
      --max-budget-usd 5.00 \
      --output-format json
  fi

  sleep $POLL_INTERVAL
done
```

**Launch:**
```bash
# Start worker daemon on each machine
nohup bash scripts/cortex-worker.sh "claude-vps-1" &

# Or via install.sh
bash scripts/install.sh --worker  # starts daemon
```

### Future: WebSocket (v2)

```
Agent ←→ WebSocket ←→ Cortex Hub
         persistent connection
         Hub pushes tasks instantly
         Agent sends progress updates
```

Requires MCP server architecture change (currently stateless HTTP).
Could use a separate WebSocket service alongside MCP.

## Database Schema (Updated)

### Enhanced session_handoffs

```sql
ALTER TABLE session_handoffs ADD COLUMN hostname TEXT;
ALTER TABLE session_handoffs ADD COLUMN os TEXT;
ALTER TABLE session_handoffs ADD COLUMN ide TEXT;
ALTER TABLE session_handoffs ADD COLUMN branch TEXT;
ALTER TABLE session_handoffs ADD COLUMN capabilities TEXT DEFAULT '[]';
ALTER TABLE session_handoffs ADD COLUMN role TEXT;
ALTER TABLE session_handoffs ADD COLUMN last_activity TEXT;
```

### conductor_tasks (scoped by api_key_owner)

```sql
CREATE TABLE IF NOT EXISTS conductor_tasks (
    id TEXT PRIMARY KEY,
    api_key_owner TEXT NOT NULL,          -- scope: who owns this task
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    project_id TEXT,
    parent_task_id TEXT,
    created_by_agent TEXT,                -- agentId (not API key name)
    created_by_session TEXT,              -- session ID
    assigned_to_agent TEXT,               -- target agentId
    assigned_session_id TEXT,
    status TEXT DEFAULT 'pending'
        CHECK(status IN ('pending','assigned','accepted','in_progress','review','completed','failed','cancelled')),
    priority INTEGER DEFAULT 5,
    required_capabilities TEXT DEFAULT '[]',
    depends_on TEXT DEFAULT '[]',
    notify_on_complete TEXT DEFAULT '[]',
    notified_agents TEXT DEFAULT '[]',
    context TEXT DEFAULT '{}',
    result TEXT,
    completed_by TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    assigned_at TEXT,
    accepted_at TEXT,
    completed_at TEXT
);
```

## Dashboard /conductor (Updated)

### Active Agents panel

Only shows agents belonging to current user's API key scope.
Only shows agents with `last_activity` < 5 minutes.

```
Active Agents (3 online)

🟢 claude-mac-cortex          2s ago
   macOS · Claude CLI · cortex-hub@master

🟢 claude-vps-1               15s ago
   Windows · Claude CLI · my-backend@feat/extract

🟢 antigravity-mac            1m ago
   macOS · Antigravity · cortex-hub@master

🔴 cursor-win                 offline (2h ago)
   Windows · Cursor · my-backend@feat/ui
```

### Task creation scoped to user's agents

"Assign to" dropdown only shows agents under the same API key.

## Implementation Phases (Revised)

### Phase 1: Agent Identity in Sessions ← NEXT
- Enhance `cortex_session_start` to accept identity fields
- Store in `session_handoffs` table (new columns)
- Dashboard Sessions page shows full agent info
- Conductor shows only online agents (last_activity < 5min)

### Phase 2: Task Scope per API Key
- Add `api_key_owner` to conductor_tasks
- All task queries filter by owner
- Dashboard Conductor scoped to current user

### Phase 3: Agent Worker Daemon
- `scripts/cortex-worker.sh` — background task poller
- Spawns `claude -p` or `codex exec` for each task
- `install.sh --worker` option to start daemon
- Works with ALL IDEs (Claude, Codex, etc.)

### Phase 4: WebSocket Channel (v2)
- Separate WebSocket service alongside MCP
- Real-time bidirectional: task push + progress stream
- Agent SDK integration
- Dashboard live updates (no polling)

### Phase 5: Smart Orchestration
- Auto-suggest assignment based on capabilities + workload
- Task decomposition (AI breaks complex request into sub-tasks)
- Dependency graph visualization
- Cross-project task chains
