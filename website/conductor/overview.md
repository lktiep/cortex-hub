# Conductor

Conductor lets one agent, the **lead**, plan work as a tree of tasks that **workers** on other
machines pick up and run. Each worker runs a task in its own git worktree with a local engine
(`agy`, `claude`, `codex` or `gemini`), pushes a branch, opens a PR and hands it back for review.

[Open the Conductor showcase →](/cortex-hub/conductor/index.html){target="_self"}

```
 lead (any MCP client)                  hub                       workers (cw)
 ─────────────────────                  ───                       ────────────
 cortex_task_tree_create ───────▶  plan, dependencies,  ───────▶  worktree → engine → PR
 cortex_task_review      ◀───────  file locks, quota    ◀───────  review / fail / quota
          ▲                         📋 notices                     
          └──────────── review_ready · escalated · capacity · gate_ready · no_worker
```

## Act as the lead

Any MCP session connected to the hub can lead. The lead's instructions are in
[`scripts/orchestrator-prompt.md`](https://github.com/lktiep/cortex-hub/blob/master/scripts/orchestrator-prompt.md).
In Claude Code:

> Read `scripts/orchestrator-prompt.md` and act as the conductor lead.

Use a key for the lead that no worker uses. Notices go once to the key that created the task,
to whichever session calls a tool first, so a worker on the same key would take the lead's
notices.

## A plan

One call creates the whole plan. Put it under one root task of `kind: "group"`, and give every
top-level item that root's key as `parentKey`, or the dashboard shows each task as its own plan.

```
cortex_task_tree_create(
  tasks: [
    { key: "JWT", title: "JWT refresh token rotation", kind: "group" },
    { key: "API", title: "Add rotation endpoint", parentKey: "JWT",
      files: ["apps/api/src/auth.ts"], priority: "high" },
    { key: "TESTS", title: "Test the rotation endpoint", parentKey: "JWT",
      files: ["apps/api/src/auth.test.ts"], dependsOn: ["API"] },
    { key: "OK", title: "Approve before merge", parentKey: "JWT",
      kind: "gate", approver: "user", dependsOn: ["TESTS"] }
  ]
)
```

The hub checks that keys are unique and the dependency graph has no cycle (the error names the
cycle), then returns each key's stored id and runs a dispatch pass.

For more than about 15 tasks, write the plan to a JSON file (`{"parentId"?, "projectId"?,
"tasks": [...]}`) and call `cortex_task_tree_create(upload: true)`. It returns a one-time curl
command that imports the file in one request. The link is valid for one plan for 15 minutes.

### Task fields

| Field | Use |
|---|---|
| `key`, `title`, `description` | The description must stand alone: goal, acceptance criteria, files, test command. Agents share no memory |
| `kind` | `work` (default), `gate` or `group` |
| `parentKey`, `dependsOn` | Keys in the same call |
| `priority` | `critical`, `high`, `medium`, `low`, or 1–10; lower runs first |
| `requiredCapabilities` | Tags a worker must have, such as `backend` or `testing` |
| `executor`, `model`, `effort`, `fallback`, `pinnedAgent` | Routing; see below |
| `files`, `branch` | Locks and the branch name |
| `reviewRequired` | Defaults to `true` for work tasks |
| `approver` | For a gate: `user` (default) or `lead` |
| `context.testCommand`, `context.allowEmpty`, `context.estimate` | Test to run, allow a result with no change, estimate in days |

### Kinds

- **work** is dispatched to a worker.
- **group** is never dispatched. It completes when every task under it that was not cancelled has
  completed, so other tasks can depend on a whole phase. Cancelling a group cancels everything
  under it; cancel the root to stop the plan.
- **gate** is never dispatched. When its dependencies complete it waits for approval. A `user` gate
  is closed only from the dashboard; MCP calls to close it are refused. A `lead` gate is closed with
  `cortex_task_review`. Rejecting a gate sends its direct work dependencies back with the feedback.
  Hang later work on the gate, not on the task it checks.

## How the hub dispatches

A work task is ready when it is `pending`, every dependency has completed, it is not escalated,
and none of its `files` overlaps a running task's. Two tasks overlap when a path equals the other
or lies under a directory prefix of it (a directory ends in `/`; no globs). Ready tasks go out by
priority, then age.

For each task the hub tries routes in order: `{executor, model, effort}`, then each `fallback`
entry, then the project default (`claude` / `opus` unless changed). A route takes the first
eligible worker: connected and idle, registered for the project, not pinned elsewhere, holding the
required capabilities, offering that engine and model, and with no quota recorded as exhausted for
it. Among those it prefers the machine that ran the task last.

When nothing can take a ready task, the task records why:

| Wait reason | Meaning | Lead is told |
|---|---|---|
| `capacity` | Every route is blocked by quota; waits until the earliest reset | Once (`capacity`) |
| `no_worker` | No connected worker could ever take it (engine, model, capability, pin) | Once (`no_worker`) |
| `lock` | A running task holds one of its files | No |

A task without `files` never takes a lock, so it can collide with another. Set `files` on every
work task.

## Leases and machines that go away

Every minute the hub reclaims tasks whose lease (24 hours, extended by progress) has run out, or
whose worker has not been seen for 30 minutes. A reclaimed task counts as a failure and goes back
to `pending`. Expired quota records are dropped in the same pass.

## Next

- [Run a worker](./workers): install `cw` and connect a machine.
- [Review, gates and escalation](./review): what the lead does with finished work.
- [MCP tools](../reference/mcp-tools#conductor): every Conductor tool and parameter.
- The status of each part, with the tests behind it, is in
  [`docs/conductor.md`](https://github.com/lktiep/cortex-hub/blob/master/docs/conductor.md#current-status).
