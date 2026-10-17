# Conductor: production-ready multi-machine execution — design

> Status: **draft for review** · 2026-10-16 · branch `docs/conductor-production-ready-spec`
> Implementation plans: `docs/superpowers/plans/2026-10-16-conductor-*.md`

## 1. Goal

A lead agent (Claude Code) takes a planned project — dozens of tasks with
dependencies, grouped in phases — and hands it to the Conductor. Workers on
several machines (macOS, Linux, Windows) pick tasks up and run them headless with
Claude Code, Codex or the Antigravity CLI. Each finished task arrives as a pull
request with test output. The lead reviews, and the user steps in only where a
gate asks for a human. The dashboard shows the whole plan: what is done, what
runs where, what is waiting and why.

This session builds the **infrastructure** only. Which agent does which task is
the lead's decision, made per task through routing fields. The hub executes
those decisions and keeps the plan moving when a machine or a model runs out.

### Success criteria

1. A worker on each of macOS, Linux and Windows connects with the same
   installer and runs a task end to end: worktree → engine → commit → push →
   PR → `review`.
2. A plan of ~40 tasks with dependencies is created in one call and dispatched
   in dependency order, one task per worker, with no task pushed twice and none
   lost when a worker disconnects.
3. When a model's quota runs out mid-task, the work in progress is pushed,
   and the task moves to the next route in its fallback chain (other model,
   other engine, finally the project default such as Claude Opus). When no
   route has capacity, the task waits with a stated reason and the lead is told
   once. Nothing sits silently stuck.
4. A rejected review sends the same task back with the feedback on the same
   branch. Two rejections or two failures stop it and put it in front of the
   lead and the user.
5. The dashboard draws the plan from real dependencies, with machines as
   lanes, and lists what needs a human.

### What the user decided, and what this spec assumes

| Decided by the user | Assumed here (flagged in §4) |
|---|---|
| Infra now; the lead (Claude Code) decides who does what. No hard-coded routing. | One task per worker at a time |
| Plan-content conflicts are revised by the user later; the hub only rejects dependency cycles. | Quota is recorded per machine, not per worker |
| Antigravity runs headless like the existing agent script. | The project default fallback ships as Claude Opus |
| When a model's quota runs out, fall back to another model, then to Opus; when nothing can run, notify or wait — never stuck. | Workers hold leases; an offline worker loses its task after 30 min |
| Fix the Windows worker (`cortex-agent.ps1`). | Replaced by a single TypeScript worker (D1) |

## 2. Current state (verified 2026-10-16)

### Hub defects that block multi-machine use

| # | Where | Defect |
|---|---|---|
| H1 | `apps/dashboard-api/src/ws/conductor.ts:106,166` | The registry is keyed by `agentId`. A reconnect overwrites the entry, and the old socket's close handler then deletes the **new** one, so the hub loses a live worker ("Anti-01"). |
| H2 | `ws/conductor.ts:240-327` | `task.complete` always stores `completed`, whatever the worker reports, then pushes the next sibling — including tasks in `review` — and marks it `accepted` even when the worker is busy. |
| H3 | `ws/conductor.ts:137-152` | On connect the hub re-pushes the first task in `pending/assigned/accepted/in_progress`, so a reconnecting worker can receive a second task. |
| H4 | `ws/conductor.ts:200` | `task.accept` updates any task id; it does not check the task is assigned to the caller. |
| H5 | `routes/conductor.ts:528-632` | `POST /` pushes to `assignedTo` immediately, stores `priority` as sent (the MCP tool sends `"high"` into an INTEGER column), and never sets `api_key_owner`. |
| H6 | `routes/conductor.ts:692` (`PUT /:id`) | `rejected` creates a new "Revision:" subtask and leaves the original `rejected`, so its dependents never unblock. `message` is ignored. |
| H7 | `routes/conductor.ts:460` (`GET /`) | Reads `assigned_to`, ignores `projectId`; `cortex_task_list` sends `assignedTo` and `projectId`, so its filters do nothing. |
| H8 | — | No leases, no quota handling, no fallback: a task whose worker dies or runs out of quota stays `in_progress` forever. |
| H9 | `apps/hub-mcp/src/notifications.ts` | Dead code: nothing imports it, and it calls `/api/tasks/notifications/:id`, which does not exist. The lead has no way to hear about anything. |

### Worker defects

| # | Where | Defect |
|---|---|---|
| W1 | `scripts/cortex-agent.ps1` | Cannot connect at all: no `apiKey` and no query string, so the hub closes the socket (4001). Also sends `task.accepted` instead of `task.accept`, drops title-only prompts, loses completions, reads the wrong identity schema, and uses one global PID file. |
| W2 | `scripts/cortex-agent.sh:517-533` | The Antigravity engine calls `antigravity -p --yolo`. The CLI is `agy`, and `--yolo` does not exist. |
| W3 | `cortex-agent.sh:463-575` | `claude -p` runs with no `--model`. Engines cannot be told which model to use. |
| W4 | `cortex-agent.sh` (accept path) | Accepts, then runs the engine in a background subshell, so a second push starts a second task on the same checkout. |
| W5 | `cortex-agent.sh:923-926` | Computes the result status but never sends it. |
| W6 | `cortex-agent.sh:270-363`, `apps/cortex-extension/src/config.ts:56-80,153-180`, `apps/cortex-extension/src/ws-client.ts:50`, `apps/cortex-extension/package.json` | Hub URL detection reads only the `mcp-remote` `args[2]` form, so Claude Code's `url` + `headers` entry is ignored. In the extension the derived URL already ends in `/ws/conductor` and `ws-client.ts` appends it again, and the `cortexHub.hubUrl` default (`ws://localhost:8318`) means detection never runs. |
| W7 | — | Nothing does git. Engines edit the user's checkout directly. No branch, PR, or test output reaches the hub. |

