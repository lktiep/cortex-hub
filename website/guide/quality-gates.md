# Quality gates

Cortex Hub checks an agent's work at three points: the plan before it starts, each commit, and
the end of the session. The commit check is enforced; the other two are recorded.

## Before: score the plan

`cortex_plan_quality(plan, request)` scores a plan from 0 to 10 against eight criteria:
completeness, specificity, feasibility, risk awareness, scope, ordering, testability and impact.
It is a heuristic on the hub, with no LLM call.

| Parameter | Meaning |
|---|---|
| `plan` | Numbered steps, the files each touches, how it will be verified |
| `request` | The original request, used to judge completeness and scope |
| `iteration` | 1 to 3 (default 1) |
| `threshold` | Passing score (default 8.0) |
| `plan_type` | `feature`, `bugfix`, `refactor`, `architecture`, `migration`, `general` |

Below the threshold, the agent refines the plan and calls again with `iteration + 1`. After the
third attempt it escalates to you with the suggested improvements. `/cs` asks agents to do this
for any non-trivial change.

## During: the commit gate

In Claude Code, the installed hooks refuse a `git commit` until, in this session:

- `cortex_session_start` has run,
- a code discovery tool has been used, and
- build, typecheck and lint have passed.

`--no-verify`, `git commit -n` and `LEFTHOOK=0` are refused outright. Passing gates certify the
tree, not the session: any file write after them closes the gate again, so run them last and then
commit. The exact rules, including which commands count, are in [Hooks](../reference/hooks).

The installer also sets up [lefthook](https://github.com/evilmartians/lefthook) from
`.cortex/project-profile.json`, so the same checks run as git hooks for people and agents that do
not use Claude Code. If the repo already owns its git hooks, only Cortex's post-push hook is
merged in.

## After: report the result

`/ce` runs the gates and reports them with `cortex_quality_report`:

| Parameter | Meaning |
|---|---|
| `gate_name` | What was checked, for example `Session Quality` |
| `passed` | `true` or `false` |
| `score` | Optional, out of 100 |
| `details` | Optional log or notes |

The hub grades each report and splits it into four dimensions: **Build**, **Regression**,
**Standards** and **Traceability**. Calling `cortex_quality_report` does not open the commit gate;
only passing the gates does.

## Where to see it

- **Quality** on the dashboard: the four dimensions, grade distribution and a 30-day trend.
- `cortex_tool_stats(days, agentId, projectId)`: which Cortex tools agents used, over the last
  7 days by default. The dashboard's **Usage** page shows the same as Cortex Tool Savings.
