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
- Read `STATE.md` → current phase + active tasks
- Read `.cortex/project-profile.json` → verify commands + patterns
- Read `.cortex/code-conventions.md` → naming, imports, error handling

### 2. Plan
- Identify files to create/modify/delete
- Check conventions: camelCase vars, PascalCase types, @cortex/* imports
- Create implementation plan
- **Get user approval before proceeding** (unless trivial fix)

### 3. Execute
Write code following project conventions:
- ✅ `camelCase` for variables/functions
- ✅ `PascalCase` for types/components
- ✅ `@cortex/*` path aliases (never relative cross-package)
- ✅ Custom `CortexError` classes for errors
- ✅ No `any` without explicit comment
- ✅ Co-located tests: `foo.ts` → `foo.test.ts`

### 4. Verify (MANDATORY — from .cortex/project-profile.json)
Run ALL verify commands. ALL must pass before committing:
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

> ⚠️ ALWAYS run `pnpm build` (FULL build). NEVER use `--filter`.
> The pre-commit hook (Lefthook) will BLOCK the commit if these fail.

### 5. Fix Issues
If any verify step fails:
- Fix the issue
- Re-run ALL verify commands (not just the failed one)
- Continue until all pass
- Max retries: 2

### 6. Commit & Push
- Update `STATE.md` with progress
- `git commit` → Lefthook pre-commit runs automatically
- `git push` → Lefthook pre-push double-checks
- Conventional prefix: `feat:`, `fix:`, `docs:`, `chore:`

### 7. Report
```
## Quality Report
- Build: ✅/❌ | Typecheck: ✅/❌ | Lint: ✅/❌
- Files changed: N
- Conventions followed: ✅
```
