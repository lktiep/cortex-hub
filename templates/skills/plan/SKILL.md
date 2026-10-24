---
name: cortex-plan
description: Plan multi-step work as a Cortex Conductor task tree. Survey the workers (machines, OS, engines, capabilities) and the code, cut the work into reviewable units, draw the real dependencies, route each task to a machine that can run it, and describe each task for a worker that starts cold. Use before cortex_task_tree_create, or whenever asked to plan, split or distribute work across agents or machines.
---

# Planning a Conductor task tree

A plan is a dependency graph of tasks that workers on other machines run in parallel. A worker
starts cold: a fresh worktree of the project's default branch, plus its own task's title,
description and files. It never sees the plan, the other tasks or this conversation. Shape the
plan for the machines you have, and write every task for that reader.

The same guide is served by `cortex_task_tree_create(guide: true)`, so any model can read it.

## 1. Fill the plan brief

Answer each line before you plan. Ask the user for what you can't find; don't guess.

```
Outcome:      what is true when the whole plan is done (observable)
Out of scope: what this plan must not change
Repo/branch:  project and the base branch workers start from
Constraints:  deadline, compatibility, areas no one may touch
Machines:     one line per worker from cortex_agents (see 3)
Approvals:    who approves work (user or lead) and who merges PRs
Known traps:  what knowledge/memory recall turned up
```

## 2. Decide whether you need a tree

- One change in one or two files, under an hour of work: no tree. Do it, or create one task
  with `cortex_task_create`.
- A tree pays off with three or more independently reviewable changes, or work that can run on
  several machines at once.
- Two tasks in a row is not a plan. Merge them into one task, or find the work that can run
  beside them.

## 3. Survey the code and the machines

1. `cortex_knowledge_search` and `cortex_memory_search` on the request: earlier decisions and
   known traps.
2. `cortex_code_search` or `cortex_code_context` to find the code, and `cortex_code_impact` on
   shared symbols to see what else changes. Write down the files each change touches: you need
   them for `files` and to see what can run in parallel.
3. `cortex_agents` to see the workers. For each one note: idle or busy, OS, engines and models,
   capabilities, the project it is scoped to, and any exhausted quota. Then:
   - **Width.** Idle workers that can take this project's tasks are your parallelism. Aim for at
     least that many ready tasks at the widest level when the work allows it. More tasks than
     workers is fine: they queue.
   - **Scope.** A worker scoped to a project only takes that project's tasks. An unscoped one
     takes any.
   - **Machine-specific work.** Work that needs one environment (a Windows build, a GPU, a tool
     installed on one machine, a model only one machine has) gets `requiredCapabilities` that
     only those workers advertise. Use `pinnedAgent` only when exactly one machine may do it:
     a pinned task waits for that machine even while others sit idle.
   - **Engines.** Match the task to the engine: design and tricky debugging to the strongest
     model with high `effort`; mechanical edits to a cheaper one. `agy` runs headless and
     cannot run shell commands, not even the tests, so give it edit-only tasks. Add a `fallback`
     route for important tasks so an exhausted quota doesn't stall the plan.
   - **Quota.** Don't route to an engine and model whose quota is exhausted until after the
     plan should be done.

## 4. Cut the work into units

A unit (one work task) is:
- one coherent change a reviewer can approve on its own, one PR;
- about 15 to 60 minutes of agent work (a run is cut off at 90);
- a small set of files, listed in `files`;
- done when something observable is true (a test passes, a command prints X), not when "the
  code is written".

Cut along seams: a module or package, a layer behind an interface (schema, API, UI), a command,
a migration, a platform.

Don't create separate tasks for:
- "write tests" for code another task writes: tests go with the code, and the worker runs the
  project's test command anyway;
- "review": every work task is reviewed (`reviewRequired` defaults to true);
- "create file" or "add import": too small, fold them into the change that needs them;
- "implement the feature": too big, that is the plan, not a task.

## 5. Draw every real dependency, and only those

