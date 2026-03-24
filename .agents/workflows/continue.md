---
description: Resume work from STATE.md context, auto-triggered by "continue", "tiếp", "go", or when no specific command given
---
<!-- cortex-workflows-version: 2 -->
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
Save the returned `sessionId` — needed for session close at end.
If it fails or hangs, note the error and continue.

### 2. Recall Context (Cortex-First)

> ⚠️ **Use Cortex tools FIRST. Only fall back to reading files if Cortex tools return no results.**

1. **`cortex_memory_search`** → "What was I working on last time?"
2. **`cortex_knowledge_search`** → "Any known issues or patterns related to the current task?"
3. Read `STATE.md` → Identify:
   - Current active phase
   - First `[/]` (in-progress) task, or first `[ ]` uncompleted task
   - Recent decisions that affect current work

### 3. Load Project Profile
Read `.cortex/project-profile.json` → note `verify.pre_commit` commands.

### 4. Resume Task
Continue the identified task. Follow the appropriate workflow:
- Code implementation → follow `/code` workflow (Steps 2-3)
- Infrastructure → follow direct execution
- Documentation → write directly

**During work — Cortex inline rules:**

| Situation | Action |
|-----------|--------|
| Need to find code | `cortex_code_search` FIRST, then `grep_search` as fallback |
| Before editing core file | `cortex_code_impact` on target symbol/file |
| Before committing | `cortex_detect_changes` to assess risk level of changes |
| Complex dependency question | `cortex_cypher` with Cypher queries on the knowledge graph |
| Hit a compilation error | `cortex_knowledge_search("error message")` FIRST |
| Fixed a non-obvious bug | `cortex_knowledge_store(title, problem, solution)` MANDATORY |
| Learned something new | `cortex_memory_store(content)` to persist for next session |

### 5. Post-Work Verification (MANDATORY)
Run ALL commands from `project-profile.json` → `verify.pre_commit`:
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

### 6. Fix Issues
If any verify step fails:
- **`cortex_knowledge_search`** the error first — maybe it's a known issue
- Fix the issue
- Re-run ALL verify commands
- If fix was non-obvious → **`cortex_knowledge_store`**

### 7. Update STATE.md
- Mark completed tasks `[x]`
- Mark in-progress tasks `[/]`
- Add new decisions if any
- Update blockers

### 8. Report & Learn (MANDATORY — never skip)
- **`cortex_quality_report`** → report build/typecheck/lint results
- **`cortex_memory_store`** → persist session learnings
- **`cortex_session_end`** → close the session with summary

```
## Session Summary
- Task: [what was done]
- Build: ✅/❌ | Typecheck: ✅/❌ | Lint: ✅/❌
- STATE.md updated: ✅
- Cortex tools used: code_search ✅/❌ | memory ✅/❌ | knowledge ✅/❌ | impact ✅/❌ | detect_changes ✅/❌ | quality_report ✅/❌
```