### Antigravity CLI facts (probed on this machine)

- `agy` 1.4.0 at `~/.local/bin/agy`. Install:
  `curl -fsSL https://antigravity.google/cli/install.sh | bash` (PowerShell
  installer on Windows). Login is interactive, once per machine.
- `agy models` lists `gemini-4-argon-{low,medium,high}`,
  `gemini-3.8-flash-{low,medium,high}`, `claude-opus-5-5-{low,medium,high}`,
  `claude-sonnet-5-5-{low,medium,high}`, `gpt-oss-120b-medium`.
- Headless works: `agy -p "<prompt>" --model gemini-4-argon-low
  --output-format stream-json --print-timeout 2m` exits 0 and emits `init`,
  `step_update` and `result` events (`status: "SUCCESS"`). ~115 s wall time,
  almost all MCP server start-up; the model itself took 3.4 s.
- Quota exhaustion (observed with `claude-sonnet-5-5-low`): exit code **3**,
  a `result` event with `status: "ERROR"` and
  `error: "Individual quota reached. … Resets in 89h3m4s."`, and on stderr
  `AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","error_code":429,"retryable":true,…}`.
  Argon kept working at the same time, so quota is per model family, not per
  account.
- An invalid model exits 1 and lists the valid ones.
- Useful flags: `--mode accept-edits|auto|plan` (`auto` is macOS/Linux only and
  soft-denies irreversible actions), `--effort`, `--print-timeout`,
  `--add-dir`, `--sandbox`, `--continue`/`--conversation`.
- `agentapi` drives the desktop app only and cannot be a worker.
- `agy mcp list` prints MCP server secrets in plain text, and the cortex entry
  on this machine still points at the old hub URL. Part C covers both.

## 3. Scope

**In:** hub data model and dispatch; worker registry; worker protocol; review
gate; quota fallback; leases; lead MCP tools and notifications; one
cross-platform worker; dashboard plan view; setup docs and correct URLs.

**Out:** mirroring tasks to GitHub Issues; resolving conflicts in plan content
(the user revises the plan); any built-in rule that picks an agent for a kind
of task; the existing strategy flow (`analyzing` → `strategy_review`), which
stays as it is; pull-mode workers beyond what `cortex_task_pickup` does today.

## 4. Decisions to approve

| ID | Decision | Why | Rejected alternative |
|---|---|---|---|
| **D1** | **Replace the worker scripts with one TypeScript worker** (`apps/conductor-worker`, bundled to a single `cortex-worker.mjs`). `cortex-agent.sh/.ps1` are deprecated; `run-agent.sh/.ps1` shrink to bootstraps. This departs from the agreed "fix the ps1". | The ps1 is broken end to end (W1), the bash script has five more defects, and both already require Node (`node -e`, the `ws` module). One codebase covers three OSes, and the logic becomes testable with vitest. | Fix bash and PowerShell separately: two runtimes to keep in step, neither testable, and git/PR handling written twice. |
| D2 | One task per worker. Parallelism on one machine = a second worker with its own `--agent-id`. | Engines edit files and run tests; two on one machine compete for CPU and the engine login. | Slots per worker. |
| D3 | New task fields are added with `ALTER TABLE … ADD COLUMN`; the status `CHECK` constraint is not rebuilt. Gates, groups and escalation are new columns, not new statuses. | Rebuilding `conductor_tasks` to change a CHECK risks data on live hubs. Every needed state fits the existing status list. | New statuses with a table rebuild. |
| D4 | Quota is recorded per **machine** (hostname) × executor × model, and a model id may be a prefix (`claude-sonnet-5-5-*`) or `*`. | The engine login is per machine; workers on one machine share it. agy's quota is per model family. | Per worker id. |
| D5 | The project default fallback ships as `[{"executor":"claude","model":"opus"}]`, editable in hub config. | The user asked for "back to Opus" when everything else is out. It is configuration, not routing logic. | Empty default. |
| D6 | **(addition)** A worker that has been offline for 30 min (configurable) loses its task, as does a task with no progress for 24 h. Both count as a failure. | Without it a dead machine holds a task forever (H8). | Wait for the worker to return. |
| D7 | Lead notifications travel on the existing hints channel, addressed by API key name. Separate API keys for the lead and for workers are recommended. | It is the only push path into an MCP client today. With a shared key, an engine's own tool calls would consume the lead's notifications. | New SSE channel. |
| D8 | A gate with `approver: "user"` can be closed only from the dashboard; MCP calls are refused. | Art and mockup approval is the user's, not the lead's. This guards against agents, not attackers: the dashboard API has no user login. | Lead may close any gate. |

## 5. Architecture

```
 Lead (Claude Code, MCP)                    Dashboard (Next.js)
   cortex_task_tree_create / review /         plan view · Needs you
   route / agents / list                      │ REST
          │ MCP :8318                         │
          ▼                                   ▼
 ┌──────────────── hub-mcp ────────────┐   ┌──────────── dashboard-api ─────────────────┐
 │ tools → REST · hints + 📋 Conductor  │──▶│ routes/conductor.ts   (REST, tree, review)  │
 │ GET /conductor/worker.mjs           │   │ conductor/dispatcher.ts  (pure selection)   │
 │ WS proxy /ws/conductor ─────────────┼──▶│ conductor/registry.ts    (connections)      │
 └─────────────────────────────────────┘   │ conductor/lifecycle.ts   (state changes)    │
          ▲ wss (apiKey)                   │ conductor/scheduler.ts   (lease/quota tick) │
          │                                │ ws/conductor.ts          (protocol)         │
 ┌────────┴──────── worker (per machine) ┐ │ SQLite: conductor_tasks + quota + notif.    │
 │ cortex-worker.mjs (Node ≥ 20)         │ └─────────────────────────────────────────────┘
 │ git worktree → engine → test → push   │
 │ engines: claude · codex · agy · gemini│
 └───────────────────────────────────────┘
```

