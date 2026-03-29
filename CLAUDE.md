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

3. Read `STATE.md` for current task progress.

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
## Cortex Hub — Auto MCP (MANDATORY — every conversation)

At the START of every conversation, before doing anything else:

1. Call `cortex_session_start` with:
   ```
   repo: "https://github.com/lktiep/cortex-hub.git"
   mode: "development"
   agentId: "claude-code"
   ```
   This returns project context AND unseen code changes from other agents.

2. If `recentChanges.count > 0` in the response, warn the user and run `git pull` before editing any affected files.

3. Read `STATE.md` for current task progress (if it exists).

### Before editing shared files

Call `cortex_changes` to check if another agent modified the same files:
```
agentId: "claude-code"
projectId: "<from session_start response>"
```

### When encountering an error or bug (MANDATORY)

1. First search `cortex_knowledge_search` or `cortex_memory_search` for the error message.
2. Fix the error.
3. If the fix was non-obvious, **YOU MUST** use `cortex_knowledge_store` to record the problem and solution so others do not have to debug it again.

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

### Compliance Enforcement (Automated)

Your tool usage is **automatically tracked and scored**:

1. **Session Compliance Score** — `cortex_session_end` returns a grade (A/B/C/D) based on 5-category tool coverage.
2. **MCP Response Hints** — Every tool response includes adaptive hints about what to use next.
<!-- cortex-hub:auto-mcp -->