B depends on A when B can't start without A's result:
- B uses code that A adds or changes, or
- B needs a decision that A makes (a design, a contract, a spike's answer).

"A comes first in my head" is not a dependency. Tasks on different files with no shared
contract run side by side; that is what Conductor is for. Do list every real one: a missing
dependency makes a worker build on code that isn't there yet.

**Dependencies don't carry code.** Every task branches from the default branch, and approving
A merges nothing: B sees A's changes only if A's PR is merged before B starts. For each code
dependency, pick one:
- **Merge, then approve.** The lead merges A's PR (`gh pr merge --squash`) before approving A
  with `cortex_task_review`, so B starts from a branch that has it. This is the default.
- **Stack.** Give A and B the same `branch`, so B continues on A's commits. Use it for a short
  run of changes that are reviewed together.
- **Contract.** Fix the interface (types, routes, schema) in both descriptions, or in a small
  first task, and let both sides build against it in parallel with no dependency at all.

If two pieces are so coupled that neither makes sense alone, they are one task.

## 6. Shape: wide, then narrow

Aim for a diamond, not a line:

```
root (group)
├─ contract    ┐ small first task: types, schema, API shape            level 1
├─ win-check   ┘ needs no contract, so it starts at once on the
│                Windows machine (requiredCapabilities: ["windows"])
├─ api         ┐ depend on contract; in parallel, disjoint files,      level 2
├─ ui          ┘ on any idle worker
└─ gate: verify end to end (approver user)                             level 3
```

Check it before you submit:
- With three or more work tasks, the longest chain should be at most half of them, rounded up. A plan
  where every task waits for the one before it is a to-do list, and it runs no faster than one
  agent.
- Tasks with no dependency between them must not share files: overlapping `files` makes them
  wait on each other's lock.
- Put the plan under ONE root `group` and set its key as the `parentKey` of every top-level
  item. Use nested groups for phases or areas; `dependsOn` on a group orders the whole phase.
- Gates mark decisions, not steps: a design, mockup or spike the user must accept before work
  builds on it, and one at the end to verify the whole result. Hang the downstream work on the
  gate, not on the task it checks.
- Investigation tasks that change no files need `context: {"allowEmpty": true}`, or the worker
  fails them.

## 7. Write each description for a cold reader

Use these sections, in this order. Keep each description under about 6,000 characters.

```
## Goal
One or two sentences: the change and why it matters.

## Context
What the worker needs that the code won't tell it: the decision behind this, the
knowledge or memory you recalled, and the contract it builds against. Paste the contract;
never write "see task A".

## Scope
- Change: path/to/file.ts (symbolName), path/to/other.ts
- Don't touch: anything else. Name nearby files that look related but aren't.

## Steps
Hints, not a script: where to start, the pattern to copy (file:line), the trap to avoid.

## Done when
- The checks a reviewer can run: the test that must pass, a command and its expected
  output, the behaviour to try.
```

Never write "as above", "the previous step" or "task 2": the worker can't see them.

## 8. Fields worth setting

- `files` on every work task (locks and review scope). A directory ends in `/`; no globs.
- `priority: "high"` on the tasks others wait for, so the critical path starts first.
- `requiredCapabilities`, `executor`, `model`, `effort` and `fallback` from your machine survey.
  Leave them out when any worker will do. Pick only executor and model pairs `cortex_agents`
  lists. Omitting `fallback` means the project default; `[]` means none.
- `context.testCommand` when the task should run a different test command than the project's,
  and `context.estimate` in days for the dashboard.
- `approver: "lead"` for gates you will decide yourself with `cortex_task_review`, and `"user"`
  for the human.
- More than about 15 tasks, or long descriptions: write the plan to a JSON file and call
  `cortex_task_tree_create(upload: true)`.

## 9. Check, show, then create

1. Call `cortex_task_tree_create` with `dryRun: true` and the plan. It reports the shape
   (work tasks, longest chain, widest level) and the problems it finds: chains, missing files,
   thin descriptions, files shared by parallel tasks, dependencies that need a merge. Nothing is
   created.
2. Fix what it reports. Show the user the tree (an indented outline like the one in 6, with the
   machine each task goes to) and the brief.
3. Create it with the same call without `dryRun`.

Running it: notices arrive in tool results under `📋 Conductor:`; act on them instead of
polling. Review each finished task's PR, merge it, then approve it. Never create review or
revision tasks: a rejected task reruns with your feedback.

## Example

Request: "Add CSV export to the reports page". Machines: two idle workers on macOS with claude,
one idle Windows worker with codex that advertises the capability `windows`.

```json
{
  "projectId": "<project-id>",
  "tasks": [
    { "key": "root", "kind": "group", "title": "CSV export for reports" },
    { "key": "contract", "parentKey": "root", "priority": "high",
      "title": "Define the export API contract",
      "files": ["packages/shared-types/src/reports.ts"],
      "description": "## Goal\nAdd the request and response types for exporting a report as CSV, so the API and the UI can be built in parallel.\n\n## Context\nReports are typed in packages/shared-types/src/reports.ts. The export is GET /api/reports/:id/export?format=csv and streams text/csv.\n\n## Scope\n- Change: packages/shared-types/src/reports.ts (add ReportExportFormat, ReportExportQuery)\n- Don't touch: the API or the UI.\n\n## Steps\nFollow the shape of ReportQuery in the same file.\n\n## Done when\n- `pnpm typecheck` passes and both types are exported from the package index." },
    { "key": "api", "parentKey": "root", "dependsOn": ["contract"],
      "title": "Stream reports as CSV from the API",
      "files": ["apps/api/src/routes/reports.ts", "apps/api/src/routes/reports.test.ts"],
      "description": "## Goal\n...\n## Context\n...\n## Scope\n...\n## Steps\n...\n## Done when\n..." },
    { "key": "ui", "parentKey": "root", "dependsOn": ["contract"],
      "title": "Add the Export CSV button to the reports page",
      "files": ["apps/web/src/app/reports/page.tsx"],
      "description": "## Goal\n...\n## Context\n...\n## Scope\n...\n## Steps\n...\n## Done when\n..." },
    { "key": "win-check", "parentKey": "root",
      "requiredCapabilities": ["windows"], "executor": "codex",
      "title": "Make the CSV writer handle Windows line endings and paths",
      "files": ["packages/csv/src/write.ts", "packages/csv/src/write.test.ts"],
      "description": "## Goal\n...\n## Context\n...\n## Scope\n...\n## Steps\n...\n## Done when\n..." },
    { "key": "verify", "parentKey": "root", "kind": "gate", "approver": "user",
      "dependsOn": ["api", "ui", "win-check"],
      "title": "Export a real report end to end on macOS and Windows" }
  ]
}
```

Shape: 4 work tasks, longest chain 2, widest level 2. The Windows-only work needs nothing from
the contract, so it starts at once on the only machine that can run it, beside the contract;
the API and the UI then run side by side on the two macOS workers.