The hub owns state and decisions; the worker owns git and the engine
process. They speak the protocol in §6.5. New hub logic lives in
`apps/dashboard-api/src/conductor/` as small modules with pure functions where
possible, so `ws/conductor.ts` and `routes/conductor.ts` shrink to transport.

## 6. Part A — Hub

### 6.1 Data model

New columns on `conductor_tasks` (all nullable or defaulted, added by the
try/catch `ALTER` list in `db/client.ts`):

| Column | Type | Meaning |
|---|---|---|
| `task_key` | TEXT | Plan-local key (`"TT3"`), unique per root tree; used in tool output and the diagram. |
| `kind` | TEXT default `'work'` | `work` (dispatched), `gate` (closed by a person or the lead), `group` (container; completes when its children do). |
| `approver` | TEXT | Gates only: `'user'` or `'lead'`. |
| `executor` | TEXT | Engine for the primary route: `claude`, `codex`, `agy`, `gemini`. Null = any engine the worker has. |
| `model` | TEXT | Model id passed to the engine verbatim. Null = the engine's default. |
| `effort` | TEXT | Passed to the engine when it supports it (`agy --effort`), otherwise logged and ignored. |
| `fallback` | TEXT (JSON) | Ordered routes tried after the primary: `[{executor, model?, effort?}]`. Null = project default (§6.7). `[]` = no fallback. |
| `files` | TEXT (JSON) | Paths this task will change. A path ending in `/` is a directory prefix. No globs. |
| `branch` | TEXT | Git branch for the task. Set at first dispatch from the template if empty. |
| `pinned_agent` | TEXT | Only this worker may take the task. |
| `review_required` | INTEGER | `1` = a worker's `completed` becomes `review`. Tree tool default 1; legacy create default 0. |
| `attempt` | INTEGER default 0 | Number of dispatches. |
| `fail_count` | INTEGER default 0 | Failures since the last escalation was cleared. |
| `reject_count` | INTEGER default 0 | Review rejections since the last escalation was cleared. |
| `current_route` | TEXT (JSON) | `{executor, model, effort}` of the current or last dispatch. |
| `lease_expires_at` | TEXT | Set on dispatch, extended by progress. |
| `wait_reason` | TEXT | Why a ready task is not running: `capacity`, `no_worker`, `lock`. Informational, recomputed by each dispatch pass. |
| `wait_until` | TEXT | For `capacity`: the earliest quota reset among its routes. |
| `escalated_at` | TEXT | Set after two failures or two rejections. The dispatcher skips the task until cleared. |
| `last_agent` | TEXT | Worker of the last attempt; preferred on the next one. |

`api_key_owner` (already present) is now always set from the
`X-API-Key-Owner` header on create. `context` (JSON) gains conventional keys:
`reviews: [{at, by, verdict, feedback}]`, `handoff: {branch, commit, note}`,
`declined: [agentId]`, `testCommand`, `estimate` (days, for the critical path).

New tables:

```sql
CREATE TABLE IF NOT EXISTS conductor_quota (
  host TEXT NOT NULL,            -- worker hostname
  executor TEXT NOT NULL,
  model TEXT NOT NULL,           -- exact id, prefix ending in '*', or '*'
  exhausted_until TEXT NOT NULL,
  reason TEXT,                   -- raw engine message, truncated to 500 chars
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (host, executor, model)
);

CREATE TABLE IF NOT EXISTS conductor_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient TEXT NOT NULL,       -- API key name
  task_id TEXT,
  kind TEXT NOT NULL,            -- review_ready | escalated | capacity | gate_ready | no_worker
  message TEXT NOT NULL,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_conductor_notif_pending
  ON conductor_notifications(recipient, delivered_at);
```

