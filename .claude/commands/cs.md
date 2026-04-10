# /cs — Cortex Start v3.0

> Version: 3.0 | Updated: 2026-04-10
> Changelog: v3.0 — removed STATE.md dependency, streamlined tool guidance, auto-memory safety net
> Changelog: v2.1 — added plan quality gate before implementation
> Changelog: v2.0 — added task pickup, detect changes, recipe health, workflow recipes, versioning

Run ALL steps IN ORDER. Do NOT proceed to user work until Step 7 completes.

## Step 1: Session Start
Call `cortex_session_start`:
```
repo: "https://github.com/lktiep/cortex-hub.git"
mode: "development"
agentId: "claude-code"
ide: "<your IDE>"
branch: "<current git branch>"
```
Save `session_id` and `projectId` from the response.
If `recentChanges.count > 0` → warn user and `git pull` before any edits.

## Step 2: Recall Context (parallel)
Call BOTH in parallel:
- `cortex_knowledge_search(query: "session summary progress next session")`
- `cortex_memory_search(query: "session context decisions lessons", agentId: "claude-code")`

These return what was done last session, key decisions, and next steps.

## Step 3: Conflict Check
`cortex_changes(agentId: "claude-code", projectId: "<from step 1>")`

## Step 4: Task Pickup
`cortex_task_pickup()` — check for Conductor tasks assigned to you.
If tasks exist → list them. Ask user which to work on, or continue with their request.

## Step 5: Working State Check
Run `git status`. If uncommitted changes:
- `cortex_detect_changes(scope: "all")` — analyze risk level
- Report affected symbols and blast radius

## Step 6: Situational Summary
Print a concise report:

```
## Session Init Complete
- **Last session**: <what was done, from memory/knowledge recall>
- **Pending tasks**: <N tasks> or none
- **Unseen changes**: <from other agents> or clean
- **Working state**: clean / <N uncommitted files, risk level>
- **Key context**: <relevant decisions or lessons>
- Ready to start work.
```

## Step 7: Activate Workflow Intelligence
For the REST of this session, use cortex tools naturally:

### Before implementing a plan:
1. Draft plan with steps + files to change
2. `cortex_plan_quality(plan: "<your plan>")` → score 0-100
3. If score < 60 → refine. If 60-80 → proceed with caution. If > 80 → execute.

### Before editing a file:
1. `cortex_code_search` → find relevant code
2. `cortex_code_context` → understand callers/callees
3. `cortex_code_impact` → blast radius check
4. Only THEN edit

### Cross-project lookup:
```
cortex_code_search(query: "...", repo: "YulgangProject")
cortex_code_context(name: "...", repo: "YulgangProject")
cortex_code_read(file: "...", repo: "YulgangProject")
```

### When hitting an error:
1. `cortex_knowledge_search` → check if known
2. `cortex_memory_search` → check if seen before
3. Fix the error
4. If non-obvious → `cortex_knowledge_store` to save for others

### Before committing:
1. `cortex_detect_changes(scope: "staged")` — verify blast radius
2. Commit
3. After push → `cortex_code_reindex(repo: "...", branch: "<branch>")`

### Working on a Conductor task:
1. `cortex_task_accept(taskId)` at start
2. `cortex_task_update(taskId, status: "in_progress")` during work
3. `cortex_task_update(taskId, status: "completed", result: {...})` when done

---
All cortex gates satisfied. Proceed with user tasks.
