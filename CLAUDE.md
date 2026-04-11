# Cortex Hub — Claude Code Instructions

## Quick Start (MANDATORY)

Run `/cs` at the start of every conversation. This initializes the session, recalls context from previous sessions, and checks for conflicts. **Editing is blocked until this completes.**

If `/cs` is unavailable, run manually:
1. `cortex_session_start(repo: "https://github.com/lktiep/cortex-hub.git", mode: "development", agentId: "claude-code")`
2. `cortex_knowledge_search(query: "session summary progress next session")`
3. `cortex_memory_search(query: "session context decisions lessons")`
4. `cortex_task_pickup()` — check for assigned tasks

## Tech Stack

Monorepo: pnpm + Turborepo. TypeScript strict. Hono API. Next.js 15 frontend. SQLite + Qdrant. Docker Compose.

## Code Conventions

camelCase vars/functions, PascalCase types. `@cortex/*` path aliases. No `any` without comment.

## How to Use Cortex Tools

Cortex tools replace grep/find with smarter alternatives. Use them naturally as part of your workflow:

### Finding code
Use `cortex_code_search` instead of grep. It understands AST structure and returns focused results (~90% fewer tokens than raw grep). Fall back to grep only if it returns nothing.

### Understanding code
- `cortex_code_context(name: "functionName")` — see who calls it, what it calls, what imports it
- `cortex_code_impact(target: "symbolName")` — check blast radius before editing
- `cortex_cypher(query: "MATCH ...")` — advanced graph queries when you need exact relationships

### Before editing shared files
Call `cortex_changes(agentId: "claude-code", projectId: "<from session>")` to check if another agent touched the same files.

### When you hit an error
1. `cortex_knowledge_search(query: "<error message>")` — someone may have solved this already
2. `cortex_memory_search(query: "<error context>")` — you may have seen this before
3. Fix the error
4. If the fix was non-obvious: `cortex_knowledge_store(title: "<fix>", content: "<steps>")` — save it so nobody debugs this again

### Sharing what you learn
- `cortex_memory_store(content: "...")` — personal recall for future sessions (decisions, gotchas, context)
- `cortex_knowledge_store(title: "...", content: "...")` — team-wide knowledge (bug fixes, patterns, architecture decisions)

### Before committing
`cortex_detect_changes(scope: "staged")` — shows affected symbols and risk level.

### After pushing
`cortex_code_reindex(repo: "https://github.com/lktiep/cortex-hub.git", branch: "<branch>")` — keeps code intelligence fresh.

### Cross-project lookup
Use `repo:` parameter directly:
```
cortex_code_search(query: "user auth", repo: "my-backend")
cortex_code_context(name: "validateToken", repo: "my-backend")
```

## Ending a Session

Run `/ce` or manually:
1. `pnpm build && pnpm typecheck && pnpm lint`
2. `cortex_quality_report` with results
3. `cortex_memory_store` with session context (what was done, key decisions, next steps)
4. `cortex_session_end(sessionId, summary)` — this also auto-saves the summary as searchable memory

## Quality Gates

Every session must pass before committing:
- `pnpm build` (full build, never `--filter`)
- `pnpm typecheck`
- `pnpm lint`
