# /cs — Cortex Start v0.9.0

> Version: 0.9.0 | Updated: 2026-09-28
> Changelog: v0.9.0 — cortex_plan_quality is actually registered; it scores 0-10 and takes the request too
> Changelog: v0.8.0 — search-once/read-all-ten ordering from measured retrieval; recall no longer counts as discovery
> Changelog: v0.7.0 — unified versioning, removed STATE.md, streamlined tool guidance, auto-memory safety net
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
Save `session_id`, `projectId` and `project.orgId` from the response. `orgId` is the boundary of a cross-repo search.
If `recentChanges.count > 0` → warn user and `git pull` before any edits.

## Step 2: Recall Context (parallel)
Call BOTH in parallel:
- `cortex_knowledge_search(query: "session summary progress next session")`
- `cortex_memory_search(query: "session context decisions lessons", agentId: "claude-code")`

These return what was done last session, key decisions, and next steps.

## Step 3: Conflict Check
`cortex_changes(agentId: "claude-code", projectId: "<from step 1>")`

## Step 4: Task Pickup (Optional)
If `cortex_task_pickup` tool is available:
`cortex_task_pickup()` — check for Conductor tasks assigned to you.
If tasks exist → list them. Ask user which to work on, or continue with their request.
If the tool is not available (e.g. in solo dev mode), skip this step.

## Step 5: Working State Check
Run `git status`. If uncommitted changes:
- `cortex_detect_changes(diff: "<output of git diff HEAD>")` — analyze risk level. The hub cannot see your working tree, so pass the diff
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
2. `cortex_plan_quality(plan: "<your plan>", request: "<what the user asked>")` → scorecard, 0-10
3. 8.0 or more → execute. Below that → address the listed improvements and resubmit with `iteration: 2` (max 3), then escalate to the user.

### Finding the code to change:
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

### Cross-project lookup:
Projects are isolated per organization; related repos (client, server, tools) share one.
```
cortex_code_search(query: "...")                      # every repo in this organization
cortex_code_search(query: "...", repo: "my-backend")  # one repo
cortex_code_context(name: "...", repo: "my-backend")
cortex_list_repos()                                   # the repos "every repo" covers
```
Running sessions in two organizations with one API key at once? Pass `org: "<orgId>"`.

### When hitting an error:
1. `cortex_knowledge_search` → check if known
2. `cortex_memory_search` → check if seen before
3. Fix the error
4. If non-obvious → `cortex_knowledge_store` to save for others

### Before committing:
1. `cortex_detect_changes(diff: "<output of git diff --staged>")` — verify blast radius. `risk_level: "unknown"` means a lookup failed: it is not a pass
2. Commit
3. After push → `cortex_code_reindex(repo: "...", branch: "<branch>")`

### Working on a Conductor task:
1. `cortex_task_accept(taskId)` at start
2. `cortex_task_update(taskId, status: "in_progress")` during work
3. `cortex_task_update(taskId, status: "completed", result: {...})` when done

---
All cortex gates satisfied. Proceed with user tasks.
