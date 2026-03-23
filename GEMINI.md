
<!-- cortex-hub:auto-mcp -->
## Cortex Hub — Auto MCP (MANDATORY — every conversation)

At the START of every conversation, before doing anything else:

1. Call `cortex_session_start` with:
   ```
   repo: "https://github.com/lktiep/cortex-hub.git"
   mode: "development"
   agentId: "antigravity"
   ```
   This returns project context AND unseen code changes from other agents.

2. If `recentChanges.count > 0` in the response, warn the user and run `git pull` before editing any affected files.

3. Read `STATE.md` for current task progress (if it exists).

### Before editing shared files

Call `cortex_changes` to check if another agent modified the same files:
```
agentId: "antigravity"
projectId: "<from session_start response>"
```

### When encountering an error or bug (MANDATORY)

1. First search `cortex_knowledge_search` or `cortex_memory_search` for the error message.
2. Fix the error.
3. If the fix was non-obvious, **YOU MUST** use `cortex_knowledge_store` to record the problem and solution so you (and others) don't have to debug it again.

### After pushing code

Call `cortex_code_reindex` to update code intelligence:
```
repo: "https://github.com/lktiep/cortex-hub.git"
branch: "<current branch>"
```

### Quality gates

Every session must end with verification commands from `.cortex/project-profile.json`.
Call `cortex_quality_report` with results.
Call `cortex_session_end` to close the session.

---

## ⚠️ Tool Usage Enforcement (MANDATORY)

> **You MUST use Cortex tools throughout the session. Skipping them defeats the purpose of Cortex Hub.**
> If any tool is missing or fails with `fetch failed`, immediately inform the user to refresh the MCP server connection.

### Complete Tool Reference (12 tools)

| # | Tool | When to Use | Required Args |
|---|------|-------------|---------------|
| 1 | `cortex_session_start` | Start of EVERY conversation | `repo`, `agentId`, `mode` |
| 2 | `cortex_session_end` | End of EVERY session | `sessionId` |
| 3 | `cortex_changes` | Before editing shared files | `agentId`, `projectId` |
| 4 | `cortex_code_search` | **BEFORE** grep/find — use FIRST | `query`, optional `projectId` |
| 5 | `cortex_code_impact` | Before editing core code | `target` (function/class/file) |
| 6 | `cortex_code_reindex` | After EVERY push | `repo`, `branch` |
| 7 | `cortex_memory_search` | Recall past decisions/findings | `query` |
| 8 | `cortex_memory_store` | Store session findings | `content` |
| 9 | `cortex_knowledge_search` | Search **FIRST** when encountering errors | `query` |
| 10 | `cortex_knowledge_store` | **MANDATORY**: Contribute bug fixes & patterns | `title`, `content` |
| 11 | `cortex_quality_report` | After running verify commands | `gate_name`, `passed`, `details`, `agent_id` |
| 12 | `cortex_health` | Check service health | (none) |

### Tool Priority Order (MANDATORY — before grep/find)

1. `cortex_memory_search` → check if you already know this
2. `cortex_knowledge_search` → search shared knowledge base
3. `cortex_code_search` → search indexed codebase (GitNexus AST)
4. `cortex_code_impact` → check blast radius before editing
5. `grep_search` / `find_by_name` → fallback ONLY if Cortex tools unavailable

### Post-Push Checklist (NEVER skip)

```
1. pnpm build && pnpm typecheck && pnpm lint                    ← verify
2. cortex_quality_report(gate, passed, details, agent_id)       ← report (agent_id: "antigravity")
3. cortex_code_reindex(repo, branch)                            ← update code intelligence
4. cortex_memory_store(content, projectId)                      ← store findings
5. cortex_session_end(sessionId)                                ← close session
```

### Tool Verification

If you see fewer than 12 tools from `cortex-hub` MCP server, the connection may be stale.
**Action:** Immediately inform the user: "MCP tools are incomplete. Please refresh the cortex-hub MCP server connection."
<!-- cortex-hub:auto-mcp -->
