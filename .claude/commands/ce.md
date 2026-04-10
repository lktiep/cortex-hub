# /ce — Cortex End v2.0

> Version: 2.0 | Updated: 2026-04-06
> Changelog: v2.0 — added detect_changes, tool stats, task completion, recipe capture check, code reindex, versioning

Run ALL steps IN ORDER before ending the session.

## Step 1: Pre-commit Risk Analysis
If there are uncommitted changes:
- Call `cortex_detect_changes(scope: "all")` — verify blast radius
- Report affected symbols and risk level
- If HIGH risk → warn user before proceeding

## Step 2: Quality Gates
Run verification:
```bash
pnpm build && pnpm typecheck && pnpm lint
```
Record pass/fail for each.

## Step 3: Quality Report
Call `cortex_quality_report`:
```
gate_name: "Session Quality"
passed: <true if all gates pass>
score: <0-100 based on results>
details: "<build/typecheck/lint results summary>"
```
This auto-tracks knowledge feedback (completion/fallback counters).

## Step 4: Complete Conductor Tasks (auto-detect)
Call `cortex_task_list(status: "in_progress")` to find any tasks assigned to this agent.
For EACH task that was worked on this session:
```
cortex_task_update(taskId: "<id>", status: "completed", result: { summary: "<what was done>" })
```
This triggers recipe auto-capture — the completed task's execution log is analyzed
by LLM and stored as a reusable recipe if non-trivial.

## Step 5: Store Knowledge (if applicable)
If this session involved ANY of these, call `cortex_knowledge_store`:
- Bug fix with non-obvious root cause
- Architecture decision or tradeoff
- Workflow pattern that worked well
- Error + solution that others might encounter
- Cross-project discovery worth remembering

Include tags: `["session-summary", "<relevant-tags>"]`

## Step 6: Store Memory
Call `cortex_memory_store` with:
- Key decisions made this session
- Lessons learned
- Context that would help resume next session
- Any user preferences discovered

## Step 7: Tool Usage Compliance
Call `cortex_tool_stats(days: 1, agentId: "claude-code")` to check this session's tool usage.
Flag if any critical tools were underused:
- `code_search` — should be used before editing
- `code_impact` — should be used before editing shared code
- `knowledge_search` — should be used when hitting errors
- `detect_changes` — should be used before commits

## Step 8: Code Reindex (if code was pushed)
If code was pushed to remote this session:
```
cortex_code_reindex(repo: "https://github.com/lktiep/cortex-hub.git", branch: "<current branch>")
```

## Step 9: Recipe Capture Check
Check if recipe capture fired this session. If you can, note whether:
- Session summary is substantial enough (>50 chars) for auto-capture
- Any tasks completed should trigger recipe capture
This is informational — capture happens automatically, but good to verify.

## Step 10: End Session
Call `cortex_session_end`:
```
sessionId: "<from session_start>"
summary: "<concise summary: what was done, what's next>"
```

## Step 11: Final Report
Print session summary:

```
## Session Complete
- **Work done**: <brief summary>
- **Quality gates**: build ✓/✗ | typecheck ✓/✗ | lint ✓/✗
- **Compliance**: <grade from session_end>
- **Knowledge stored**: <N docs> or none
- **Recipe captures**: <triggered/not triggered>
- **Tasks completed**: <list> or none
- **Next steps**: <what should be done next session>
```
