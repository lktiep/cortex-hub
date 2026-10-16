# Conductor A1 — Hub Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the hub dispatch a planned task tree to workers on several machines safely: a registry that survives reconnects, a pure dispatcher with routes, quota fallback and file locks, one lifecycle module for every state change, leases and reclaim, review and escalation, lead MCP tools, and lead notifications.

**Architecture:** New logic lives in `apps/dashboard-api/src/conductor/` as small modules: `registry` (connections), `dispatcher` (pure selection plus a thin apply), `lifecycle` (every transition), `tree` (plan creation and cycle checks), `scheduler` (60 s tick), `notify` (lead notifications). `ws/conductor.ts` and `routes/conductor.ts` shrink to transport and call into those modules. hub-mcp gains five lead tools and a `📋 Conductor` block on every tool answer. The wire protocol lives in `@cortex/shared-types` so the worker (plan A2) and dashboard (plan B) compile against the same types.

**Tech Stack:** TypeScript strict, Hono, better-sqlite3, `ws` 8, vitest 3, zod (hub-mcp tools).

**Spec:** `docs/superpowers/specs/2026-10-16-conductor-production-ready-design.md` (§6.1–§6.11, §9, §10). Read §6 before any task.

## Global Constraints

- TypeScript strict; camelCase functions and variables, PascalCase types; no `any` without a comment saying why.
- Statuses only from the existing `CHECK` list; no table rebuild. New fields are `ALTER TABLE … ADD COLUMN` (spec D3).
- Every status change of a `conductor_tasks` row goes through `src/conductor/lifecycle.ts` (or the dispatcher's conditional assign). Routes and WS handlers issue no `UPDATE conductor_tasks SET status …` of their own. Exception: the strategy flow (`analyzing`, `strategy_review`, matrix, finalize, synthesis) stays as it is.
- Every conductor transition writes a `conductor_task_logs` row.
- Priority labels → integers: `critical` 1, `high` 3, `medium` 5, `low` 8. Lower runs first.
- Hub config defaults (`hub_config` keys): `conductor.defaultFallback` = `[{"executor":"claude","model":"opus"}]` (seeded), `conductor.branchTemplate` = `cx/{key}-{slug}`, `conductor.baseBranch` = project `default_branch`, else `main`, `conductor.offlineReclaimMinutes` = 30, `conductor.leaseHours` = 24.
- Quota rows: default reset now + 1 h; `reason` truncated to 500 chars. Progress: last 50 log rows kept per task; lease extended at most once a minute. Hints: at most 5 notifications per call. Escalation at `fail_count = 2` or `reject_count = 2`.
- WebSocket close codes: 4001 missing key, 4003 bad key (or key scoped to another project), 4000 replaced by a newer connection from the same host, 4009 agent id in use on another host.
- Timestamps written by conductor code use `isoSeconds(ms)` (Task 1), the same `YYYY-MM-DDTHH:MM:SSZ` shape SQLite's `strftime` writes, so string comparisons in SQL are correct. Never write `toISOString()` (milliseconds) into a column that is compared.
- Tests: in-memory better-sqlite3 + `src/db/schema.sql`, `vi.mock('../db/client.js', () => ({ get db() { return testDb } }))`. Run one file with `pnpm --filter @cortex/dashboard-api exec vitest run <path>` or `pnpm --filter @cortex/hub-mcp exec vitest run <path>`. Build shared types first when they changed: `pnpm --filter @cortex/shared-types build`.
- Every commit step: run `pnpm build && pnpm typecheck && pnpm lint` from the repo root first (full build, never `--filter`); the repo's hooks refuse a commit without them. Stage only the task's files.

## Review Focus

1. **Two triggers dispatching at once** (a completion and a scheduler tick, or a `send()` that synchronously triggers another event). Expected: each task is assigned once, and a worker gets at most one task. Pinned by `dispatch is re-entrancy safe` (Task 6) and the conditional `WHERE status = 'pending'` assign.
2. **A worker reconnecting while its old socket is still closing, or after it was reclaimed.** Expected: the late close of the old socket does not remove the new connection; a stale `activeTaskId` gets `task.revoked`, not the task. Pinned by `late close of a replaced socket keeps the new one` (Task 3) and `stale activeTaskId is revoked` (Task 10).
3. **Windows paths in `files`** (`src\\inv\\a.ts`, `./src/inv/`). Expected: they lock against `src/inv/a.ts` like any other spelling. Pinned by `normalizes backslashes and ./ before comparing` (Task 4).
4. **Hub restart with tasks in flight.** Expected: active tasks without a lease get one of now + 24 h; no worker's task is reclaimed until 30 min after the hub started. Pinned by `restart: backfills leases and waits the full offline window` (Task 9).
5. **Old clients.** `cortex-agent.sh` (query-string identity, `agent.register`, flat `task.assigned`) and `cortex_task_create` sending `priority: "high"`. Expected: the old script receives only tasks with no `executor`, with the flat `taskId/title/description` it reads; the string priority is stored as 3. Pinned by `legacy worker gets only executor-null tasks with flat fields` (Task 10) and `POST / maps priority labels` (Task 12).

## Risks and rollback

- **Live hubs carry tasks in flight.** Every schema change is an additive `ADD COLUMN` with a default, run idempotently at start-up (Task 1), so a rollback to the previous image runs against the new database unchanged; the old code ignores the new columns and tables.
- **Old workers stay connected through the change.** `cortex-agent.sh`/`.ps1` keep receiving flat `task.assigned` for executor-null tasks (Task 10). A hub rolled back after workers upgraded to protocol 2 still accepts their connection (the old handler ignores `worker.register`), so the failure mode is "no dispatch", not data loss.
- **One lifecycle owns every transition.** The risk is a path left writing `status` directly; Task 12 and Task 13 delete those writes, and `rg "SET status" apps/dashboard-api/src/routes apps/dashboard-api/src/ws` must list only the strategy flow before Task 17 is called done.
- **Dispatch storms.** `dispatch()` runs on every trigger but is synchronous with a rerun flag, so a burst of events costs one pass plus at most one rerun (Task 6).
- **Wrong reclaim deletes nobody's work.** Reclaim only returns a task to `pending`; the branch and `last_agent` are kept, and the next attempt starts from the handoff branch (Tasks 7, 9).

---

## File map

| File | Responsibility |
|---|---|
| `packages/shared-types/src/conductor.ts` *(new)* | Wire protocol and REST view types (A2 and B import these) |
| `apps/dashboard-api/src/db/schema.sql` | New columns in `conductor_tasks`, new tables, config seed |
| `apps/dashboard-api/src/db/conductor-migrations.ts` *(new)* | `ALTER` list for existing hubs |
| `apps/dashboard-api/src/version.ts` *(new)* | `appVersion` (moved out of `index.ts`) |
| `apps/dashboard-api/src/lib/project-match.ts` *(new)* | Repo URL → project (extracted from `routes/quality.ts`) |
| `apps/dashboard-api/src/conductor/rows.ts` | `TaskRow`, JSON helpers, `isoSeconds`, task log writer |
| `apps/dashboard-api/src/conductor/config.ts` | Typed hub config with defaults |
| `apps/dashboard-api/src/conductor/testing.ts` | Test DB, row factory, fake socket (no vitest import) |
| `apps/dashboard-api/src/conductor/registry.ts` | Connections keyed by `connectionId`, `lastSeen`, sends |
| `apps/dashboard-api/src/conductor/files.ts` | Path normalisation and lock conflicts |
| `apps/dashboard-api/src/conductor/dispatcher.ts` | `selectAssignments` (pure), `dispatch()`, `pickForPull()` |
| `apps/dashboard-api/src/conductor/messages.ts` | `AssignedTask` / `task.assigned` builders, branch names |
| `apps/dashboard-api/src/conductor/notify.ts` | Notification rows and delivery |
| `apps/dashboard-api/src/conductor/lifecycle.ts` | All transitions, completion chain, review |
| `apps/dashboard-api/src/conductor/tree.ts` | Tree validation and creation, cycle search |
| `apps/dashboard-api/src/conductor/scheduler.ts` | Lease expiry, offline reclaim, quota cleanup |
| `apps/dashboard-api/src/ws/conductor.ts` | Protocol v2 transport; legacy handlers kept |
| `apps/dashboard-api/src/routes/conductor.ts` | REST transport |
| `apps/dashboard-api/src/routes/tasks.ts` | Legacy `/api/tasks` board routes call the lifecycle (Task 13) |
| `apps/dashboard-api/src/routes/stats.ts` | Hints endpoint returns `conductor` |
| `apps/hub-mcp/src/hint-blocks.ts` *(new)* | Appends 💡 and 📋 blocks |
| `apps/hub-mcp/src/tools/conductor-lead.ts` *(new)* | `cortex_task_tree_create`, `cortex_agents`, `cortex_task_review`, `cortex_task_route`, `cortex_task_cancel` |
| `apps/hub-mcp/src/tools/tasks.ts` | Fixes to `cortex_task_create` and `cortex_task_list` |
| `apps/hub-mcp/src/notifications.ts` *(deleted)* | Polled a `/api/tasks/notifications` route that does not exist (Task 14) |

---

### Task 1: Protocol types, schema, migrations, config, row helpers

**Files:**
- Create: `packages/shared-types/src/conductor.ts`; modify `packages/shared-types/src/index.ts` (add `export * from './conductor.js'`)
- Modify: `apps/dashboard-api/src/db/schema.sql` (`conductor_tasks` CREATE TABLE at ~106-128; new tables after `conductor_task_logs`; seed after the `hub_config` defaults ~168)
- Create: `apps/dashboard-api/src/db/conductor-migrations.ts`; modify `apps/dashboard-api/src/db/client.ts` (call it next to the conductor `api_key_owner` ALTER at ~111, before `schema.sql` runs)
- Create: `apps/dashboard-api/src/conductor/rows.ts`, `conductor/config.ts`, `conductor/testing.ts`
- Test: `apps/dashboard-api/src/db/conductor-migrations.test.ts`, `apps/dashboard-api/src/conductor/config.test.ts`

**Interfaces:**
- Produces (shared types, verbatim from the cross-plan contract):

```ts
export const CONDUCTOR_PROTOCOL_VERSION = 2
export type Executor = 'claude' | 'codex' | 'agy' | 'gemini'
export const EXECUTORS: readonly Executor[] = ['claude', 'codex', 'agy', 'gemini']
export const PRIORITY_LABELS = { critical: 1, high: 3, medium: 5, low: 8 } as const
export interface RouteSpec { executor: Executor | null; model: string | null; effort: string | null }
export interface EngineInfo { executor: Executor; models: string[]; defaultModel: string | null } // models may contain '*'
export interface TaskReview { at: string; by: string; verdict: 'approve' | 'reject'; feedback: string }
export interface TaskHandoff { branch: string; commit: string | null; note: string }
export interface TaskResult { summary: string; prUrl?: string; branch?: string; commit?: string; testOutput?: string; error?: string }
export interface AssignedTask {
  id: string; key: string | null; title: string; description: string
  context: Record<string, unknown>; files: string[]
  branch: string; baseBranch: string; route: RouteSpec
  attempt: number; leaseExpiresAt: string
  reviews: TaskReview[]; handoff: TaskHandoff | null; testCommand: string | null
}
// worker → hub
export interface WorkerRegisterMsg {
  type: 'worker.register'; protocol: number; version: string; hostname: string; os: string
  repo: string; capabilities: string[]; engines: EngineInfo[]; defaultExecutor: Executor | null
  activeTaskId?: string
}
export interface TaskAcceptMsg { type: 'task.accept'; taskId: string }
export interface TaskProgressMsg { type: 'task.progress'; taskId: string; message: string; percent?: number }
export interface TaskCompleteMsg { type: 'task.complete'; taskId: string; status: 'completed' | 'review' | 'failed'; result: TaskResult }
export interface TaskQuotaExhaustedMsg {
  type: 'task.quota_exhausted'; taskId: string; executor: Executor; model: string
  modelScope?: string; resetAt?: string; raw: string; handoff: TaskHandoff
}
export interface TaskDeclineMsg { type: 'task.decline'; taskId: string; reason: string }
export interface StatusUpdateMsg { type: 'status.update'; state: 'idle' | 'busy' }
export type WorkerToHubMsg = WorkerRegisterMsg | TaskAcceptMsg | TaskProgressMsg | TaskCompleteMsg
  | TaskQuotaExhaustedMsg | TaskDeclineMsg | StatusUpdateMsg
// hub → worker
export interface RegisteredMsg { type: 'registered'; connectionId: string; projectId: string | null; hubVersion: string }
export interface TaskAssignedMsg {
  type: 'task.assigned' | 'task.resumed'; task: AssignedTask
  taskId: string; title: string; description: string // flat copy for cortex-agent.sh/.ps1
}
export interface TaskRevokedMsg { type: 'task.revoked'; taskId: string; reason: string }
export type HubToWorkerMsg = RegisteredMsg | TaskAssignedMsg | TaskRevokedMsg
export const CLOSE_CODES = { replaced: 4000, missingKey: 4001, badKey: 4003, agentIdInUse: 4009 } as const
// REST views
export type WaitReason = 'capacity' | 'no_worker' | 'lock'
export interface WorkerView {
  agentId: string; apiKeyOwner: string; hostname?: string; ide?: string; platform?: string
  capabilities: string[]; status: 'idle' | 'busy'; connectedAt: string; lastPing: string
  connectionId: string; os: string | null; version: string | null; projectId: string | null
  engines: EngineInfo[]; defaultExecutor: Executor | null; currentTaskId: string | null
  quota: Array<{ executor: Executor; model: string; exhaustedUntil: string; reason: string | null }>
}
export interface SessionView {
  sessionId: string; agentId: string; hostname: string | null; ide: string | null
  branch: string | null; projectId: string | null; apiKeyName: string | null; lastActivity: string
}
export interface TreeTaskInput {
  key: string; title: string; description?: string; kind?: 'work' | 'gate' | 'group'
  parentKey?: string; dependsOn?: string[]; requiredCapabilities?: string[]
  priority?: number | keyof typeof PRIORITY_LABELS
  executor?: Executor; model?: string; effort?: string; fallback?: RouteSpec[]
  files?: string[]; branch?: string; pinnedAgent?: string; reviewRequired?: boolean
  approver?: 'user' | 'lead'; context?: Record<string, unknown>
}
export interface TreeCreateRequest { parentId?: string; projectId?: string; tasks: TreeTaskInput[] }
export interface TreeCreateResponse { ids: Record<string, string>; rootIds: string[]; ready: number }
export interface RoutePatch {
  executor?: Executor | null; model?: string | null; effort?: string | null; fallback?: RouteSpec[] | null
  pinnedAgent?: string | null; priority?: number | keyof typeof PRIORITY_LABELS; files?: string[]
  dependsOn?: string[]; clearEscalation?: boolean
}
export interface ReviewRequest { verdict: 'approve' | 'reject'; feedback?: string; by?: string }
```

- Produces (dashboard-api):
  - `applyConductorMigrations(db: Database.Database): void` — `db/conductor-migrations.ts`
  - `rows.ts`: `interface TaskRow` (every `conductor_tasks` column, JSON columns as `string`), `getTask(id: string): TaskRow | undefined`, `parseJson<T>(raw: string | null | undefined, fallback: T): T`, `interface TaskContext { reviews?: TaskReview[]; handoff?: TaskHandoff; declined?: string[]; testCommand?: string; estimate?: number; allowEmpty?: boolean; pull?: boolean; [k: string]: unknown }`, `taskContext(row: TaskRow): TaskContext`, `isoSeconds(ms?: number): string`, `logTask(taskId: string, agentId: string | null, action: string, message?: string): void`, `taskLabel(row: TaskRow): string` (= `task_key ?? id`), `ACTIVE_STATUSES = ['assigned', 'accepted', 'in_progress'] as const`, `LOCKING_STATUSES = [...ACTIVE_STATUSES, 'review'] as const`
  - `config.ts`: `interface ConductorConfig { defaultFallback: RouteSpec[]; branchTemplate: string; offlineReclaimMinutes: number; leaseHours: number }`, `getConductorConfig(): ConductorConfig`, `baseBranchFor(projectId: string | null): string`
  - `testing.ts`: `createTestDb(): Database.Database` (schema.sql applied), `insertTask(db, partial: Partial<TaskRow> & { id: string }): TaskRow`, `interface FakeSocket { sent: unknown[]; closed: { code: number; reason: string } | null; readyState: number; send(data: string): void; close(code?: number, reason?: string): void }`, `fakeSocket(): FakeSocket` (`send` pushes `JSON.parse(data)`; `close` sets `closed` and `readyState = 3`)

- [ ] **Step 1: Write the failing tests**

`conductor-migrations.test.ts`:
- `adds every new column to an old-shape table`: create `conductor_tasks` with only the pre-change columns (copy the current CREATE TABLE), insert one row, run `applyConductorMigrations(db)` twice (second run must not throw); `PRAGMA table_info(conductor_tasks)` includes `api_key_owner, task_key, kind, approver, executor, model, effort, fallback, files, branch, pinned_agent, review_required, attempt, fail_count, reject_count, current_route, lease_expires_at, wait_reason, wait_until, escalated_at, last_agent`; the old row reads `kind = 'work'`, `review_required = 0`, `attempt = 0`, `fail_count = 0`, `reject_count = 0`, `files = '[]'`.
- `schema.sql alone creates the same columns`: `createTestDb()` → same column list, plus tables `conductor_quota` and `conductor_notifications`, plus `hub_config` row `conductor.defaultFallback` = `[{"executor":"claude","model":"opus"}]`.

`config.test.ts` (mocks `../db/client.js`):
- `defaults`: `getConductorConfig()` → `{ defaultFallback: [{ executor: 'claude', model: 'opus', effort: null }], branchTemplate: 'cx/{key}-{slug}', offlineReclaimMinutes: 30, leaseHours: 24 }`.
- `reads overrides and ignores bad JSON`: set `conductor.leaseHours` = `'2'` and `conductor.defaultFallback` = `'not json'` → `leaseHours: 2`, `defaultFallback` back to the default.
- `baseBranchFor`: `conductor.baseBranch` set → that value; unset and project `default_branch = 'develop'` → `'develop'`; neither → `'main'`; `null` project → `'main'`.
- `isoSeconds(Date.UTC(2026, 9, 16, 8, 0, 0, 123))` → `'2026-10-16T08:00:00Z'`.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @cortex/dashboard-api exec vitest run src/db/conductor-migrations.test.ts src/conductor/config.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

- `shared-types/src/conductor.ts` exactly as above.
- `schema.sql`: add the 21 columns to the `conductor_tasks` CREATE TABLE (`kind TEXT DEFAULT 'work'`, `review_required INTEGER DEFAULT 0`, counters `INTEGER DEFAULT 0`, `files TEXT DEFAULT '[]'`, the rest nullable TEXT), the two tables and index from spec §6.1 verbatim, `CREATE INDEX IF NOT EXISTS idx_conductor_tasks_kind_status ON conductor_tasks(kind, status)`, and `INSERT OR IGNORE INTO hub_config (key, value) VALUES ('conductor.defaultFallback', '[{"executor":"claude","model":"opus"}]')`.
- `applyConductorMigrations`: one `ALTER TABLE conductor_tasks ADD COLUMN …` per column with the same types and defaults, each in its own try/catch (the file's existing idiom); move the existing `api_key_owner` ALTER into it.
- `config.ts`: read `hub_config` rows prefixed `conductor.`; a malformed value falls back to its default; route entries are normalised to `RouteSpec` (missing fields → `null`).

- [ ] **Step 4: Run them to verify they pass**

Run: `pnpm --filter @cortex/shared-types build && pnpm --filter @cortex/dashboard-api exec vitest run src/db/conductor-migrations.test.ts src/conductor/config.test.ts`
Expected: PASS. Also run `src/routes/conductor.test.ts` — still PASS (schema change only adds columns).

- [ ] **Step 5: Commit**

```bash
git add packages/shared-types/src/conductor.ts packages/shared-types/src/index.ts apps/dashboard-api/src/db apps/dashboard-api/src/conductor/rows.ts apps/dashboard-api/src/conductor/config.ts apps/dashboard-api/src/conductor/config.test.ts apps/dashboard-api/src/conductor/testing.ts
git commit -m "feat(conductor): protocol types, task columns, quota and notification tables"
```

---

### Task 2: Extract repo → project matching

**Files:**
- Create: `apps/dashboard-api/src/lib/project-match.ts`
- Modify: `apps/dashboard-api/src/routes/quality.ts:347-380` (call the helper; behaviour unchanged)
- Test: `apps/dashboard-api/src/lib/project-match.test.ts`; existing `src/routes/sessions-start.test.ts` must stay green

**Interfaces:**
- Produces: `interface ProjectMatch { id: string; name: string; orgId: string; defaultBranch: string | null }`, `findProjectByRepo(repo: string): ProjectMatch | null`, `normalizeRepo(repo: string): string` (the normalisation `quality.ts` applies today).

- [ ] **Step 1: Write the failing test** — `project-match.test.ts` inserts an org and a project `{ slug: 'cortex-hub', git_repo_url: 'https://github.com/lktiep/cortex-hub.git', default_branch: 'master' }` and asserts that each of `https://github.com/lktiep/cortex-hub.git`, `git@github.com:lktiep/cortex-hub.git`, `https://github.com/lktiep/cortex-hub` and `cortex-hub` returns `{ id, name, orgId, defaultBranch: 'master' }`, and that `https://github.com/other/unknown.git` returns `null`.
- [ ] **Step 2: Run it** — `pnpm --filter @cortex/dashboard-api exec vitest run src/lib/project-match.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement** — move the lookup at `quality.ts:347-380` (git URL match, then slug/name/LIKE fallback) into `findProjectByRepo`; `quality.ts` calls it and reads the fields it used before.
- [ ] **Step 4: Run** `src/lib/project-match.test.ts src/routes/sessions-start.test.ts` → PASS.
- [ ] **Step 5: Commit** — gates, then `git add apps/dashboard-api/src/lib/project-match.ts apps/dashboard-api/src/lib/project-match.test.ts apps/dashboard-api/src/routes/quality.ts && git commit -m "refactor(api): share repo-to-project matching"`

---

### Task 3: Worker registry

**Files:**
- Create: `apps/dashboard-api/src/conductor/registry.ts`
- Test: `apps/dashboard-api/src/conductor/registry.test.ts`

**Interfaces:**
- Consumes: `FakeSocket` (Task 1), shared `EngineInfo`, `Executor`, `CLOSE_CODES`.
- Produces:

```ts
export interface SocketLike { readyState: number; send(data: string): void; close(code?: number, reason?: string): void }
export interface WorkerConn {
  connectionId: string; ws: SocketLike; agentId: string; apiKeyOwner: string; apiKeyProjectId: string | null
  hostname: string; ide: string | null; platform: string | null; os: string | null; version: string | null
  protocol: 1 | 2; capabilities: string[]; engines: EngineInfo[]; defaultExecutor: Executor | null
  projectId: string | null; status: 'idle' | 'busy'; connectedAt: string; lastPing: string; idleSince: number
}
export type ConnInit = Pick<WorkerConn, 'ws' | 'agentId' | 'apiKeyOwner' | 'apiKeyProjectId' | 'hostname' | 'ide' | 'platform' | 'capabilities'>
export function addConnection(init: ConnInit, now?: number): { ok: true; conn: WorkerConn; replaced: boolean } | { ok: false; code: 4009; reason: string }
export function removeConnection(connectionId: string, now?: number): boolean
export function updateConnection(connectionId: string, patch: Partial<Omit<WorkerConn, 'connectionId' | 'ws' | 'agentId'>>): WorkerConn | undefined
export function getConnection(connectionId: string): WorkerConn | undefined
export function getByAgent(agentId: string): WorkerConn | undefined
export function listConnections(): WorkerConn[]
export function touch(connectionId: string, now?: number): void
export function lastSeen(agentId: string, now?: number): number
export function setStatus(agentId: string, status: 'idle' | 'busy', now?: number): void
export function sendTo(agentId: string, msg: object): boolean
export function broadcastToOwner(owner: string, msg: object, excludeAgentId?: string): void
export function resetRegistry(startedAt?: number): void
```

- [ ] **Step 1: Write the failing tests** (`registry.test.ts`, `beforeEach(() => resetRegistry(1_000))`):
- `replaces a connection from the same host`: add `w1@h1` (socket A), add `w1@h1` (socket B) → second result `replaced: true`; A `closed` = `{ code: 4000, reason: 'replaced' }`; `getByAgent('w1').ws === B`.
- `refuses the same agent id from another host`: add `w1@h1`, add `w1@h2` → `{ ok: false, code: 4009, reason: 'agent id in use on h1' }`; the h1 connection is untouched.
- `late close of a replaced socket keeps the new one`: replace A with B, then `removeConnection(A.connectionId)` → `false`; `getByAgent('w1')` is still B.
- `lastSeen`: connected → `now`; after `removeConnection(id, 5_000)` → `5_000`; never seen → registry start (`1_000`).
- `sendTo skips closed sockets`: `readyState = 3` → `false`, nothing in `sent`.
- `setStatus('w1','idle', 7_000)` sets `idleSince = 7_000`; setting idle again keeps it.

- [ ] **Step 2: Run** `pnpm --filter @cortex/dashboard-api exec vitest run src/conductor/registry.test.ts` → FAIL.
- [ ] **Step 3: Implement** — `Map<connectionId, WorkerConn>` plus `Map<agentId, connectionId>` and `Map<agentId, number>` for `lastSeen`; `connectionId` from `randomUUID()`; new connections start `protocol: 1`, `engines: []`, `status: 'idle'`. `broadcastToOwner` keeps the semantics of today's function in `ws/conductor.ts:679`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — gates, then `git add apps/dashboard-api/src/conductor/registry.ts apps/dashboard-api/src/conductor/registry.test.ts && git commit -m "feat(conductor): connection registry keyed by connection id"`

---

### Task 4: Dispatcher selection (pure)

**Files:**
- Create: `apps/dashboard-api/src/conductor/files.ts`, `apps/dashboard-api/src/conductor/dispatcher.ts` (selection part only)
- Test: `apps/dashboard-api/src/conductor/files.test.ts`, `apps/dashboard-api/src/conductor/select.test.ts`

**Interfaces:**
- Consumes: `RouteSpec`, `EngineInfo`, `WaitReason` (Task 1).
- Produces:

```ts
// files.ts
export function normalizePath(p: string): string            // '\\'→'/', strip leading './', collapse '//'; keeps a trailing '/'
export function normalizeFiles(paths: string[]): string[]    // throws Error('globs are not supported: <p>') on * ? [
export function pathsConflict(a: string[], b: string[]): boolean

// dispatcher.ts
export interface CandidateTask {
  id: string; projectId: string | null; priority: number; createdAt: string
  dependsOn: string[]; requiredCapabilities: string[]; files: string[]
  routes: RouteSpec[]; pinnedAgent: string | null; declined: string[]; lastAgent: string | null
}
export interface CandidateWorker {
  agentId: string; host: string; projectId: string | null; protocol: 1 | 2
  capabilities: string[]; engines: EngineInfo[]; busy: boolean; idleSince: number
}
export interface QuotaRow { host: string; executor: string; model: string; exhaustedUntil: string }
export interface SelectionInput {
  pending: CandidateTask[]; completedIds: ReadonlySet<string>; lockedFiles: string[][]
  workers: CandidateWorker[]; quota: QuotaRow[]; now: string
}
export interface Assignment { taskId: string; agentId: string; route: RouteSpec }
export interface Wait { taskId: string; reason: WaitReason | null; until: string | null }
export function routeChain(primary: RouteSpec, fallback: RouteSpec[] | null, defaultFallback: RouteSpec[]): RouteSpec[]
export function quotaModelMatches(pattern: string, model: string): boolean
export function selectAssignments(input: SelectionInput): { assign: Assignment[]; wait: Wait[] }
```

Rules `selectAssignments` must follow (spec §6.4):
- Ready = every `dependsOn` id in `completedIds`, and `files` do not conflict with `lockedFiles` or with a task assigned earlier in the same pass. Sort by `priority` ASC, then `createdAt` ASC.
- Static eligibility of a worker for a route: project (a worker with `projectId` matches tasks of that project or with `projectId` null; a `protocol: 1` worker matches any project); not in `declined`; equals `pinnedAgent` when set; has every required capability; executor (route `executor` null and `model` null → any worker, including one with no engines; `executor` null with a `model` → some engine lists it or `*`; `executor` set → that engine is present and lists the model or `*`, or the route `model` is null).
- Quota: blocked when a row for (worker host, route executor, model) has `exhaustedUntil > now` and `quotaModelMatches(row.model, routeModel)`. A route with `model` null is checked against the engine's `defaultModel`, then `*` rows only.
- First route with an eligible, idle, not-yet-used, unblocked worker wins; prefer `lastAgent`, then the smallest `idleSince`.
- Not assigned → one `Wait` per task: lock → `lock`; no statically eligible worker on any route → `no_worker`; every statically eligible worker on every route is quota-blocked → `capacity` with `until` = the earliest `exhaustedUntil` among the blocking rows; otherwise (eligible workers exist but are busy or used this pass) `reason: null`.
- Assigned tasks also get a `Wait` with `reason: null` (so a stale reason is cleared).

- [ ] **Step 1: Write the failing tests**

`files.test.ts`:
- `normalizes backslashes and ./ before comparing`: `pathsConflict(['src\\inv\\a.ts'], ['./src/inv/a.ts'])` → `true`.
- `directory prefix`: `pathsConflict(['src/inv/'], ['src/inv/a.ts'])` → `true`; `pathsConflict(['src/inv/'], ['src/inventory.ts'])` → `false`; `pathsConflict([], ['x'])` → `false`.
- `rejects globs`: `normalizeFiles(['src/*.ts'])` throws `globs are not supported: src/*.ts`.

`select.test.ts` (no DB; plain objects; helper `task(id, over?)`, `worker(id, over?)`):
- `skips tasks whose dependencies are not complete`.
- `orders by priority then age`: priorities 5 and 1, one worker → the priority-1 task.
- `one task per worker per pass` and `skips busy workers`.
- `file lock against active tasks and within the pass`: `lockedFiles: [['src/a.ts']]` → task with `src/a.ts` gets `{ reason: 'lock' }`; two ready tasks both on `src/b/` with two workers → only the first is assigned, the second waits `lock`.
- `falls back along the route chain`: routes `[agy/gemini-4-argon-low, claude/opus]`; worker `h1` has both engines; quota row `{ host: 'h1', executor: 'agy', model: 'gemini-4-argon-*' }` until the future → assigned with `claude/opus`.
- `quota pattern match`: `quotaModelMatches('claude-sonnet-5-5-*', 'claude-sonnet-5-5-low')` → `true`; `('*', 'x')` → `true`; `('gemini-4-argon-low', 'gemini-4-argon-high')` → `false`.
- `quota is per host`: same row on `h1`; a second worker on `h2` with agy → assigned to the `h2` worker on the primary route.
- `capacity wait names the earliest reset`: all routes blocked until `T1` and `T2` (`T1 < T2`) → `{ reason: 'capacity', until: T1 }`.
- `no_worker when no engine fits`: route `codex/*`, workers have only `claude` → `{ reason: 'no_worker' }`.
- `pins and declines`: `pinnedAgent: 'w2'` → only `w2`; `declined: ['w1']` with only `w1` → `no_worker`.
- `prefers the last agent, then the longest idle`: two eligible workers, `lastAgent: 'w2'` → `w2`; without `lastAgent` → the one with the smaller `idleSince`.
- `legacy worker takes only executor-null routes`: `protocol: 1`, no engines; task with route `{executor: null, model: null}` → assigned; task with `executor: 'claude'` → `no_worker`.
- `routeChain`: `fallback: null` → primary + `defaultFallback`; `fallback: []` → primary only; duplicates removed.

- [ ] **Step 2: Run** `pnpm --filter @cortex/dashboard-api exec vitest run src/conductor/files.test.ts src/conductor/select.test.ts` → FAIL.
- [ ] **Step 3: Implement** `files.ts` and the pure half of `dispatcher.ts` per the rules above. No DB import in this half of the file is used by these functions.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — gates, then `git add apps/dashboard-api/src/conductor/files.ts apps/dashboard-api/src/conductor/files.test.ts apps/dashboard-api/src/conductor/dispatcher.ts apps/dashboard-api/src/conductor/select.test.ts && git commit -m "feat(conductor): pure dispatcher selection with routes, quota and file locks"`

---

### Task 5: Notifications store

**Files:**
- Create: `apps/dashboard-api/src/conductor/notify.ts`
- Test: `apps/dashboard-api/src/conductor/notify.test.ts`

**Interfaces:**
- Consumes: `TaskRow`, `taskLabel` (Task 1).
- Produces:

```ts
export type NotificationKind = 'review_ready' | 'escalated' | 'capacity' | 'gate_ready' | 'no_worker'
export function notifyLead(task: TaskRow, kind: NotificationKind, message: string): void   // recipient = task.api_key_owner; skipped when null
export function takeNotifications(recipient: string, limit?: number): string[]            // default 5; oldest first; marks delivered in one transaction
export function formatNotification(kind: NotificationKind, task: TaskRow, detail: Record<string, string | number | null>): string
```

Message copy (exact; `{label}` = `taskLabel(task)`):
- `review_ready`: `{label} "{title}" is ready for review — {prUrl | branch}` plus ` (tests attached)` when `testOutput` is non-empty.
- `escalated`: `{label} "{title}" needs you: {n} {failures|rejections} — last: {reason, first 200 chars}. Clear with cortex_task_route clearEscalation.`
- `capacity`: `{label} "{title}" is waiting for capacity: every route is out of quota until {until}.`
- `no_worker`: `{label} "{title}" has no connected worker that can run it ({routes, e.g. agy/gemini-4-argon-low → claude/opus}).`
- `gate_ready`: `{label} "{title}" is waiting for approval by the user in the dashboard.` for `approver = 'user'`, else `{label} "{title}" is waiting for your approval (cortex_task_review).`

- [ ] **Step 1: Write the failing tests**: `skips tasks without an owner` (no row); `delivers at most five, oldest first, then marks them` (insert 7 for `lead-key`, `takeNotifications('lead-key')` → 5 strings in insertion order, a second call → the remaining 2, a third → `[]`); `does not deliver another key's rows`; one `formatNotification` assertion per kind with the exact strings above (e.g. `TT3 "Inventory UI" is ready for review — https://github.com/o/r/pull/41 (tests attached)`).
- [ ] **Step 2: Run** `src/conductor/notify.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — gates, then `git add apps/dashboard-api/src/conductor/notify.ts apps/dashboard-api/src/conductor/notify.test.ts && git commit -m "feat(conductor): lead notification store"`

---

### Task 6: Dispatch apply and the assignment message

**Files:**
- Create: `apps/dashboard-api/src/conductor/messages.ts`
- Modify: `apps/dashboard-api/src/conductor/dispatcher.ts` (add the DB half)
- Test: `apps/dashboard-api/src/conductor/dispatch.test.ts`, `apps/dashboard-api/src/conductor/messages.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 3, 4, 5.
- Produces:

```ts
// messages.ts
export function slugify(title: string): string                 // lowercase ASCII, non-alphanumerics → '-', trimmed, max 40
export function branchFor(task: TaskRow, template: string): string  // {key} = task_key sanitised to [A-Za-z0-9._-], else id without 'task_' prefix, first 8 chars
export function toAssignedTask(task: TaskRow, baseBranch: string): AssignedTask
export function assignedMsg(task: TaskRow, baseBranch: string, type: 'task.assigned' | 'task.resumed'): TaskAssignedMsg

// dispatcher.ts (DB half)
export function dispatch(now?: number): Assignment[]
export function loadSelectionInput(now: number): SelectionInput
export function pickForPull(identity: { agentId?: string; apiKeyOwner?: string; sessionAgent?: string }, now?: number): TaskRow | null
```

`dispatch()` (spec §6.4):
- Synchronous. A call while one runs sets a `rerun` flag; the running call loops once more instead of nesting.
- Candidates: `kind = 'work' AND status = 'pending' AND escalated_at IS NULL`. `lockedFiles` from tasks in `LOCKING_STATUSES`. Workers from the registry; `busy` = registry `status = 'busy'` or the agent has a task in `ACTIVE_STATUSES`.
- Each assignment in one transaction: `UPDATE … SET status = 'assigned' … WHERE id = ? AND status = 'pending'`; when it changes no row, skip the task. Also set `assigned_to_agent`, `assigned_at`, `attempt = attempt + 1`, `current_route`, `lease_expires_at = now + leaseHours`, `last_agent`, `branch` (`branchFor` when empty), `wait_reason = NULL`, `wait_until = NULL`; log `assigned`. After the commit, `sendTo(agentId, assignedMsg(…, 'task.assigned'))`; if the send fails, return the task to `pending` through `lifecycle.returnTask(…, 'send failed')` (Task 7 defines it; until Task 7 lands, revert the row inline in the same function and replace it in Task 7).
- Waits: write `wait_reason`/`wait_until`; when a task's reason changes to `capacity` or `no_worker`, `notifyLead` once (the change is the dedupe — the same reason again sends nothing).

`pickForPull` (spec §6.4 pull mode): first ready task (same ready rules, file locks included) that is pinned to the caller (match with the existing `agentMatchesAssignment` helper, moved here from `routes/conductor.ts`) or unpinned with `executor IS NULL`. Assigns it as `accepted` with the same conditional update, sets `context.pull = true`, lease, `attempt + 1`, `last_agent`.

- [ ] **Step 1: Write the failing tests**

`messages.test.ts`: `branchFor({ task_key: 'TT3', title: 'Inventory UI: grid & drag' }, 'cx/{key}-{slug}')` → `cx/TT3-inventory-ui-grid-drag`; no key, id `task_0123456789abcdef` → `cx/01234567-…`; `assignedMsg` carries `task.reviews` from `context.reviews`, `handoff` from `context.handoff`, `testCommand` from `context.testCommand`, and the flat `taskId/title/description`.

`dispatch.test.ts` (test DB, `resetRegistry`, fake sockets registered with `addConnection` + `updateConnection({ protocol: 2, engines, projectId })`):
- `assigns, sets lease and branch, and pushes task.assigned`: one pending task, one idle worker → row `status = 'assigned'`, `attempt = 1`, `lease_expires_at` = now + 24 h (string compare), `branch` set, `current_route` JSON; socket received one `task.assigned` whose `task.id` matches.
- `dispatch is re-entrancy safe`: the fake socket's `send` calls `dispatch()` again; two pending tasks, two workers → each task assigned exactly once, each socket received exactly one message.
- `a worker with an active task is busy`: worker already has an `in_progress` task → nothing sent.
- `a task in review does not make its worker busy`.
- `send failure returns the task`: socket `readyState = 3` → row back to `pending`, `assigned_to_agent` null.
- `capacity notifies once`: all routes quota-blocked → `wait_reason = 'capacity'`, one notification; `dispatch()` again → still one.
- `pickForPull`: task pinned to `claude-code` and an unpinned `executor = 'agy'` task → the pinned one is returned as `accepted` with `context.pull = true`; with only the `agy` task → `null`.

- [ ] **Step 2: Run** `src/conductor/messages.test.ts src/conductor/dispatch.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS, and `src/conductor/select.test.ts` still PASS.
- [ ] **Step 5: Commit** — gates, then `git add apps/dashboard-api/src/conductor/messages.ts apps/dashboard-api/src/conductor/messages.test.ts apps/dashboard-api/src/conductor/dispatcher.ts apps/dashboard-api/src/conductor/dispatch.test.ts && git commit -m "feat(conductor): transactional dispatch with leases, branches and pull mode"`

---

### Task 7: Lifecycle — attempts, failures, quota, revoke

**Files:**
- Create: `apps/dashboard-api/src/conductor/lifecycle.ts` (attempt half)
- Modify: `apps/dashboard-api/src/conductor/dispatcher.ts` (send failure → `returnTask`)
- Test: `apps/dashboard-api/src/conductor/lifecycle-attempts.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 3, 5, 6.
- Produces:

```ts
export type Outcome = { ok: true; task: TaskRow } | { ok: false; status: 403 | 404 | 409; error: string }
export function acceptTask(taskId: string, agentId: string): Outcome
export function recordProgress(taskId: string, agentId: string, message: string, percent?: number, now?: number): Outcome
export function completeTask(taskId: string, agentId: string | null, status: 'completed' | 'review' | 'failed', result: TaskResult): Outcome
export function failAttempt(taskId: string, agentId: string | null, error: string): Outcome
export function returnTask(taskId: string, reason: string): Outcome                         // back to pending, nothing counted
export function quotaExhausted(taskId: string, agentId: string, msg: TaskQuotaExhaustedMsg, now?: number): Outcome
export function declineTask(taskId: string, agentId: string, reason: string): Outcome
export function revokeTask(taskId: string, reason: string): void                            // sends task.revoked if the assignee is connected
export function cancelTask(taskId: string, by: string | null): Outcome
```

Rules:
- Owner check: `acceptTask`, `recordProgress`, `completeTask` (when `agentId` is not null), `quotaExhausted`, `declineTask` act only when the task is in `ACTIVE_STATUSES` and `assigned_to_agent = agentId`; otherwise `409`, a log row `ignored`, and no change. `completeTask` with `agentId: null` (REST/MCP callers) skips the owner check but still needs an active or `review` status.
- `acceptTask`: `assigned → accepted`, `accepted_at`.
- `recordProgress`: log `progress`; keep the newest 50 `progress` rows per task; `accepted → in_progress`; extend `lease_expires_at` to now + `leaseHours` only when the stored lease is more than 60 s older than that.
- `completeTask`: `failed` → `failAttempt(result.error ?? result.summary)`. `completed` with `review_required = 1`, or `review` → status `review`, `result` stored, `notifyLead(review_ready)`. `completed` with `review_required = 0` → `completed`, `completed_at`, `completed_by`, then `onCompleted` (Task 8; until it lands, a no-op hook). Every path: `setStatus(agent, 'idle')`, then `dispatch()`.
- Return to pending (shared by fail, quota, decline, return, reclaim): `status = 'pending'`, `assigned_to_agent = NULL`, `lease_expires_at = NULL`, keep `branch`, `last_agent`, `attempt`.
- `failAttempt`: `fail_count + 1`; at 2 set `escalated_at` and `notifyLead(escalated)`.
- `quotaExhausted`: upsert `conductor_quota (host of the agent's connection, executor, modelScope ?? model)` with `exhausted_until = resetAt ?? now + 1 h` (keep the later of the stored and new value) and `reason = raw.slice(0, 500)`; `context.handoff = msg.handoff`; return to pending with no count.
- `declineTask`: return to pending; unless `reason === 'busy'`, append the agent to `context.declined`; for `busy`, `setStatus(agent, 'busy')`.
- `cancelTask`: revoke when active, set `cancelled`, then run the parent check (Task 8 hook).

- [ ] **Step 1: Write the failing tests**: `accept only by the assignee` (`w2` accepting `w1`'s task → 409, status unchanged); `first progress moves accepted to in_progress and extends the lease once a minute` (two calls 30 s apart → one lease update; a third 61 s later → updated); `progress keeps the last 50 rows`; `completed with review_required goes to review and notifies the creator`; `completed without review completes`; `failed twice escalates` (`fail_count` 2, `escalated_at` set, status `pending`, one `escalated` notification, `dispatch` skips it); `quota exhaustion records host scope, stores the handoff and returns the task without a failure`; `quota keeps the later reset`; `decline busy marks the worker busy and does not record a decline`; `decline other records the worker in context.declined`; `cancel revokes an active task` (socket receives `{ type: 'task.revoked', taskId, reason: 'cancelled' }`); `a duplicate task.complete is ignored` (the same worker sends `completed` twice: the second returns 409, writes one `ignored` log row and changes nothing — plan A2 re-sends an unconfirmed outcome after a reconnect and relies on this).
- [ ] **Step 2: Run** `src/conductor/lifecycle-attempts.test.ts` → FAIL.
- [ ] **Step 3: Implement**; replace Task 6's inline revert with `returnTask`.
- [ ] **Step 4: Run** it and `src/conductor/dispatch.test.ts` → PASS.
- [ ] **Step 5: Commit** — gates, then `git add apps/dashboard-api/src/conductor/lifecycle.ts apps/dashboard-api/src/conductor/lifecycle-attempts.test.ts apps/dashboard-api/src/conductor/dispatcher.ts && git commit -m "feat(conductor): lifecycle for attempts, failures, quota and revoke"`

---

### Task 8: Lifecycle — completion chain, groups, gates, review

**Files:**
- Modify: `apps/dashboard-api/src/conductor/lifecycle.ts`
- Test: `apps/dashboard-api/src/conductor/lifecycle-review.test.ts`

**Interfaces:**
- Produces:

```ts
export function onCompleted(task: TaskRow): void
export function reviewTask(taskId: string, req: ReviewRequest, via: 'mcp' | 'dashboard'): Outcome
```

Rules (spec §6.2, §6.6):
- `onCompleted`: (1) every `blocked` task whose `depends_on` contains the id and whose dependencies are now all `completed` → `pending` (a gate becoming `pending` sends `gate_ready`); (2) the legacy `notify_on_complete` behaviour from `routes/conductor.ts:146-163`; (3) parent check; (4) `dispatch()`. Carries the existing re-entrancy guard (`_resolving`).
- Parent check: parent `kind = 'group'` → `completed` when every non-cancelled child is `completed`; `cancelled` when every child is cancelled; then `onCompleted(parent)`. A legacy parent (`kind = 'work'`) keeps `checkParentCompletion` behaviour from `routes/conductor.ts:180-256` (synthesis with an assignee, auto-complete without one), moved here.
- `reviewTask` on a `work` task in `review`: approve → `completed`, `completed_at`, `onCompleted`; reject → append `{ at, by, verdict: 'reject', feedback }` to `context.reviews`, `reject_count + 1`, return to pending keeping `branch` and `last_agent`; at 2 → escalate. Any other status → 409.
- On a `gate` in `pending`: `approver = 'user'` and `via = 'mcp'` → 403 `user gates are approved in the dashboard`. Approve → `completed` + `onCompleted`. Reject → each direct dependency with `kind = 'work'` gets the review entry, `reject_count + 1` (escalating at 2) and returns to `pending`; the gate returns to `blocked`.
- `by` defaults to `'dashboard'` for `via = 'dashboard'`, else the caller's key name.

- [ ] **Step 1: Write the failing tests**: `completion unblocks a dependent only when all its deps are done`; `a gate with completed deps becomes pending and notifies gate_ready`; `group completes when its children complete and unblocks its dependents` (A, B in group G; C depends on G → C pending after A and B complete); `group with all children cancelled is cancelled`; `legacy parent with an assignee enters synthesis`; `approve completes and dispatches the dependent`; `reject returns the same task with feedback on the same branch` (status `pending`, same `branch`, `context.reviews[0].feedback` = the text, no new task row); `second rejection escalates`; `lead approves a lead gate over MCP`; `user gate refused over MCP` (403, unchanged) and `approved from the dashboard`; `gate rejection returns its work dependencies and re-blocks the gate`; `review on a pending work task is 409`.
- [ ] **Step 2: Run** `src/conductor/lifecycle-review.test.ts` → FAIL.
- [ ] **Step 3: Implement**; delete `resolveCompletionChain`/`checkParentCompletion` from `routes/conductor.ts` and point their callers at `onCompleted`.
- [ ] **Step 4: Run** it, `lifecycle-attempts.test.ts` and `src/routes/conductor.test.ts` → PASS.
- [ ] **Step 5: Commit** — gates, then `git add apps/dashboard-api/src/conductor/lifecycle.ts apps/dashboard-api/src/conductor/lifecycle-review.test.ts apps/dashboard-api/src/routes/conductor.ts && git commit -m "feat(conductor): completion chain, groups, gates and review in one place"`

---

### Task 9: Scheduler

**Files:**
- Create: `apps/dashboard-api/src/conductor/scheduler.ts`
- Modify: `apps/dashboard-api/src/index.ts` (call `scheduleConductor()` next to `scheduleSessionExpiry()` at ~339)
- Test: `apps/dashboard-api/src/conductor/scheduler.test.ts`

**Interfaces:**
- Produces: `runSchedulerTick(now?: number): { leasesBackfilled: number; reclaimed: string[]; quotaDeleted: number }`, `scheduleConductor(intervalMs?: number): () => void` (default 60 000; returns a stop function; the timer is `unref()`ed).

Tick order (spec §6.8): (0) tasks in `ACTIVE_STATUSES` with `lease_expires_at IS NULL` get now + `leaseHours`; (1) expired lease → `revokeTask(id, 'lease expired')` + `failAttempt(id, null, 'lease expired')`; (2) assignee not connected, task not `context.pull`, and `lastSeen(assignee) < now − offlineReclaimMinutes` → `failAttempt(id, null, 'worker offline')`; (3) delete quota rows with `exhausted_until <= now`; (4) `dispatch(now)`.

- [ ] **Step 1: Write the failing tests** (fixed clock; `resetRegistry(start)`): `expired lease is revoked and counted` (connected worker's socket receives `task.revoked`, `fail_count = 1`, `pending`); `offline worker loses its task after 30 min` (29 min → kept; 31 min → `pending`); `pull tasks are not reclaimed as offline`; `restart: backfills leases and waits the full offline window` (`resetRegistry(T)`, active task without lease, unknown worker; tick at T + 1 min → lease = T + 1 min + 24 h and not reclaimed; tick at T + 31 min → reclaimed); `expired quota rows are deleted and the waiting task dispatches`.
- [ ] **Step 2: Run** `src/conductor/scheduler.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — gates, then `git add apps/dashboard-api/src/conductor/scheduler.ts apps/dashboard-api/src/conductor/scheduler.test.ts apps/dashboard-api/src/index.ts && git commit -m "feat(conductor): scheduler for leases, offline reclaim and quota expiry"`

---

### Task 10: Worker protocol v2 over WebSocket

**Files:**
- Create: `apps/dashboard-api/src/version.ts` (move `appVersion` from `index.ts:8-20`; `index.ts` imports it)
- Modify: `apps/dashboard-api/src/ws/conductor.ts` (connection handler :55-195, `handleMessage` :200-370, exports :679-850)
- Test: `apps/dashboard-api/src/ws/conductor.test.ts`

**Interfaces:**
- Consumes: registry (Task 3), lifecycle (Tasks 7-8), dispatcher (Task 6), `findProjectByRepo` (Task 2), `appVersion`.
- Produces: `setupConductorWebSocket(server: Server): WebSocketServer` (now returns the server so tests can close it). Keeps exporting `getAllConnectedAgents(): WorkerView[]` (additive shape: the old fields plus the new ones; `quota` and `currentTaskId` read from the DB), `notifyAgents`, `broadcastStrategyReady`, `broadcastComment`, `setAgentStatus` for existing callers.
- `pushTaskToAgent(agentId, taskId, title, description): boolean` keeps its signature (callers: `routes/tasks.ts:126`, `routes/conductor.ts:138, 232, 358, 434, 630`) but stops sending on its own: when the task is `pending`, or `assigned` with `lease_expires_at IS NULL` (the legacy direct-assign rows), it sets `pinned_agent = agentId`, returns the row to `pending` through `returnTask` and runs `dispatch()`, answering whether the task ended assigned to that agent. For any other status (the strategy flow, `synthesis`) it sends the flat legacy `task.assigned` exactly as today. `notifyTaskAssigned` has no callers; delete it. Tasks 12 and 13 move the routes off the shim; `routes/tasks.ts` POST and the delegation path may keep it.

Behaviour (spec §6.3, §6.5):
- Connect: as today (4001/4003), selecting `name, project_id` from `api_keys`; `addConnection`; a 4009 result closes the new socket with that code and reason. Keep the `welcome` message and the `agent.online` broadcast. No re-push on connect. A `protocol: 1` connection triggers one `dispatch()`.
- `worker.register`: resolve `projectId` with `findProjectByRepo(msg.repo)`; if the key has `project_id` and it differs → close 4003 `key is scoped to another project`. Update the connection (`protocol: 2`, `os`, `version`, `capabilities`, `engines`, `defaultExecutor`, `projectId`) and send `registered`. Then: `activeTaskId` still active and assigned to this agent → `task.resumed`; `activeTaskId` otherwise → `task.revoked` with reason `reclaimed`; no `activeTaskId` but the DB holds an active task for this agent → `failAttempt(id, agent, 'worker restarted without the task')`. Finally `dispatch()`.
- `task.accept|progress|complete|quota_exhausted|decline` → the lifecycle functions; `status.update` → `setStatus`, and `idle` → `dispatch()`.
- Close and keepalive call `removeConnection(connectionId)`; the `agent.offline` broadcast is sent only when it returned `true`.
- Legacy `task.create` (:403) stops calling `pushTaskToAgent`; an `assignTo` becomes `pinned_agent`, then `dispatch()`.

- [ ] **Step 1: Write the failing tests** — real `http.createServer()` on port 0, `setupConductorWebSocket(server)`, `ws` clients; an `api_keys` row with `key_hash = sha256('sk_test')`; a project whose `git_repo_url` is `https://github.com/o/r.git`; helper `connect(agentId, hostname)` and `next(ws, type)`:
  - `registers and replies registered`: send `worker.register` (protocol 2, repo `https://github.com/o/r.git`, engines `[{ executor: 'claude', models: ['*'], defaultModel: 'opus' }]`) → `registered` with `projectId` of that project and `hubVersion` = `appVersion`.
  - `dispatches a pending task after registration` → `task.assigned` with the full `task` and the flat `taskId/title/description`.
  - `second connection from the same host replaces the first` (first closes with 4000) and `from another host is refused` (4009).
  - `stale activeTaskId is revoked`: register with `activeTaskId` of a task now `pending` → `task.revoked { reason: 'reclaimed' }`.
  - `resumes its own active task`: `task.resumed` for a task still `in_progress` for this agent.
  - `ignores messages for tasks it does not own`: `task.complete` for another worker's task → row unchanged.
  - `legacy worker gets only executor-null tasks with flat fields`: connect with query string only, send `agent.register`; tasks with `executor: 'agy'` and `executor: null` → only the second arrives, and `msg.taskId`, `msg.title`, `msg.description` are set.
  - `scoped key refuses another project`: key `project_id = 'p-other'` → closed 4003.
  - `pushTaskToAgent pins and dispatches instead of sending twice`: a legacy row inserted as `assigned` to a connected idle v2 worker with no lease → after `pushTaskToAgent(...)` the row is `assigned` with a lease and `pinned_agent` set, and the socket received exactly one `task.assigned`.
- [ ] **Step 2: Run** `src/ws/conductor.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** it and every `src/conductor/*.test.ts` → PASS.
- [ ] **Step 5: Commit** — gates, then `git add apps/dashboard-api/src/version.ts apps/dashboard-api/src/index.ts apps/dashboard-api/src/ws/conductor.ts apps/dashboard-api/src/ws/conductor.test.ts && git commit -m "feat(conductor): worker protocol v2 with resume, revoke and safe reconnect"`

---

### Task 11: Tree creation and rerouting

**Files:**
- Create: `apps/dashboard-api/src/conductor/tree.ts`
- Modify: `apps/dashboard-api/src/conductor/lifecycle.ts` (add `rerouteTask`)
- Test: `apps/dashboard-api/src/conductor/tree.test.ts`

**Interfaces:**
- Produces:

```ts
export type TreeError = { error: string; cycle?: string[] }
export function priorityValue(p: number | string | undefined): number | null   // labels per Global Constraints; number passes through; unknown string → null
export function findCycle(nodes: string[], edges: ReadonlyMap<string, string[]>): string[] | null  // returns e.g. ['A','B','A']
export function createTree(req: TreeCreateRequest, owner: string | null): { ok: true; res: TreeCreateResponse } | { ok: false; err: TreeError }
export function rerouteTask(taskId: string, patch: RoutePatch, by: string | null): Outcome | { ok: false; status: 400; error: string; cycle?: string[] }
```

`createTree` rules (spec §6.2, §6.9):
- Validate: non-empty unique `key`s; `parentKey` names a key in the call whose `kind` is `group`; `dependsOn` entries are keys in the call or ids of existing tasks; `executor` and each `fallback[].executor` in `EXECUTORS`; `approver` only on gates; `priority` via `priorityValue`; `files` via `normalizeFiles`; keys not already used in the target tree when `parentId` is given. Any failure → `{ error }` with the offending key in the message, nothing written.
- Edges for the cycle search: each task → its `dependsOn`, plus each group → its children (so a task depending on its own group is a cycle). The error lists keys.
- Copy each group's `dependsOn` into every descendant.
- Defaults: `kind` `work`, `reviewRequired` true for `work`, `approver` `user` for gates, `project_id` = `projectId`, else the parent's project.
- Insert everything in one transaction with `task_key`, `api_key_owner = owner`, `created_by_agent = owner`; status `pending` when every dependency is already `completed` (or none), else `blocked`. Groups start `pending`. Then `dispatch()`.
- `ready` = number of `work` tasks created `pending`; `rootIds` = created tasks without a parent in the call (attached to `parentId` when given).

`rerouteTask` rules (spec §6.9): 404 unknown; 409 when `completed`, `cancelled` or `failed`; `dependsOn` is cycle-checked against the stored graph (walk `depends_on` and group parents from the new dependencies; reaching the task is a cycle) → 400 with `cycle` as task keys or ids. Active task → `revokeTask(id, 'rerouted')` and return it to pending before the patch. A `dependsOn` change on a `pending`/`blocked` task recomputes which of the two it is. `clearEscalation` sets `escalated_at`, `fail_count`, `reject_count` to null/0/0. Log `rerouted` with the patch JSON; `dispatch()`.

- [ ] **Step 1: Write the failing tests**: `creates a tree with keys, groups and gates` (3 work tasks, 1 group, 1 gate → `ids` has 5 keys, `ready` counts only work tasks without deps, descendants of a group carry its `dependsOn`); `rejects a dependency cycle and names it` (`A→B→A` → `{ error, cycle: ['A','B','A'] }`, no rows written); `a task depending on its own group is a cycle`; `rejects unknown dependsOn`, `duplicate key`, `parentKey to a non-group`, `bad executor`, `glob in files`; `maps priority labels` (`high` → 3); `sets api_key_owner from the caller`; `attaches under parentId and refuses a key already in that tree`; `reroute revokes an active task and returns it pending`; `reroute dependsOn cycle → 400`; `reroute adds an incomplete dependency → blocked`; `clearEscalation resets the counters and dispatches`.
- [ ] **Step 2: Run** `src/conductor/tree.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — gates, then `git add apps/dashboard-api/src/conductor/tree.ts apps/dashboard-api/src/conductor/tree.test.ts apps/dashboard-api/src/conductor/lifecycle.ts && git commit -m "feat(conductor): plan tree creation and rerouting with cycle checks"`

---

### Task 12: REST routes

**Files:**
- Modify: `apps/dashboard-api/src/routes/conductor.ts` (`/agents` :258, `/auto-assign` :289, `GET /` :460, `POST /` :528, `/pickup` :642, `PUT /:id` :692, `/:id/cancel` :982; new routes registered **before** `GET /:id` :498 so `/tree` is not captured as an id)
- Test: `apps/dashboard-api/src/routes/conductor-v2.test.ts` (new file; the existing `conductor.test.ts` stays for the strategy flow)

**Interfaces:**
- Consumes: Tasks 6-11; `WorkerView`, `SessionView` (Task 1).
- Produces the REST contract (plans B and C rely on these exact shapes):

| Route | Request | Response |
|---|---|---|
| `GET /agents` | — | `{ agents: WorkerView[], online: number, sessions: SessionView[] }` — sessions are `session_handoffs` rows with `status = 'active'`, newest `last_activity` first, at most 50 |
| `GET /` | adds `projectId`, `root` (tree id, recursive) to the existing `status, assigned_to, parent_task_id, limit`; `parent_task_id=none` returns only top-level tasks (`parent_task_id IS NULL`) | `{ tasks: TaskRow[] }` |
| `GET /:id/tree` | — | `{ root: TaskRow, tasks: TaskRow[] /* descendants, root excluded */, workers: WorkerView[] /* projectId equal to the root's, or null */ }`; 404 |
| `POST /tree` | `TreeCreateRequest` | 201 `TreeCreateResponse`; 400 `TreeError` |
| `POST /:id/review` | `ReviewRequest` | `{ task }`; 404/409; 403 for a user gate when `X-API-Key-Owner` is present |
| `POST /:id/route` | `RoutePatch` | `{ task }`; 400 `{ error, cycle? }`; 404/409 |
| `POST /:id/cancel` | existing, plus optional `{ reason }` | existing `{ success, id }`, through `cancelTask` (revokes an active task); `409` when already terminal (was `400`) |
| `POST /` | existing body plus `executor, model, effort, fallback, files, branch, reviewRequired, kind` | existing `{ task }`; `priority` labels mapped (unknown string → 400); `assignTo` stored as `pinned_agent`; `api_key_owner` from `X-API-Key-Owner`; no push, `dispatch()` instead |
| `PUT /:id` | existing | `approved` → `reviewTask(approve)`; `rejected` → `reviewTask(reject, feedback = message)` (no "Revision:" task); `review`/`completed`/`failed` → `completeTask(…, agentId: null)`; `in_progress` → accept if `assigned`, then `recordProgress(message)`; `message` is always logged; other statuses keep today's branch |
| `/auto-assign` | existing | stores `requiredCapabilities` when given, runs `dispatch()`, answers `{ task, assigned: boolean, agentId? }` from the row afterwards. The multi-agent delegation branch (:380-440) keeps creating `[Delegated]` subtasks but inserts them `pending` with `pinned_agent` (not `assigned_to_agent`), drops its `setAgentStatus(…, 'busy')` call and runs one `dispatch()` |
| `/pickup` | existing | `pickForPull(identity)`; `{ task }` or `{ task: null, message }` |

The review route passes `via = c.req.header('X-API-Key-Owner') ? 'mcp' : 'dashboard'`.

- [ ] **Step 1: Write the failing tests** (`app.request` against a Hono app with the router; real registry with fake sockets): `POST /tree then GET /:id/tree returns the descendants and workers`; `POST /tree cycle → 400 with cycle`; `POST / maps priority labels` (`"high"` → 3, `"urgent"` → 400); `POST / with assignTo pins and does not push` (no socket message unless that worker is connected and idle, in which case it arrives through dispatch with `task.assigned`); `POST / sets api_key_owner from the header`; `PUT rejected returns the same task to pending with no new row`; `PUT message is logged`; `GET / filters by assigned_to and projectId`; `GET /?root=` returns the subtree; `GET /?parent_task_id=none` returns only top-level tasks; `POST /:id/cancel revokes an active task` (socket receives `task.revoked`); `POST /:id/review user gate with X-API-Key-Owner → 403, without → 200`; `POST /:id/route reroutes`; `GET /agents returns workers with engines and quota, and active sessions`; `/pickup returns a pinned task as accepted`.
- [ ] **Step 2: Run** `src/routes/conductor-v2.test.ts` → FAIL.
- [ ] **Step 3: Implement**; remove now-unused helpers from the route file.
- [ ] **Step 4: Run** it, `src/routes/conductor.test.ts` and `src/routes/conductor-comments.test.ts` → PASS.
- [ ] **Step 5: Commit** — gates, then `git add apps/dashboard-api/src/routes/conductor.ts apps/dashboard-api/src/routes/conductor-v2.test.ts && git commit -m "feat(conductor): tree, review and route endpoints; legacy routes go through the lifecycle"`

---

### Task 13: Legacy `/api/tasks` router through the lifecycle

The dashboard's task board (`apps/dashboard-web/src/lib/api.ts:930-961`) still calls `/api/tasks`, which writes statuses and assignees directly. After this task it changes nothing the lifecycle does not.

**Files:**
- Modify: `apps/dashboard-api/src/routes/tasks.ts` (`POST /` :52, `PATCH /:id` :222, `POST /:id/assign` :297, `DELETE /:id` :377, `PATCH /:id/cancel` :392)
- Test: `apps/dashboard-api/src/routes/tasks-lifecycle.test.ts`

**Interfaces:**
- Consumes: `cancelTask`, `completeTask`, `reviewTask`, `acceptTask`, `revokeTask` (Tasks 7-8), `rerouteTask` (Task 11), `priorityValue` (Task 11), `dispatch` (Task 6).
- Produces: the same request and response shapes as today, with these behaviour changes:

| Route | Change |
|---|---|
| `POST /` | `assignTo` → `pinned_agent`, status `pending` (not `assigned`), then `dispatch()`; `priority` through `priorityValue` (unknown string → 400); `api_key_owner` from `X-API-Key-Owner` |
| `PATCH /:id` | non-status fields (`title`, `description`, `priority`, `context`, `requiredCapabilities`, `notifyOnComplete`) update as today; `dependsOn` goes through `rerouteTask({ dependsOn })` (cycle → 400); `assignedToAgent` → `rerouteTask({ pinnedAgent })`; `status` maps like `PUT /api/conductor/:id` (Task 12): `completed`/`failed`/`review` → `completeTask(…, null)`, `approved`/`rejected` → `reviewTask(…, 'dashboard')`, `cancelled` → `cancelTask`, `accepted`/`in_progress` → `acceptTask` by the current assignee; `assigned` or `pending` → 400 `use /assign or the dispatcher` |
| `POST /:id/assign` | `rerouteTask({ pinnedAgent: agentId })`, then the task is whatever `dispatch()` made it |
| `PATCH /:id/cancel` | `cancelTask` |
| `DELETE /:id` | `revokeTask(id, 'deleted')` first when the task is active, then delete as today |

- [ ] **Step 1: Write the failing tests**: `POST with assignTo pins and dispatches` (connected idle worker receives one `task.assigned`; the row has `pinned_agent` and a lease); `PATCH status completed on a review_required task moves it to review`; `PATCH status assigned → 400`; `PATCH dependsOn cycle → 400`; `POST /:id/assign on an active task revokes it and pins the new agent`; `PATCH /:id/cancel revokes an active task`; `DELETE an active task revokes it first`.
- [ ] **Step 2: Run** `pnpm --filter @cortex/dashboard-api exec vitest run src/routes/tasks-lifecycle.test.ts` → FAIL.
- [ ] **Step 3: Implement**; `routes/tasks.ts` no longer imports `pushTaskToAgent`.
- [ ] **Step 4: Run** it and every `src/routes/*conductor*.test.ts` → PASS.
- [ ] **Step 5: Commit** — gates, then `git add apps/dashboard-api/src/routes/tasks.ts apps/dashboard-api/src/routes/tasks-lifecycle.test.ts && git commit -m "fix(api): legacy task board routes go through the conductor lifecycle"`

---

### Task 14: Notifications on the hints channel

**Files:**
- Modify: `apps/dashboard-api/src/routes/stats.ts:818` (hints endpoint)
- Create: `apps/hub-mcp/src/hint-blocks.ts`
- Modify: `apps/hub-mcp/src/index.ts:396-421` (use it)
- Delete: `apps/hub-mcp/src/notifications.ts` (confirm with `rg -n "notifications" apps/hub-mcp/src` that nothing imports it)
- Test: `apps/dashboard-api/src/routes/stats-hints-conductor.test.ts`, `apps/hub-mcp/src/hint-blocks.test.ts`

**Interfaces:**
- Consumes: `takeNotifications` (Task 5).
- Produces: hints endpoint response `{ hints: string[], conductor: string[] }`; `appendHintBlocks(text: string, hints: string[], conductor: string[]): string`.

`appendHintBlocks` copy: hints → `\n\n---\n💡 Cortex hints:\n` + each line prefixed with two spaces, joined by `\n`; then conductor → `\n\n---\n📋 Conductor:\n` + the same line format. Empty arrays add nothing. hub-mcp rewrites the body when either array is non-empty, and reads `conductor` as `[]` when an older API omits it.

- [ ] **Step 1: Write the failing tests**: `hints endpoint returns and marks conductor notifications` (two rows for `lead-key` → `GET /hints/lead-key` returns both in `conductor`; a second call returns `[]`; `hints` unchanged); `appendHintBlocks('x', [], ['TT3 ready'])` → `'x\n\n---\n📋 Conductor:\n  TT3 ready'`; both blocks in order 💡 then 📋; `appendHintBlocks('x', [], [])` → `'x'`.
- [ ] **Step 2: Run** both files → FAIL.
- [ ] **Step 3: Implement**; delete `notifications.ts`.
- [ ] **Step 4: Run** both → PASS; `pnpm --filter @cortex/hub-mcp exec vitest run` → PASS.
- [ ] **Step 5: Commit** — gates, then `git add apps/dashboard-api/src/routes/stats.ts apps/dashboard-api/src/routes/stats-hints-conductor.test.ts apps/hub-mcp/src/hint-blocks.ts apps/hub-mcp/src/hint-blocks.test.ts apps/hub-mcp/src/index.ts && git rm apps/hub-mcp/src/notifications.ts && git commit -m "feat(conductor): lead notifications on the hints channel"`

---

### Task 15: Lead MCP tools

**Files:**
- Create: `apps/hub-mcp/src/tools/conductor-lead.ts`; modify `apps/hub-mcp/src/index.ts:190` (register next to `registerTaskTools`)
- Test: `apps/hub-mcp/src/tools/conductor-lead.test.ts` (pattern of `tools/session.test.ts`: mocked `globalThis.fetch`, fake `server.tool` collector, `{ DASHBOARD_API_URL: 'http://api' } as Env`)

**Interfaces:**
- Consumes: REST contract (Task 12); shared `TreeTaskInput`, `RoutePatch`, `WorkerView`, `SessionView`, `EXECUTORS`.
- Produces: `registerConductorLeadTools(server: McpServer, env: Env): void` with five tools, each calling `apiCall(env, …)` (so `X-API-Key-Owner` is forwarded):

| Tool | Request | Text answer (first line exact) |
|---|---|---|
| `cortex_task_tree_create` | `POST /api/conductor/tree` with `{ parentId?, projectId?, tasks }` (zod mirrors `TreeTaskInput`; `executor` is `z.enum(EXECUTORS)`) | `**Plan created** — {n} tasks, {ready} ready now`, then `- {key} → {id}` per task. On 400: `Plan rejected: {error}` plus `Cycle: A → B → A` when present, `isError: true` |
| `cortex_agents` | `GET /api/conductor/agents` | `**Workers ({online} online)**`; per worker `- {agentId} @ {hostname} ({os}) · {idle|busy}[ · on {currentTaskId}] · engines: {executor}[{models joined by ','}] …[ · quota: {executor}/{model} until {exhaustedUntil} …]`; then `**MCP sessions**` with `- {agentId} · {ide} · {branch} · {lastActivity}` |
| `cortex_task_review` | `POST /api/conductor/{taskId}/review` with `{ verdict, feedback }` | `**Review recorded** — {task_key ?? id} is now {status}`; on 403/409 the API's error with `isError: true` |
| `cortex_task_route` | `POST /api/conductor/{taskId}/route` with the `RoutePatch` fields | `**Route updated** — {task_key ?? id}: {executor ?? 'any'}/{model ?? 'default'}`; on 400 with a cycle, the same `Cycle:` line |
| `cortex_task_cancel` | `POST /api/conductor/{taskId}/cancel` with `{ reason }` | `**Cancelled** — {taskId}`; on 404/409 the API's error with `isError: true` |

Tool descriptions state when to use each (the lead reads them): tree create for whole plans, with `files` for lock safety and `reviewRequired` default true; agents before choosing routes; review for `review` tasks and lead gates (user gates are dashboard-only); route for escalations (`clearEscalation`) and fallbacks; cancel for a task the lead gives up on (its dependents stay `blocked` until rerouted).

- [ ] **Step 1: Write the failing tests**: one per tool asserting the fetch URL, method and JSON body, and the first line of the answer; `tree_create shows the cycle on 400`; `review surfaces the 403 for user gates`; `agents lists quota and sessions`; `cancel posts the reason`.
- [ ] **Step 2: Run** `pnpm --filter @cortex/hub-mcp exec vitest run src/tools/conductor-lead.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — gates, then `git add apps/hub-mcp/src/tools/conductor-lead.ts apps/hub-mcp/src/tools/conductor-lead.test.ts apps/hub-mcp/src/index.ts && git commit -m "feat(hub-mcp): lead tools for plan trees, agents, review, routing and cancel"`

---

### Task 16: Fix the existing task tools

**Files:**
- Modify: `apps/hub-mcp/src/tools/tasks.ts` (`cortex_task_create` :12-77, `cortex_task_list` :213-270)
- Test: `apps/hub-mcp/src/tools/tasks.test.ts` (new)

**Interfaces:**
- `cortex_task_create`: `priority` becomes `z.union([z.enum(['critical','high','medium','low']), z.number().int().min(1).max(10)])` and is sent as the integer (`PRIORITY_LABELS`); new optional inputs `executor` (`z.enum(EXECUTORS)`), `model`, `effort`, `fallback`, `files`, `branch`, `reviewRequired`; `assignTo` description says it pins the task to that agent. Body sent to `POST /api/conductor` keeps the old field names and adds the new ones.
- `cortex_task_list`: sends `assigned_to` and `projectId` query params (it sends `assignedTo` today); each line adds `key`, `kind` when not `work`, `wait: {wait_reason}` and `escalated` when set.
- `cortex_task_update`: unchanged inputs (server now routes them through the lifecycle); its description mentions that `message` is stored in the task log.

- [ ] **Step 1: Write the failing tests**: `create maps "high" to 3 and sends routing fields`; `create passes a numeric priority through`; `list sends assigned_to and projectId`; `list shows key, wait reason and escalation`.
- [ ] **Step 2: Run** `pnpm --filter @cortex/hub-mcp exec vitest run src/tools/tasks.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — gates, then `git add apps/hub-mcp/src/tools/tasks.ts apps/hub-mcp/src/tools/tasks.test.ts && git commit -m "fix(hub-mcp): task tools send integer priorities, routing fields and working filters"`

---

### Task 17: In-process integration test

**Files:**
- Test: `apps/dashboard-api/src/conductor/integration.test.ts`

Exercises Tasks 1-13 together with a real HTTP server, the WS endpoint and two scripted workers (`ws` clients that answer like the A2 worker: accept, one progress, then complete or report quota). No production code; if it finds a defect, fix it in the owning module with a unit test there.

- [ ] **Step 1: Write the test** `three-task plan runs in order, survives quota and review`:
  1. Workers `w-mac` (`h-mac`, engines `agy[gemini-4-argon-low]`, `claude[*]`) and `w-linux` (`h-linux`, `claude[*]`) register.
  2. `POST /api/conductor/tree` (with `X-API-Key-Owner: lead-key`): `A` (agy/gemini-4-argon-low, fallback `[claude/opus]`, files `['src/a.ts']`), `B` dependsOn `A`, `G` gate (approver `lead`) dependsOn `B`.
  3. `w-mac` receives `A` on agy; it sends `task.quota_exhausted` (`modelScope: 'gemini-4-argon-*'`, `resetAt` +5 h). `A` is re-dispatched on `claude/opus` (to whichever worker is idle; `last_agent` preference makes it `w-mac`) with `task.handoff` carried in the message.
  4. Complete `A` → `review`; `GET /api/metrics/hints/lead-key` returns the `review_ready` line.
  5. `POST /:A/review` reject with feedback → `A` re-dispatched with `reviews[0].feedback`; complete again; approve → `B` dispatched.
  6. Complete and approve `B` → `G` `pending` with a `gate_ready` notification; `POST /:G/review` approve with `X-API-Key-Owner` → `completed`.
  7. Assert: no task id was ever received by two workers at once; `A.attempt = 3`; the quota row for `h-mac` exists; `B` never ran before `A` was approved.
- [ ] **Step 2: Run** `pnpm --filter @cortex/dashboard-api exec vitest run src/conductor/integration.test.ts` → PASS (fix the owning module if not).
- [ ] **Step 3: Run the whole suites** `pnpm --filter @cortex/dashboard-api exec vitest run && pnpm --filter @cortex/hub-mcp exec vitest run` → PASS.
- [ ] **Step 4: Commit** — gates, then `git add apps/dashboard-api/src/conductor/integration.test.ts && git commit -m "test(conductor): end-to-end plan through quota fallback and review"`

---

## Spec coverage

| Spec | Task |
|---|---|
| §6.1 columns, tables, config | 1 |
| §6.2 lifecycle, groups, gates, escalation | 7, 8, 11 |
| §6.3 registry, project match, scoped keys, legacy connect | 2, 3, 10 |
| §6.4 dispatcher, waits, pull mode, removed pushes | 4, 6, 10, 12, 13 |
| §6.5 protocol | 1, 10 |
| §6.6 review and escalation | 7, 8 |
| §6.7 quota and fallback | 4, 7 |
| §6.8 leases and reclaim | 9 |
| §6.9 lead tools | 11, 15, 16 |
| §6.10 notifications | 5, 14 |
| §6.11 REST | 12, 13 |
| §9 migration (defaults, legacy workers, lease backfill) | 1, 9, 10 |
| §10 tests | every task; 17 |

Out of this plan: the worker and `GET /conductor/worker.mjs` (A2), the dashboard (B), setup docs and URL fixes (C).
