# /cs — Cortex Start v0.10.0

> Version: 0.10.0 | Updated: 2026-10-22
> Changelog: v0.10.0 — one call: session_start with the task answers the recall and the files to read
> Changelog: v0.9.4 — recall with the task's own words; the generic session query is already in session_start's answer
> Changelog: v0.9.0 — cortex_plan_quality is actually registered; it scores 0-10 and takes the request too
> Changelog: v0.8.0 — search-once/read-all-ten ordering from measured retrieval; recall no longer counts as discovery

## 1. Start, with the task
```
cortex_session_start(repo: "https://github.com/lktiep/cortex-hub.git", task: "<the task in a few words>")
```
The task's own words: the feature, the error, the file. The answer holds the recall for it
(`recalled:` knowledge and memory) and where the code is (`located:` files, line ranges, symbols).
That is the recall and the first lookup: do not repeat them with separate searches. A hook adds
the conversation id, branch, IDE and identity. No task yet? Start without one, and call it again
with the task once you have it.

## 2. Only when it applies
- Uncommitted changes in `git status` → `cortex_detect_changes(diff: "<git diff HEAD>")`.
- Shared files another agent may hold → `cortex_changes(projectId)`.
- Conductor work → `cortex_task_pickup()`; then `cortex_task_accept`, `cortex_task_update`.
- A plan of several steps → `cortex_plan_quality(plan, request)`; 8.0 or more → execute.

## 3. While working
- A symbol name → `cortex_code_context(name)`. A behaviour → `cortex_code_search(query)`.
  An exact literal → `rg`; in other repos of the organization → `cortex_code_grep`. Read the lines a hit names, not the whole file.
- Something breaks → `cortex_knowledge_search` and `cortex_memory_search` with the error; a
  non-obvious fix → `cortex_knowledge_store`.
- Before committing → build, typecheck and lint last, then `cortex_detect_changes(diff)`; after
  pushing → `cortex_code_reindex(repo, branch)`.
