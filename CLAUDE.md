# Cortex Hub — Claude Code Instructions

## Auto MCP (MANDATORY — every conversation)

At the START of every conversation, before doing anything else:

1. Call `cortex_session_start` with:
   ```
   repo: "https://github.com/lktiep/cortex-hub"
   mode: "development"
   agentId: "claude-code"
   ```
   This returns project context AND unseen code changes from other agents.

2. If `recentChanges.count > 0` in the response, warn the user and run `git pull` before editing any affected files.

3. Call `cortex_knowledge_search` with query "session summary current progress next session" to find latest project progress stored by previous sessions. Also call `cortex_memory_search` to recall agent-specific context.

## Before editing shared files

Call `cortex_changes` to check if another agent modified the same files:
```
agentId: "claude-code"
projectId: "<from session_start response>"
```

## After pushing code

Call `cortex_code_reindex` to update code intelligence:
```
repo: "https://github.com/lktiep/cortex-hub"
branch: "<current branch>"
```

## Ending a session

When the conversation is finishing, call `cortex_session_end` to close the session:
```
sessionId: "<sessionId from session_start response>"
summary: "<brief summary of work done>"
```
This prevents stale sessions from accumulating.

## Quality gates

Every session must end with:
- `pnpm build && pnpm typecheck && pnpm lint`
- Call `cortex_quality_report` with results
- Call `cortex_session_end` to close the session

## Tech stack

Monorepo: pnpm + Turborepo. TypeScript strict. Hono API. Next.js 15 frontend. SQLite + Qdrant. Docker Compose.

## Code conventions

camelCase vars/functions, PascalCase types. `@cortex/*` path aliases. No `any` without comment.

<!-- cortex-hub:auto-mcp -->
## Cortex Hub — MANDATORY (enforced by hooks — violations are BLOCKED)

**YOUR FIRST ACTION in every conversation MUST be running `/cs` (Cortex Start v2.0).**
This runs all mandatory init steps: session_start, knowledge recall, memory recall, task pickup, detect changes, and workflow activation.
If you skip this, all Edit/Write/file-modifying Bash commands will return exit code 2 (BLOCKED).

**If `/cs` is unavailable**, run these steps manually IN ORDER:
1. `cortex_session_start(repo: "https://github.com/lktiep/cortex-hub.git", mode: "development", agentId: "claude-code")`
2. `cortex_knowledge_search(query: "session summary progress next session")`
3. `cortex_memory_search(query: "session context decisions lessons")`
4. `cortex_task_pickup()` — check for assigned tasks
5. Summarize findings and confirm with user before starting work

**Hooks enforce**: Edit/Write BLOCKED until knowledge_search AND memory_search called.
**Commit BLOCKED** until discovery tools used AND quality gates passed.

### Agent Identity (send with session_start if available)

Read `.cortex/agent-identity.json` and pass identity fields:
```
cortex_session_start(
  repo: "https://github.com/lktiep/cortex-hub.git",
  mode: "development",
  agentId: "claude-code",
  hostname: "<from agent-identity.json>",
  os: "<from agent-identity.json>",
  ide: "claude-code-cli",
  branch: "<current git branch>",
  role: "<from agent-identity.json>",
  capabilities: ["<from agent-identity.json>"]
)
```
This helps Dashboard identify which agent you are across multiple IDEs/machines.

### Tool Priority (MANDATORY — use cortex tools BEFORE grep/find)

**ALWAYS search with cortex tools first. Only use Grep/find as fallback.**
Hooks will remind you if you use Grep before cortex discovery tools.

1. `cortex_memory_search` — check if you already know this from previous sessions
2. `cortex_knowledge_search` — search the shared knowledge base
3. `cortex_code_search` — AST-aware indexed search (better than grep, saves tokens)
4. `cortex_code_context` — understand callers/callees of a symbol
5. `cortex_code_impact` — check blast radius before editing
6. Grep / find — **ONLY if cortex tools are unavailable or return no results**

### Before editing shared files

Call `cortex_changes` to check if another agent modified the same files.

### When encountering an error or bug

1. **FIRST** search `cortex_knowledge_search` — someone may have solved this already
2. **THEN** `cortex_memory_search` — you may have seen this before
3. Fix the error
4. Non-obvious fixes: **YOU MUST** call `cortex_knowledge_store` to record the solution

### After pushing code

Call `cortex_code_reindex` to update code intelligence:
```
repo: "https://github.com/lktiep/cortex-hub.git"
branch: "<current branch>"
```

### Quality gates (enforced — commit blocked without these)

Every session must end with verification commands from `.cortex/project-profile.json`.
Call `cortex_quality_report` with results. Call `cortex_session_end` to close the session.
**Commits are BLOCKED by hooks until quality gates pass.**

### Compliance Enforcement (Automated)

Your tool usage is **automatically tracked and scored**:

1. **Session Compliance Score** — `cortex_session_end` returns a grade (A/B/C/D) based on 5-category tool coverage.
2. **MCP Response Hints** — Every tool response includes adaptive hints about what to use next.
<!-- cortex-hub:auto-mcp -->
