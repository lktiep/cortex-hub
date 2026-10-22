# Cortex Hub — Claude Code Instructions

## Start (MANDATORY)

Once you know the task, make one call:

```
cortex_session_start(repo: "https://github.com/lktiep/cortex-hub.git", task: "<the task in a few words>")
```

Its answer holds what the hub recalls for the task (knowledge and memory) and the files and line
ranges to read, with the symbols in them. That is the recall and the first lookup: there is no
separate knowledge, memory or code search to run before editing, and no `/cs` to run first.
A hook adds the conversation id, branch and IDE. Edits are blocked until this call is made.

## Tech Stack

Monorepo: pnpm + Turborepo. TypeScript strict. Hono API. Next.js 15 frontend. SQLite + Qdrant. Docker Compose.

## Code Conventions

camelCase vars/functions, PascalCase types. `@cortex/*` path aliases. No `any` without comment.

## Finding code fast

| You already know | Start with |
|---|---|
| A symbol name | `cortex_code_context(name)` — exact graph lookup, with callers and callees |
| Only the behaviour | `cortex_code_search(query)` — ranked files, line ranges and the symbols in them |
| An exact literal (env var, config key, error string) | `rg` / `grep` |
| A relationship across files | `cortex_cypher` |

- Read the lines a hit names (Read with offset/limit), not the whole file.
- The target is in the top 10 for every query of the retrieval benchmark but first for only half:
  scan the whole list, and ask a different question rather than a reworded one.
- Omit `repo:` to search every repo of the organization; `cortex_list_repos()` shows which.
- `cortex_code_impact(target)` before changing something exported or shared;
  `cortex_changes` before editing a file another agent may hold.

## When something breaks

Search `cortex_knowledge_search(query: "<the error>")` and `cortex_memory_search` first. If the fix
was not obvious, store it: `cortex_knowledge_store(title, content)`.

## Quality Gates (before committing)

1. `pnpm build && pnpm typecheck && pnpm lint` (full build, never `--filter`), in one command, last.
2. `cortex_detect_changes(diff: "<git diff --staged -U0 | grep -E '^(diff |--- |\+\+\+ |@@ )'>")`.
   `risk_level: "unknown"` means a lookup failed, not that the change is safe.
3. After pushing: `cortex_code_reindex(repo: "cortex-hub", branch: "<branch>")`.

## What the hooks block

- No `cortex_session_start` → `Edit`, `Write` and file-modifying Bash are refused.
- No discovery yet (a start with `task`, or a code search/context/impact/cypher call) → `Grep`,
  `Glob` and a command that starts with `grep`/`rg`/`find` are refused.
- No recall (a start with `task`, or knowledge and memory searches) → every write is refused.
- `git commit` needs build, typecheck and lint to have passed after the last write.
- Hub genuinely unreachable: `echo '<reason>' > .cortex/.session-state/gate-off` (recorded).

## Ending a Session

Run `/ce`, or: `cortex_memory_store` what was done and what is next, then
`cortex_session_end(sessionId, summary)`.
