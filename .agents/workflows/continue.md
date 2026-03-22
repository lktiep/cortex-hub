---
description: Resume work from STATE.md context, auto-triggered by "continue", "tiếp", "go", or when no specific command given
---
# /continue — Resume Current Work

// turbo-all

## Trigger Patterns
- User says: "continue", "tiếp", "go", "tiếp tục", "resume"
- User pastes a follow-up without specific command

## Steps

### 1. Start Session (MANDATORY)
Call the `cortex_session_start` MCP tool with the current repo URL and mode:
```
cortex_session_start({ repo: "<current repo URL>", mode: "development" })
```
This creates a session record and returns project context. If it fails or hangs, note the error and continue.

### 2. Load Context
Read `STATE.md` at project root. Identify:
- Current active phase
- First `[/]` (in-progress) task, or first `[ ]` uncompleted task
- Recent decisions that affect current work

### 2. Load Project Profile
Read `.forgewright/project-profile.json` → note `verify.pre_commit` commands.

### 3. Resume Task
Continue the identified task. Follow the appropriate workflow:
- If task is code implementation → follow `/code` workflow
- If task is infrastructure → follow direct execution
- If task is documentation → write directly

### 4. Post-Work Verification
Run ALL commands from `project-profile.json` → `verify.pre_commit`:
// turbo
```bash
pnpm build --filter='@cortex/shared-*'
```
// turbo
```bash
pnpm typecheck
```
// turbo
```bash
pnpm lint
```

### 5. Update STATE.md
- Mark completed tasks `[x]`
- Add new decisions if any
- Update blockers

### 6. Report
```
## Session Summary
- Task: [what was done]
- Build: ✅/❌ | Typecheck: ✅/❌ | Lint: ✅/❌
- STATE.md updated: ✅
```
