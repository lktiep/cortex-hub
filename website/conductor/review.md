# Review, gates and escalation

Work tasks have `reviewRequired: true` unless the plan says otherwise. A worker that finishes one
reports it for review with the PR link and test output, and the hub tells the lead.

## Notices, not polling

Notices for the lead arrive inside the results of its next hub tool call, under a
`📋 Conductor:` block, one line per notice. They go to the API key that created the task. The
dashboard shows the same information.

| Kind | When |
|---|---|
| `review_ready` | A task is in review, with its PR and test output |
| `escalated` | A task failed or was rejected twice |
| `gate_ready` | A gate's dependencies are done; it waits for approval |
| `capacity` | Every route of a task is out of quota; it waits for the earliest reset |
| `no_worker` | No connected worker can take a task |

## Reviewing a task

1. `cortex_task_status(taskId)` for the PR URL, test output and logs.
2. `gh pr diff <pr>` to read the change.
3. `cortex_task_review(taskId, verdict: "approve")`, or
   `cortex_task_review(taskId, verdict: "reject", feedback: "...")`.

**Approve** completes the task and starts its dependents. Approving does not merge: a dependent
starts from `origin/<base branch>`, so if it needs the approved code, merge the PR first and then
approve. Tasks that share a `branch` stack on each other instead.

**Reject** sends the same task back to `pending` with your feedback added to its reviews. The next
attempt continues on the same branch, preferably on the same machine. Make the feedback concrete:
the file, the problem, the result you expect. Do not create review or revision subtasks.

## Gates

A gate is a task of `kind: "gate"` that no worker runs. It waits until its dependencies complete,
then waits for approval.

- `approver: "user"` (the default): only a person closes it, from the dashboard. MCP calls are
  refused. Use it for designs, mockups and plan sign-off.
- `approver: "lead"`: the lead closes it with `cortex_task_review`.

Rejecting a gate sends each of its direct work dependencies back with the feedback, and the gate
waits again. Hang later work on the gate, not on the task the gate checks.

::: warning
The dashboard has no login. Anyone who can open it can approve a user gate. Keep it behind access
control; see [Self-host](../guide/self-host#put-it-on-the-internet).
:::

## Escalation

A task that fails twice, or is rejected twice, is escalated. It keeps its status but the
dispatcher skips it, and it shows under **Needs you** on the dashboard. A task that runs out of
quota is not a failure; it moves on to its next route.

To resolve an escalation, read its logs and reviews, then either:

- reroute it: `cortex_task_route(taskId, executor, model, effort, fallback, pinnedAgent, files,
  clearEscalation: true)`. Only the fields you pass change; `null` clears one. A running task is
  stopped and returned to `pending` first. Or
- replace it. There is no tool that edits a description:
  1. create the replacement with `cortex_task_tree_create({ parentId, tasks: [...] })`;
  2. point each dependent at it with `cortex_task_route({ taskId, dependsOn: [<stored ids>] })`
     (here `dependsOn` takes stored ids, not plan keys);
  3. cancel the old task with `cortex_task_cancel({ taskId, reason })`.

Dependents of a cancelled task stay blocked until you repoint them.

## On the dashboard

**Conductor** (`/conductor` on the dashboard) shows each plan as a tree with its dependencies and
gates, live agent cards, and a detail panel per task with logs, result, review and routing. User
gates are approved there. **Delete pipeline** removes a plan.