Hub config keys (`hub_config`): `conductor.defaultFallback` (JSON, seeded per
D5), `conductor.branchTemplate` (default `cx/{key}-{slug}`, where `{key}` is
`task_key` or the first 8 chars of the id), `conductor.baseBranch` (default:
the project's `default_branch`), `conductor.offlineReclaimMinutes` (30),
`conductor.leaseHours` (24).

### 6.2 Task lifecycle

Statuses come from the existing list. `kind = work`:

```
            deps met                dispatch                 task.accept        first progress
blocked ───────────────▶ pending ───────────────▶ assigned ─────────────▶ accepted ────────────▶ in_progress
                           ▲  ▲                      │                        │                     │
   reject (feedback)       │  │ fail / quota / decline / lease or offline reclaim                     │
   review ─────────────────┘  └──────────────────────┴────────────────────────┴─────────────────────┘
     ▲                                                                                            │
     │ complete(review) or complete(completed) with review_required = 1                          │
     └────────────────────────────────────────────────────────────────────────────────────────────┤
                                     complete(completed) with review_required = 0, or approve     ▼
                                                                                              completed
```

- Escalation does not change the status. A task with `escalated_at` set stays
  `pending` and is skipped until the lead clears it (§6.9). Clearing resets
  `fail_count` and `reject_count`; `attempt` keeps counting.
- An attempt never ends in `failed`: a failed attempt returns the task to
  `pending` or escalates it. A task the lead gives up on is `cancelled`
  (`cortex_task_cancel`, the dashboard, or the existing cancel route). Rows already `failed` stay terminal. Dependents of
  a cancelled or failed task stay `blocked` and appear under "Needs you"; the
  lead unblocks them by editing their `dependsOn` (`cortex_task_route`).
- Cancelling a group cancels every unfinished task under it, at any depth, and
  revokes the active ones; the group stays `cancelled`. Cancelling the root
  group stops the whole plan.
- `kind = gate` is never dispatched. It is `blocked` until its dependencies
  complete, then `pending` meaning "awaiting approval". Approve → `completed`
  and the completion chain runs. Reject (with feedback) → each of its direct
  dependencies of kind `work` goes back to `pending` with the feedback as a
  review entry (`reject_count++`), and the gate returns to `blocked`. Other
  tasks that already started from those dependencies are left alone; the
  plan should hang downstream work on the gate, not on the task it checks.
- `kind = group` is never dispatched. It becomes `completed` when every
  non-cancelled child is `completed`, and its own completion runs the same
  chain as a task's, so `dependsOn: ["Phase 1"]` works. A group's own
  `dependsOn` is copied into every descendant at creation, so readiness is
  always a check of the task's own `depends_on`.
- Legacy tasks (no `kind`) are `work`. A legacy parent with an assignee keeps
  today's `synthesis` behaviour.
- Every transition goes through `conductor/lifecycle.ts`, which writes a
  `conductor_task_logs` row, broadcasts the change, and calls the dispatcher.
  Routes and WS handlers stop issuing their own `UPDATE … SET status`.

### 6.3 Registry (fixes H1)

`conductor/registry.ts` replaces the `agents` map:

- Each socket gets a `connectionId`. The map is keyed by `connectionId`, with
  an index from `agentId` to its current connection.
- A new connection with the same `agentId` and the same hostname replaces the
  old one: the old socket is closed with 4000 `replaced`.
- The same `agentId` from a different hostname is refused with 4009
  `agent id in use on <host>`.
- Close and keepalive handlers remove the entry only if it is still the
  current connection for that `agentId`.
- The registry keeps `lastSeen` per `agentId` after disconnect (in memory;
  after a hub restart every worker's `lastSeen` is the start time).

Registration (`worker.register`, §6.5) records `hostname`, `os`, `version`,
`capabilities`, `engines: [{executor, models[], defaultModel}]`,
`defaultExecutor`, and the project. The project comes from the worker's git
remote, matched with the same logic as `cortex_session_start`
(`routes/quality.ts:347-380`, extracted into a shared helper). If the API key
is scoped to a project (`api_keys.project_id`), the worker may only register
for that project. The old `agent.register` message and query-string identity
still work, so an old script can connect, but it gets no engines and so no
work with an `executor` set.

### 6.4 Dispatcher

`conductor/dispatcher.ts` exports a pure `selectAssignments(tasks, workers,
quota, now)` and a thin `dispatch()` that loads state, applies the result in one
transaction, and sends the pushes. `dispatch()` is synchronous and
re-entrancy-guarded: a call while it runs sets a flag and the loop runs once
more.

**Triggers:** worker registered; task created, imported, rerouted or
unescalated; task completed, approved, rejected, failed, returned; worker idle;
scheduler tick (§6.8).

**Ready tasks:** `kind = 'work'`, `status = 'pending'`, `escalated_at IS NULL`,
every `depends_on` id `completed`, and no file conflict with an active task.
Active = `assigned`, `accepted`, `in_progress`, `review`. Two tasks conflict
when a path of one equals a path of the other, or lies under a directory
prefix of the other. Order: `priority ASC`, `created_at ASC`.

**Routes** for a task: `[primary, ...fallback]`, where primary is
`{executor, model, effort}` and `fallback` null means the project default.
Duplicates are dropped.

**Workers** eligible for a route:

1. connected and idle — no task of theirs in `assigned`, `accepted`,
   `in_progress` (a task in `review` does not make a worker busy);
2. registered for the task's project;
3. not in `context.declined`, and equal to `pinned_agent` if one is set;
4. has every `required_capabilities` entry;
5. has the route's executor (or any, if the route's executor is null) and
   lists the model, or lists `*`;
6. no `conductor_quota` row for (its host, executor, model) with
   `exhausted_until > now`, where a row's model matches exactly, by prefix
   (`foo-*`), or as `*`;
7. for a task created in a plan (it has a `task_key`), speaks protocol 2:
   an IDE window or an old agent script cannot tell reliably when its run
   has finished, so it is pushed loose tasks only.

For each ready task, take the first route that has an eligible worker. Among
eligible workers prefer `last_agent`, then the worker idle longest. A worker
is used once per pass.

**Assignment:** `UPDATE conductor_tasks SET status='assigned', … WHERE id = ?
AND status = 'pending'`; if it changed no row, skip. Then set
`assigned_to_agent`, `assigned_at`, `attempt + 1`, `current_route`,
`lease_expires_at`, `last_agent`, `branch` (from the template if empty), clear
`wait_reason`, and push `task.assigned` (§6.5).

**When nothing can take a ready task:**

- every route is blocked only by quota → `wait_reason = 'capacity'`,
  `wait_until` = the earliest `exhausted_until` among them; notify the lead
  once per task per wait (`kind = capacity`);
- no connected worker could ever take it (executor, model, capability, pin) →
  `wait_reason = 'no_worker'`; notify once;
- held only by a file conflict → `wait_reason = 'lock'`; no notification.

**Removed:** the auto-push of the next sibling after `task.complete`, the
re-push on connect, and the immediate push in `POST /` and `/auto-assign`. A
reconnecting worker gets back only its own active task (§6.5), or nothing and
a dispatch pass.

**Pull mode:** `cortex_task_pickup` (MCP sessions without a worker) returns the
first ready task that is pinned to the caller, or unpinned with `executor`
null, under the same eligibility rules, and assigns it the same way.

### 6.5 Worker protocol

Transport stays `wss://<mcp-host>/ws/conductor?apiKey=…&agentId=…&hostname=…`
through the hub-mcp proxy. Messages are JSON with a `type`.

| Direction | Type | Payload | Hub effect |
|---|---|---|---|
| W→H | `worker.register` | `version, hostname, os, repo, capabilities[], engines[], defaultExecutor, activeTaskId?` | Registry update; reply `registered`; then resume, revoke or dispatch. |
| H→W | `registered` | `connectionId, projectId, hubVersion` | Worker warns if its own version differs (the bundle is stamped with the hub's release version at build time). |
| H→W | `task.assigned` | `task: {id, key, title, description, context, files, branch, baseBranch, route: {executor, model, effort}, attempt, leaseExpiresAt, reviews[], handoff?, testCommand?}` | — |
| H→W | `task.resumed` | same as `task.assigned` | Sent instead when `activeTaskId` is still assigned to this worker. |
| H→W | `task.revoked` | `taskId, reason` | Worker stops the engine, pushes WIP, removes the worktree. Sent on cancel, reroute of an active task, reclaim, or a stale `activeTaskId`. |
| W→H | `task.accept` | `taskId` | `assigned → accepted`, only if assigned to this worker. |
| W→H | `task.progress` | `taskId, message, percent?` | Log (last 50 kept); `accepted → in_progress`; extend the lease, at most once a minute. |
| W→H | `task.complete` | `taskId, status: 'completed'\|'review'\|'failed', result: {summary, prUrl?, branch?, commit?, testOutput?, error?}` | `completed` → `review` if `review_required`, else `completed`; `review` (sent by MCP agents) → `review`; `failed` → `fail_count++`, back to `pending`, or escalate at 2. |
| W→H | `task.quota_exhausted` | `taskId, executor, model, modelScope?, resetAt?, raw, handoff: {branch, commit, note}` | Upsert quota for (host, executor, `modelScope ?? model`) until `resetAt` (default now + 1 h); store the handoff; back to `pending` with no failure counted; dispatch. |
| W→H | `task.decline` | `taskId, reason` | Back to `pending`; dispatch. Unless `reason` is `busy`, the worker is added to `context.declined` and not offered the task again. |
| W→H | `status.update` | `state: 'idle'\|'busy'` | Idle triggers a dispatch pass. |

Messages for tasks not assigned to the sender are ignored and logged. The
existing `task.create`, `task.comment`, `task.strategy`, `task.synthesis` and
`message` handlers stay.

### 6.6 Review and escalation (fixes H6)

- The worker reports `review` with a PR link and test output. The hub
  notifies the task's creator (`kind = review_ready`).
- **Approve** (`cortex_task_review`, the dashboard, or legacy `PUT` with
  `approved`) → `completed`, completion chain, dispatch. Approving does not
  merge: dependents start from `baseBranch`, so when a dependent needs the
  approved code the lead merges the PR first, then approves (the orchestrator
  prompt says so). Stacking a dependent on its dependency's branch is out of
  scope.
- **Reject** with feedback → the same task returns to `pending`;
  `reject_count++`; `{at, by, verdict: 'reject', feedback}` is appended to
  `context.reviews`; branch and `last_agent` are kept, so the next attempt
  continues on the same branch, preferably on the same machine. Legacy
  `PUT … status: 'rejected'` maps to this; no "Revision:" subtask is created.
- At `reject_count = 2` or `fail_count = 2`: set `escalated_at`, notify the
  lead (`kind = escalated`), and show the task under "Needs you".

### 6.7 Quota and fallback

- Route chain: `[primary, ...(task.fallback ?? conductor.defaultFallback)]`.
  The lead orders it; to try another agy model before leaving agy, list it
  first.
- On `task.quota_exhausted`, the hub records the quota and returns the task.
  The next dispatch pass skips the exhausted route for that machine and takes
  the next route that has a worker. A route chain therefore runs across
  machines as well as models.
- `modelScope` lets the worker widen the record when it knows the quota is
  shared: the agy classifier sends the model id without its
  `-low|-medium|-high` suffix plus `*` (`claude-sonnet-5-5-*`). Whether agy's
  Claude models share one quota across Opus and Sonnet is not verified; if they
  do, one extra attempt is wasted before the next record covers it.
- Quota rows past `exhausted_until` are deleted by the scheduler, which then
  dispatches.
- The final fallback is the project default (D5). If it too is exhausted or
  missing, the task waits (`capacity`) and the lead is told once.

### 6.8 Leases and reclaim

`conductor/scheduler.ts` runs every 60 s (started from the dashboard-api
entry point, stopped in tests):

1. Tasks in `assigned`/`accepted`/`in_progress` whose `lease_expires_at` has
   passed → `task.revoked` to the worker if connected, then failure handling
   (`fail_count++`, `pending`, or escalate).
2. The same for tasks whose worker's `lastSeen` is older than
   `conductor.offlineReclaimMinutes` (D6).
3. Delete expired quota rows.
4. Run a dispatch pass.

A worker that reconnects with an `activeTaskId` that was reclaimed receives
`task.revoked` and stops.

### 6.9 Lead tools (hub-mcp)

| Tool | Purpose |
|---|---|
| `cortex_task_tree_create` *(new)* | Create a plan in one transaction. Input: optional `parentId` (attach under an existing task), `tasks: [{key, title, description?, kind?, parentKey?, dependsOn?: (key\|id)[], requiredCapabilities?, priority?, executor?, model?, effort?, fallback?, files?, branch?, pinnedAgent?, reviewRequired?, approver?, context?}]`. Validates unique keys, known references and that the dependency graph is acyclic (DFS; the error names the cycle). Returns `{key → id}` and the number of tasks ready now. Runs a dispatch pass. |
| `cortex_agents` *(new, read-only)* | Workers (host, OS, engines and models, capabilities, idle/busy, current task, quota until per model) plus MCP sessions from `session_handoffs` (agent, IDE, branch, last activity). The lead decides routing from this. |
| `cortex_task_review` *(new)* | `taskId, verdict: 'approve'\|'reject', feedback?`. Works on `review` tasks and on gates with `approver: 'lead'`; refuses `approver: 'user'` gates (D8). |
| `cortex_task_route` *(new)* | Change `executor`, `model`, `effort`, `fallback`, `pinnedAgent`, `priority`, `files` or `dependsOn` (cycle-checked) of a not-yet-completed task; `clearEscalation: true` resets the counters. An active task is revoked and returned to `pending` first. |
| `cortex_task_cancel` *(new)* | `taskId, reason?`. Cancels a task the lead gives up on (revokes it if active). Its dependents stay `blocked` until rerouted. Cancelling a group cancels every unfinished task under it; cancel the root group to stop a plan. |
| `cortex_task_create` *(fix)* | Maps priority labels to integers (critical 1, high 3, medium 5, low 8); accepts the routing fields; no longer pushes directly. |
| `cortex_task_list` *(fix)* | Sends `assigned_to` and `projectId`, which the route now reads; adds `key`, `kind`, `wait_reason`, `escalated` to each row. |
| `cortex_task_update` *(fix)* | Keeps its statuses; `review`/`completed`/`failed` go through `lifecycle.ts`; `message` is stored as a log row. |

### 6.10 Notifications (fixes H9)

- `lifecycle.ts` writes `conductor_notifications` rows with
  `recipient` = the task's `api_key_owner`, i.e. the key that created it
  (the lead's).
- `GET /api/metrics/hints/:agentId` returns `{hints, conductor}`; `conductor`
  holds up to 5 undelivered rows for that key, which are marked delivered.
- hub-mcp appends them after the hints as a separate block:
  `📋 Conductor:` followed by one line per notification, e.g.
  `TT3 "Inventory UI" is ready for review — PR #41 (tests 42/42)`.
- `apps/hub-mcp/src/notifications.ts` is deleted.
- With a key shared by the lead and the workers, whichever client calls a
  tool first receives the notice (D7). The dashboard always shows the same
  information.

### 6.11 REST changes (dashboard-api)

| Route | Change |
|---|---|
| `GET /api/conductor` | Reads `assigned_to`, `projectId`, `root` (a tree id) and `parent_task_id=none` (top-level only); returns the new columns. |
| `GET /api/conductor/:id/tree` *(new)* | The whole tree under `:id` (recursive CTE) with logs omitted, plus the workers for its project. |
| `POST /api/conductor/tree` *(new)* | Backend of `cortex_task_tree_create`. |
| `POST /api/conductor/:id/review` *(new)* | Approve or reject (tasks and gates). Refuses a `user` gate when `X-API-Key-Owner` is present (D8). |
| `POST /api/conductor/:id/route` *(new)* | Backend of `cortex_task_route`. |
| `GET /api/conductor/agents` | Adds engines, models, quota and current task per worker; adds MCP sessions. |
| `POST /api/conductor`, `PUT /:id`, `/auto-assign`, `/:id/cancel` | Go through `lifecycle.ts`; no direct pushes; cancel revokes an active task. |
| `/api/tasks` (task board) | `POST` with `assignTo`, `PATCH` status/assignee, `/:id/assign`, `/:id/cancel`, `DELETE` go through `lifecycle.ts` and the dispatcher instead of writing statuses directly. |

### 6.12 Worker runtime (`apps/conductor-worker`)

**Package and distribution.** `@cortex/conductor-worker`, TypeScript,
vitest. esbuild bundles `src/cli.ts` with `ws` into one
`dist/cortex-worker.mjs` (Node ≥ 20, no install step). The hub-mcp image builds
it (`infra/Dockerfile.hub-mcp` adds the package to the deps stage and the turbo
filter) and serves it at `GET /conductor/worker.mjs` and
`GET /conductor/worker.version` on the MCP port, from the Node entry
(`node.ts`; `index.ts` is also the Cloudflare Workers entry and cannot read
files). The code is public, so these routes need no key. hub-mcp's WebSocket
proxy forwards dashboard-api's close code to the worker (today it closes the
client with none, so 4000/4009 never arrive); a bad key is refused with HTTP
401 at the handshake, which the worker treats like 4003.

**Bootstraps.** `scripts/run-agent.sh` and `run-agent.ps1` become ~30-line
scripts: check Node ≥ 20 and git, download
`<hub>/conductor/worker.mjs` to `~/.cortex/worker/`, and run
`node cortex-worker.mjs "$@"`. The hub URL comes from `--hub`, then
`CORTEX_HUB_URL`, then a cached bundle's `cortex-worker hub-url` (the
worker's config detection exists only once it has been downloaded), else the
bootstrap stops and asks for `--hub`.
`cortex-agent.sh/.ps1` print a deprecation notice that points at them.

**Commands.** `start [--daemon] [--agent-id] [--repo <path>] [--engines
claude,agy] [--capabilities …] [--hub] [--api-key]`, `stop`, `status`,
`logs [-f]`, `doctor [--probe]`, `update`, `hub-url`. State and logs live in `~/.cortex/worker/<agentId>/` (PID file,
log, config), so several workers on one machine do not collide.

**Configuration detection.** In order: flags; env (`CORTEX_HUB_URL`,
`CORTEX_API_KEY`, `CORTEX_AGENT_ID`); the cortex-hub entry in the MCP configs
of Claude Code (`~/.claude.json`, including per-project `projects[path]
.mcpServers`), Codex (`~/.codex/config.toml`), agy
(`~/.gemini/antigravity/mcp_config.json`) and Cursor, in both the
`{url, headers}` form and the `mcp-remote` `args` form. The WebSocket URL is
the MCP base with `/mcp` replaced by `/ws/conductor` and `http` by `ws`.

**Task execution** (one at a time; a `task.assigned` while busy is answered
with `task.decline {reason: 'busy'}`):

1. `task.accept`.
2. `git fetch origin`; `git worktree add` under
   `~/.cortex/worker/<agentId>/wt/<taskId>` on the task branch, from
   `origin/<branch>` if it exists, else from `origin/<baseBranch>`. A fresh
   worktree has no installed dependencies, so an optional setup command
   (`context.setupCommand`, else `CORTEX_SETUP_CMD`) runs here; its failure is
   `failed` with its output.
3. Build the prompt: title, description, `files`, previous review feedback,
   handoff note, and the rules "do not commit, push, or switch branches; the
   worker does that".
4. Run the engine adapter in the worktree; stream its output as
   `task.progress` (a line at most every 5 s).
5. If `testCommand` (task context or `CORTEX_TEST_CMD`) is set, run it and keep
   the last 200 lines. A failing test command makes the task `failed`.
6. If the worktree has changes: commit as `<key>: <title>`, push, and open a
   PR with `gh pr create` when `gh` is authenticated, else report the compare
   URL. No changes → `failed` with "engine made no changes", unless the task
   says no changes are expected (`context.allowEmpty`).
7. `task.complete` with `completed` and the result (the hub turns it into
   `review` when the task requires review), or `failed` with the error.
   Remove the worktree; the branch stays.

**On quota:** commit the work in progress as `WIP <key>: quota handoff`,
push, send `task.quota_exhausted` with the handoff, remove the worktree.
**On revoke:** kill the engine process tree, then the same WIP push.

**Engine adapters** (`src/engines/*.ts`), each with `detect()`,
`models()`, `run({prompt, cwd, model, effort, signal})` and
`classify(exitCode, stdout, stderr)` → `ok | quota{resetAt?, modelScope?} |
error`:

| Executor | Command | Quota signal | Verified |
|---|---|---|---|
| `agy` | `agy -p <prompt> --model <m> --output-format stream-json --mode auto` (`accept-edits` on Windows; overridable), `--effort`, `--print-timeout` | exit 3, `result.status = "ERROR"` with "quota", `AGY_ERROR` with `RESOURCE_EXHAUSTED`/429; reset from `Resets in XhYmZs` | **Yes**, on this machine |
| `claude` | `claude -p <prompt> --model <m> --permission-mode auto --output-format stream-json --verbose` | "usage limit" / "rate limit" text with a reset time | No — patterns best effort |
| `codex` | `codex exec -m <m> --full-auto <prompt>` | "usage limit" / 429 text | No |
| `gemini` | `gemini -p <prompt> -m <m> -y` | `RESOURCE_EXHAUSTED` / 429 | No |

Model lists: `agy models`; for the others, a configurable list with `*`
meaning "any model id is passed through". Unknown failures are `error`, never
quota, so a misclassified failure escalates instead of looping.

`claude`, `codex` and `gemini` install as npm `.cmd` shims on Windows, where
cmd.exe cannot pass a multi-line argument and caps a command line at 8,191
characters. Those three therefore take the prompt on **stdin** on every OS;
the table shows the flags, not where the prompt goes. `agy` keeps `-p` (a
native binary); if a Windows install turns out to be a `.cmd`, it moves to
stdin too.

**Doctor** prints, per check, ok or the fix: Node version, git, `gh auth
status`, each engine found and logged in (a 1-token probe where cheap), hub
reachable, key valid, WebSocket handshake, repo has an `origin` and maps to a
hub project.

## 7. Part B — Dashboard

Based on the approved mock (`proposed.tsx`, screenshots shot-3/4).

- `/conductor` loads a tree with `GET /api/conductor/:id/tree` instead of a
  flat `limit: 200` list, and polls it.
- **Plan diagram** (replaces `PipelineDiagram`): columns by dependency depth;
  one lane per machine (tasks placed by `assigned_to_agent` or `last_agent`,
  unassigned in a "queue" lane); dependency edges from `depends_on`; gates as
  rounded dashed nodes; dashed orange edges between tasks that share `files`;
  the critical path (longest chain by `context.estimate`, default 1) outlined
  in red. Nodes show key, title, status pill, route chip
  (`agy·argon-low`), and the wait reason or fallback note.
- **Progress bar:** done / in review / running / ready / waiting / blocked,
  counted over work tasks.
- **Side panel:** *Needs you* (escalated tasks, user gates awaiting approval,
  `no_worker` tasks), *Workers* (online, idle/busy, current task, quota
  until), *Fallback tally* (tasks finished per executor·model).
- **Phase view:** when a group is selected, its tasks plus greyed "input"
  (dependencies outside the group) and "output" (dependents outside) columns.
- **Actions:** approve or reject a review or a user gate, clear an
  escalation, change route — through the new REST routes.
- **Agents Online** lists MCP sessions next to workers.

## 8. Part C — Setup and URLs

- `docs/conductor/setup.md` *(new)*: per OS — Node ≥ 20, git, `gh auth
  login`; installing and logging in to each engine, including agy
  (`curl … install.sh | bash`, PowerShell on Windows, `agy` once to log in);
  separate API keys for the lead and for workers; installing the worker with
  the bootstrap; `cortex-worker doctor`; running as a daemon. Includes a
  warning that `agy mcp list` prints MCP secrets in plain text and that
  the agy config should point at the current hub URL.
- Correct URLs everywhere: the extension's `resolveHubUrl` and
  `readMcpArgsUrl` read `url`/`headers` and append `/ws/conductor`; the agy
  MCP snippet uses the current hub; the Claude Code snippet includes
  `"type": "http"`.
- The dashboard shows a copyable bootstrap command with the hub URL filled in
  from `EXTERNAL_MCP_URL`.
- `scripts/orchestrator-prompt.md`: plan with `cortex_task_tree_create`;
  choose routes with `cortex_agents`; set `files` for lock safety; review with
  `cortex_task_review`; respond to escalations with `cortex_task_route`;
  branch and PR conventions.
- `docs/conductor.md`: status table updated; links to setup.

## 9. Migration and compatibility

- Columns are added on hub start; existing rows get `kind = 'work'`,
  `review_required = 0`, counters 0.
- Old workers still connect. They receive `task.assigned` (they already handle
  it) only for loose tasks with `executor` null, since they register no engines
  and a plan task needs protocol 2 (§6.4).
- Tasks already `in_progress` when the hub upgrades get a lease of
  now + `leaseHours`.
- `cortex_task_*` tools keep their names and inputs; new fields are optional.

## 10. Testing

- **dashboard-api** (vitest, in-memory SQLite + `schema.sql`, the pattern in
  `routes/conductor.test.ts`): dispatcher selection as a pure function (ready
  set, file locks, route order, quota match by prefix, pins, declines,
  stickiness); lifecycle transitions; registry replace/refuse/delete-only-own;
  protocol handlers with a fake socket; scheduler reclaim with a fixed clock;
  tree create with cycles; review and gate rejection.
- **hub-mcp** (vitest, mocked `fetch`): new tools' requests and output;
  priority mapping; the `📋 Conductor` block.
- **conductor-worker** (vitest): config detection fixtures for each MCP config
  format; each engine's `classify` against recorded output (the agy quota
  output from `scratchpad/agy-probe/`, stripped of anything personal); git flow
  against a temporary repo with a bare `origin`; protocol client against a
  local `ws` server.
- **End to end:** a script that starts the hub locally, a worker with a fake
  engine (a shell command that edits a file), and creates a three-task tree;
  asserts dispatch order, PR/compare URL, review, approve, and that a
  simulated quota exit moves the task to the fallback.
- Quality gates for every PR: `pnpm build && pnpm typecheck && pnpm lint`.

## 11. Risks

| Risk | Mitigation |
|---|---|
| Claude, Codex and Gemini quota messages are unverified. | Unknown output is `error`, so the worst case is an escalation, not a loop. Recorded fixtures are added when seen. |
| agy start-up is ~2 min (MCP servers). | Not a correctness issue; `doctor` reports it; users can trim agy's MCP list. |
| `--mode auto` soft-denies irreversible actions headless; Windows has no `auto`. | The worker owns git, so the engine never needs to push. Mode is configurable per engine. |
| Same-file locks are only as good as `files`. | Tasks without `files` never conflict; the dashboard marks them; the orchestrator prompt asks for `files`. |
| A shared API key splits notifications. | D7: separate keys documented; the dashboard shows everything regardless. A machine that runs both the lead and a worker shares the key unless the worker's engines get their own MCP config; the setup doc says so. |
| Hub restart forgets `lastSeen`. | Treated as the start time, so reclaim waits the full window. |

## 12. Plans

| Plan | File | Contents | Depends on |
|---|---|---|---|
| A1 Hub core | `2026-10-16-conductor-a1-hub-core.md` | §6.1–6.11 | — |
| A2 Worker runtime | `2026-10-16-conductor-a2-worker.md` | §6.12 | A1's protocol (§6.5) |
| B Dashboard | `2026-10-16-conductor-b-dashboard.md` | §7 | A1's REST (§6.11) |
| C Setup and URLs | `2026-10-16-conductor-c-setup.md` | §8 | A2 commands |

A2 and B can be built in parallel once A1's schema and protocol land.

## 13. Sources

- Antigravity CLI headless mode — https://antigravity.google/docs/cli/headless/
- Antigravity CLI getting started — https://antigravity.google/docs/getting-started?tab=cli
- Introducing Google Antigravity CLI — https://antigravity.google/blog/introducing-google-antigravity-cli/
- 9to5Google on Gemini 4 Argon (2026-10-15)
- SmartScope on Argon's 5-hour quota window
- openclaw issue #19822 (Antigravity quota errors)
- Local probes: `agy --version`, `agy models`, headless runs with Argon and
  with Claude Sonnet in agy (quota exhausted), 2026-10-16
