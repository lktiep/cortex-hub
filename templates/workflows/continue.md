---
description: Resume work using cortex memory recall, auto-triggered by "continue", "tiếp", "go", or when no specific command given
---
<!-- cortex-workflows-version: 3 -->
# /continue — Resume Current Work

// turbo-all

## Trigger Patterns
- User says: "continue", "tiếp", "go", "tiếp tục", "resume"
- User pastes a follow-up without specific command

## Steps

### 1. Start Session (MANDATORY)
```
cortex_session_start({ repo: "<current repo URL>", mode: "development", agentId: "<your agent id>" })
```
Save `sessionId` for session close at end.

### 2. Recall Context
Call both in parallel:
- `cortex_memory_search(query: "session summary progress decisions")` — what was done last time
- `cortex_knowledge_search(query: "current progress next steps")` — any stored project notes

From the results, identify:
- What was being worked on
- Key decisions made
- What should be done next

### 3. Resume Task
Continue the identified task. Use cortex tools naturally during work:

| Situation | Tool |
|-----------|------|
| Find code | `cortex_code_search` first, grep as fallback |
| Before editing shared code | `cortex_code_impact` on target symbol |
| Before committing | `cortex_detect_changes` to assess risk |
| Hit a compilation error | `cortex_knowledge_search` the error first |
| Fixed a non-obvious bug | `cortex_knowledge_store` the solution (MANDATORY) |
| Learned something useful | `cortex_memory_store` for next session |

### 4. Verify (MANDATORY)
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

### 5. Fix Issues
If verify fails:
- `cortex_knowledge_search` the error — maybe it's known
- Fix and re-run ALL verify commands
- If fix was non-obvious → `cortex_knowledge_store`

### 6. Report & Close (MANDATORY)
- `cortex_quality_report` — report build/typecheck/lint results
- `cortex_memory_store` — persist what was done, decisions, next steps
- `cortex_session_end` — close session with summary (auto-saves to memory)

```
## Session Summary
- Task: [what was done]
- Build: pass/fail | Typecheck: pass/fail | Lint: pass/fail
- Cortex tools used: code_search | memory | knowledge | impact | detect_changes | quality_report
```
