# /ce — Cortex End v3.0

> Version: 3.0 | Updated: 2026-04-10
> Changelog: v3.0 — session_end now auto-saves memory; removed STATE.md; streamlined steps
> Changelog: v2.0 — added detect_changes, tool stats, task completion, recipe capture check

Run ALL steps IN ORDER before ending the session.

## Step 1: Pre-commit Check
If uncommitted changes exist:
- `cortex_detect_changes(scope: "all")` — verify blast radius
- If HIGH risk → warn user before proceeding

## Step 2: Quality Gates
```bash
pnpm build && pnpm typecheck && pnpm lint
```
Record pass/fail for each.

## Step 3: Quality Report
```
cortex_quality_report(
  gate_name: "Session Quality",
  passed: <true if all gates pass>,
  score: <0-100>,
  details: "<build/typecheck/lint results>"
)
```

## Step 4: Complete Conductor Tasks
`cortex_task_list(status: "in_progress")` — find tasks worked on this session.
For each: `cortex_task_update(taskId, status: "completed", result: { summary: "..." })`

## Step 5: Store Knowledge (if applicable)
If this session involved any of these, call `cortex_knowledge_store`:
- Bug fix with non-obvious root cause
- Architecture decision or tradeoff
- Workflow pattern that worked well
- Error + solution that others might encounter

## Step 6: Store Memory
`cortex_memory_store` with:
- What was done this session
- Key decisions made
- Context for resuming next session
- Any user preferences discovered

## Step 7: End Session
```
cortex_session_end(
  sessionId: "<from session_start>",
  summary: "<concise: what was done, what's next>"
)
```
> The backend automatically saves this summary as searchable memory — a safety net even if Step 6 was skipped.

## Step 8: Final Report
```
## Session Complete
- **Work done**: <brief summary>
- **Quality gates**: build pass/fail | typecheck pass/fail | lint pass/fail
- **Knowledge stored**: <N docs> or none
- **Tasks completed**: <list> or none
- **Next steps**: <what should be done next session>
```
