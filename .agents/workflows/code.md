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
- `cortex_memory_search` → recall past decisions or gotchas related to this topic

### 2. Research & Plan

Use cortex tools to understand the codebase before writing code:
1. `cortex_code_search` → find where the relevant pattern exists
2. `cortex_code_context` → understand callers/callees of symbols you'll change
3. `cortex_code_impact` → check what breaks if you change these files
4. `cortex_knowledge_search` → any documented patterns or known issues
5. grep/find → fallback only if cortex returns nothing

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
