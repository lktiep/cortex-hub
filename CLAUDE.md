# Cortex Hub — Claude Code Instructions

## Quick Start (MANDATORY)

Run `/cs` at the start of every conversation. This initializes the session, recalls context from previous sessions, and checks for conflicts. **Editing is blocked until this completes.**

If `/cs` is unavailable, run manually:
1. `cortex_session_start(repo: "cortex-hub", mode: "development", agentId: "claude-code")`
2. `cortex_knowledge_search(query: "session summary progress next session")`
3. `cortex_memory_search(query: "session context decisions lessons")`
4. `cortex_task_pickup()` — check for assigned tasks

## Tech Stack

Monorepo: pnpm + Turborepo. TypeScript strict. Hono API. Next.js 15 frontend. SQLite + Qdrant. Docker Compose.

## Code Conventions

camelCase vars/functions, PascalCase types. `@cortex/*` path aliases. No `any` without comment.

## Finding code fast

Don't run a fixed ladder of tools. Start from what you already know and take the shortest
path to the line you need to change:

| You already know | Start with | Why this one |
|---|---|---|
| A symbol name (`buildHybridQuery`, `HybridSearch`) | `cortex_code_context(name)` | Exact graph lookup — no ranking to get wrong — and it answers callers, callees and imports in one call |
| Only the behaviour ("where do we verify API keys?") | `cortex_code_search(query, limit: 10)` | Ranked hybrid search over the index. One call, then read the list |
| An exact literal (env var, config key, error string, magic number) | `rg` / `grep` | Not a ranking problem. Lexical search alone ranks *worse* than vector on questions (r@1 0.267 vs 0.533) but is exactly right for a string that either appears or does not |
| A relationship ("who calls X across packages") | `cortex_cypher` | One graph query instead of N searches |
| Whether someone else is in this file | `cortex_changes` | Before editing anything shared |

### Search once, then read the whole set

Measured on this repo's own index (`benchmarks/retrieval_bench.ts`, hand-written gold set,
n=15): the target file is in the **top 10 for 15/15** queries, top 3 for 11/15, and at
**rank 1 for only 8/15**. Two rules follow from that, and they are the difference between
finding the spot in one call and spending five:

- **Scan all ten hits before choosing.** Acting on hit #1 alone is wrong about four times
  in ten.
- **Don't re-search the same question.** Recall@10 is 1.000, so a reworded query returns
  the same set for another round trip. If nothing fits, ask a *different* question or
  switch tool — don't paraphrase.

### The rest of the toolbox

- `cortex_code_impact(target)` — before editing something exported or shared. Not a ritual
  for every file.
- `cortex_cypher(query: "MATCH ...")` — when you need exact relationships rather than a ranking.
- **Knowledge and memory are for errors and decisions, not for locating code.** `/cs` recalls
  them once at session start; calling them again before each lookup costs two round trips and
  answers a different question. Reach for them the moment something breaks, or when you need
  to know *why* the code is the way it is.

### When you hit an error
1. `cortex_knowledge_search(query: "<error message>")` — someone may have solved this already
2. `cortex_memory_search(query: "<error context>")` — you may have seen this before
3. Fix the error
4. If the fix was non-obvious: `cortex_knowledge_store(title: "<fix>", content: "<steps>")`

### Sharing what you learn
- `cortex_memory_store(content: "...")` — personal recall for future sessions
- `cortex_knowledge_store(title: "...", content: "...")` — team-wide (bug fixes, patterns, decisions)

### Before committing
`cortex_detect_changes(scope: "staged")` — shows affected symbols and risk level.

### After pushing
`cortex_code_reindex(repo: "cortex-hub", branch: "<branch>")` — keeps code intelligence fresh.

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

## What the hooks actually block

`.claude/hooks/` gates tools on recorded evidence of cortex calls (see `scripts/test-hooks.sh`):

- No `cortex_session_start` → every `Edit`, `Write` and file-modifying Bash command is refused.
- Session started but no discovery call yet → `Grep`, `Glob` and a `grep`/`rg`/`find` that
  *starts* a command are refused. A `grep` after a pipe (filtering another command's output)
  is fine.
- Editing before `cortex_knowledge_search` **and** `cortex_memory_search` → refused. This
  covers `cat > file` and `sed -i` too, not just the Edit tool.
- `git commit` without discovery and without build/typecheck/lint passing → refused. Calling
  `cortex_quality_report` does not substitute for the gates.
- Markers live in `.cortex/.session-state/` and must contain `tool=` evidence written by the
  PostToolUse hook — an empty file does not open a gate.
- If the hub is genuinely unreachable, the gates have no path through them. Say so and
  declare it: `echo '<reason>' > .cortex/.session-state/gate-off`. It is recorded in the
  session summary.
