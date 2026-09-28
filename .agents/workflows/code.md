---
description: Write code following project-specific quality gates from project-profile.json
---
# /code — Implement with Quality Gates

// turbo-all

## Trigger Patterns
- User says: "add X", "implement X", "thêm X", "làm X", "write X"
- Any request involving code changes

## Steps

### 1. Load Context
- Read `.cortex/project-profile.json` → verify commands + patterns
- Read `.cortex/code-conventions.md` → naming, imports, error handling
- Session context (memory/knowledge) is recalled once by `/cs` — don't repeat it per lookup

### 2. Locate the change, then plan

**Start from what you know, not from a fixed ladder:**

| You already know | Start with |
|---|---|
| A symbol name | `cortex_code_context(name)` — exact graph lookup, plus callers/callees/imports in one call |
| Only the behaviour | `cortex_code_search(query, limit: 10)` — ranked hybrid search, one call |
| An exact literal (env var, config key, error string) | `rg` / `grep` — this is not a ranking problem |
| A relationship across files | `cortex_cypher` |

**Search once, read all ten.** Measured on cortex-hub's own index (`benchmarks/retrieval_bench.ts`,
n=15): the target file is in the top 10 for 15/15 queries but at rank 1 for only 8/15. So scan
the whole result set, and never re-run a reworded version of the same query — recall@10 is
already 1.000, so it returns the same set. Ask a different question or switch tool instead.

**Knowledge and memory are for errors and decisions, not for locating code.** Recall them once
at session start, then when something breaks — not before every lookup.

`cortex_code_impact` before editing something exported or shared; `cortex_changes` before
touching a file another agent may hold.

Then plan:
- Identify files to create/modify
- Check conventions: camelCase vars, PascalCase types, @cortex/* imports
- **Get user approval before proceeding** (unless trivial fix)

### 3. Execute

Write code following project conventions:
- `camelCase` for variables/functions
- `PascalCase` for types/components
- `@cortex/*` path aliases (never relative cross-package)
- No `any` without explicit comment

During execution:
- Before editing a core file → `cortex_code_impact` on target
- Before committing → `cortex_detect_changes` to assess risk
- Hit an error → `cortex_knowledge_search` first, debug second
- Fixed non-obvious bug → `cortex_knowledge_store` the solution

### 4. Verify (MANDATORY)
ALL must pass before committing:
// turbo
```bash
pnpm build
```
// turbo
```bash
pnpm typecheck
```
// turbo
```bash
pnpm lint
```

> Always `pnpm build` (full build, never `--filter`).

### 5. Fix Issues
If verify fails:
- `cortex_knowledge_search` the error first
- Fix and re-run ALL verify commands
- Non-obvious fix → `cortex_knowledge_store`
- Max retries: 2

### 6. Commit & Push
- `git commit` with conventional prefix: `feat:`, `fix:`, `docs:`, `chore:`
- `git push`

### 7. Report & Close (MANDATORY)
- `cortex_quality_report` — report gate results
- `cortex_memory_store` — persist session learnings
- Non-obvious bug fix → `cortex_knowledge_store`

```
## Quality Report
- Build: pass/fail | Typecheck: pass/fail | Lint: pass/fail
- Files changed: N
- Cortex tools used: code_search | memory | impact | knowledge | detect_changes
```
