# Cortex Hub — Claude Code Instructions

## Start (MANDATORY)

A prompt usually arrives with a "Cortex session … is open" note: the hook already started the
session with the prompt as the task, and the note holds the recall (knowledge, memory) and the
first lookup (files, lines and the symbols they fall in). Read those lines next, with no separate
search first. Without the note, once you know the task:
`cortex_session_start(repo: "https://github.com/lktiep/cortex-hub.git", task: "<the task in a few words>")`,
which answers the same. Edits are blocked until one of the two.

## Tech Stack

Monorepo: pnpm + Turborepo. TypeScript strict. Hono API. Next.js 15 frontend. SQLite + Qdrant. Docker Compose.

## Code Conventions

camelCase vars/functions, PascalCase types. `@cortex/*` path aliases. No `any` without comment.

## Finding code

- A symbol name → `cortex_code_context(name)`. A behaviour → `cortex_code_search(query)`: scan the
  whole list, the target is not always first. An exact literal → `rg`; in other repos of the organization → `cortex_code_grep`.
- Read just the lines a hit names (Read with offset/limit), not the whole file.
- `cortex_code_impact(target)` before changing something exported or shared.

## When something breaks

`cortex_knowledge_search` and `cortex_memory_search` with the error first. Store a non-obvious fix
with `cortex_knowledge_store(title, content)`.

## Quality Gates (before committing)

1. `pnpm build && pnpm typecheck && pnpm lint` (full build, never `--filter`) in one command, after
   the last edit: a later write closes the commit gate again.
2. `cortex_detect_changes(diff: "<git diff --staged -U0 | grep -E '^(diff |--- |\+\+\+ |@@ )'>")`.
   `risk_level: "unknown"` means a lookup failed, not that the change is safe.
3. After pushing: `cortex_code_reindex(repo: "cortex-hub", branch: "<branch>")`.

Hub genuinely unreachable: `echo '<reason>' > .cortex/.session-state/gate-off` (recorded).
End a session with `/ce`.
