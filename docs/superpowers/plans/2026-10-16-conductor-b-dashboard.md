# Conductor B — Dashboard plan view: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/conductor` draws a plan from its real dependency graph. It shows depth columns, one lane per machine, gates, same-file edges, the critical path and a progress bar. A side panel lists what needs a human, the workers and the fallback tally. From the plan you can approve, reject, clear an escalation or reroute a task. All of it comes from `GET /api/conductor/:id/tree`, polled.

**Architecture:** All graph logic lives in a pure, React-free module, `apps/dashboard-web/src/lib/conductor-plan/`. It covers normalising rows, depths, lanes, phase selection, the critical path, file overlap, summaries, React Flow node and edge building, and action rules, and it is unit-tested with vitest. Thin React components under `src/app/conductor/plan/` render that output with `@xyflow/react` (already a dependency). `PlanView` replaces the `PipelineDiagram` modal on `/conductor`; `PipelineDiagram` is deleted. API types and clients go into `src/lib/api.ts`, following the dashboard-web convention: types are hand-written there and not imported from `@cortex/shared-types`.

**Tech Stack:** Next.js 15 (static export, `output: "export"`), React 19, SWR 2, `@xyflow/react` 12, CSS modules, vitest 3 (new to this package), TypeScript strict.

**Spec:** `docs/superpowers/specs/2026-10-16-conductor-production-ready-design.md` §7, using §6.1 (columns), §6.2 (states), §6.6 (review), §6.11 (REST), §11 (the "dashboard marks tasks without `files`" mitigation) and D8.

---

## Global Constraints

- **Ownership:** touch only `apps/dashboard-web/**`. The single exception is `pnpm-lock.yaml`, which Task 1 changes by adding vitest; on a conflict with plan A2's lockfile change, re-run `pnpm install`. Plan A1 owns every REST route used here. Do not edit `apps/dashboard-api`, `packages/shared-types` or `apps/hub-mcp`.
- **Depends on A1.** Unit tests need no hub. The manual checks in Tasks 9–11 need A1's `GET /:id/tree`, `POST /tree`, `POST /:id/review`, `POST /:id/route` and the extended `GET /agents` running locally.
- **Uncommitted user fix:** the working tree holds an unrelated, uncommitted fix in `src/app/page.tsx`, `src/app/settings/page.tsx`, `src/components/layout/DashboardLayout.module.css` and `src/lib/config.ts`. Branch from `master` after that fix is merged, or rebase onto it once it is. Never stage those files from this plan. Task 10 edits `src/app/page.tsx` within a few lines of that fix's hunks (L173–181), so rebase before Task 10.
- **Pure module rule:** files in `src/lib/conductor-plan/` import nothing from React, Next or `@/`. They import types only from `../api` (`import type`) and `@xyflow/react`. Anything that depends on time takes `now: Date` as an argument. vitest then runs with no config file and no path alias.
- **Contract types are exact:** the shapes in Task 1 mirror `plan-contract.md` (WorkerView, SessionView, tree response, review/route bodies). New `ConductorTask` columns are declared optional and nullable (`task_key?: string | null`) so that an older hub and the existing object literals in `page.tsx` keep compiling; `model.ts` normalises `undefined` to `null`.
- **D8:** the dashboard never sends `X-API-Key-Owner`. `apiFetch` sends only `Content-Type` plus the headers each call passes, so the new clients pass none. A test in Task 1 guards this.
- **UI text is English**, like the rest of the dashboard. The approved mock's Vietnamese labels are translated: "Inputs", "Unlocks next", "Step N", "Needs you", "Awaiting lead", "Workers", "Fallback tally".
- **Static export:** only client components, no dynamic route segments and no server actions. The plan view is an overlay on `/conductor`, keyed by root id held in component state.
- **Visual values** come from the approved mock (`proposed.tsx`/`proposed.css`, screenshots `shot-3`, `shot-4`), copied here because the mock lives outside the repo:
  - Sizes. Compact: `W 168, H 34, COL_W 190, ROW_H 40, LABEL_W 120`. Detail (phase view): `W 222, H 112, COL_W 248, ROW_H 128, LABEL_W 130`. `HEAD_H 34`. Lane height is the largest number of cells in any one column × `ROW_H` + 24.
  - Status colours: done `#34d399`, review `#a78bfa`, needs_user and gate_lead `#fbbf24`, escalated `#f87171`, running `#60a5fa`, waiting `#22d3ee`, ready `#e5e7eb`, blocked `#6b7280`, stopped `#4b5563`.
  - Edges. Critical: `#f87171`, width 2.4. From a done task: `rgba(52,211,153,.55)`. Default: `rgba(148,163,184,.55)`. Gate edges: `#fbbf24`, or green once the gate is done. Same-file edges: `#fb923c`, dash `6 4`.
  - Port the `.tn*`, `.gate*`, `.lane*`, `.colhead`, `.side`, `.need.{red,amber,violet}`, `.worker`, `.route-row`, `.bar*` and `.legend*` rules into `plan.module.css`, using the existing CSS variables (`--bg-*`, `--text-*`, `--border*`, `--font-mono`).
- **Conventions:** camelCase/PascalCase, no `any` without a comment, 2-space indentation, no semicolons. The file header comment and `'use client'` follow the existing conductor components.
- **Run a single test file:** `pnpm --filter @cortex/dashboard-web exec vitest run <path>`.
- **Commit steps:** the repo hooks refuse `git commit` until `pnpm build && pnpm typecheck && pnpm lint` pass after the last write. Run those three gates (full build, never `--filter`), then `git add` only the listed files and commit with a conventional message (`feat(dashboard): …`, `test(dashboard): …`, `refactor(dashboard): …`).

## Review Focus

1. **Bad graph data must not hang or crash the view.** A dependency cycle, an id outside the tree, or a dependency on a group: layout and critical path terminate and mark the cycle. Tests: Task 3 `computeDepths terminates on a cycle and reports its members`; Task 2 `resolveDeps drops ids outside the tree and counts them as external`.
2. **Legacy rows render.** A row with `kind` null, no `task_key`, `depends_on '[]'` and none of the new columns (older hub) becomes a work node in column 0, in the queue lane. Test: Task 2 `toPlanTasks treats a legacy row as work with a key from the id`.
3. **File-overlap rule exactly as §6.1.** Paths conflict when they are equal, or when one ends in `/` and the other starts with it. `src/a` must not match `src/ab.ts`, and a task with no `files` never conflicts. Test: Task 4 `pathsOverlap follows the trailing-slash prefix rule`.
4. **State mapping drives every count.** An escalated task is `pending` but not *ready*. Gates and groups are excluded from progress. A user gate is "Needs you"; a lead gate is "Awaiting lead". Test: Task 5 `progressCounts counts work tasks only and files escalated under blocked`.
5. **D8 and action errors.** No `X-API-Key-Owner` header from the dashboard. A 409, 403 or 400-with-cycle reaches the user as a readable message, never as a silent failure. Tests: Task 1 `reviewConductorTask posts the verdict and sends no X-API-Key-Owner header`; Task 8 `actionErrorMessage maps 409, 403 and a 400 cycle`.

## File map

Create:
- `apps/dashboard-web/src/lib/api.conductor.test.ts`
- `apps/dashboard-web/src/lib/conductor-plan/model.ts` + `model.test.ts`: rows → `PlanTask`, state, route label, note, dependency resolution.
- `apps/dashboard-web/src/lib/conductor-plan/layout.ts` + `layout.test.ts`: depths, lanes, phase selection, geometry.
- `apps/dashboard-web/src/lib/conductor-plan/analysis.ts` + `analysis.test.ts`: critical path, file overlap.
- `apps/dashboard-web/src/lib/conductor-plan/summary.ts` + `summary.test.ts`: progress, Needs you, Awaiting lead, tally, worker rows, tabs, agents online.
- `apps/dashboard-web/src/lib/conductor-plan/flow.ts` + `flow.test.ts`: React Flow nodes and edges, colours, sizes.
- `apps/dashboard-web/src/lib/conductor-plan/actions.ts` + `actions.test.ts`: which actions apply, route body, error text.
- `apps/dashboard-web/src/lib/conductor-plan/test-fixtures.ts`: `row()`, `worker()`, `session()`, `generatePlan(n)` builders (test-only, never imported by app code).
- `apps/dashboard-web/src/lib/conductor-plan/__fixtures__/seed-plan.json`: body for `POST /api/conductor/tree`, used by the manual checks.
- `apps/dashboard-web/src/app/conductor/plan/PlanView.tsx`, `PlanDiagram.tsx`, `PlanNodes.tsx`, `PlanProgress.tsx`, `PlanSidePanel.tsx`, `PlanTaskActions.tsx`, `plan.module.css`

Modify:
- `apps/dashboard-web/package.json`: vitest devDep and `test` script.
- `apps/dashboard-web/src/lib/api.ts`: types and clients.
- `apps/dashboard-web/src/app/conductor/page.tsx`: plan view, agents and sessions.
- `apps/dashboard-web/src/app/conductor/page.module.css`: drop `.diagramModal*`, add session rows.
- `apps/dashboard-web/src/app/conductor/components/TaskDetail.tsx`: `actions` slot.
- `apps/dashboard-web/src/app/conductor/components/index.ts`: drop the `PipelineDiagram` export.
- `apps/dashboard-web/src/app/page.tsx`: Agents Online count includes sessions.

Delete:
- `apps/dashboard-web/src/app/conductor/components/PipelineDiagram.tsx`, `PipelineDiagram.module.css`

---

### Task 1: vitest and the conductor API surface

**Files:**
- Modify: `apps/dashboard-web/package.json`, `apps/dashboard-web/src/lib/api.ts` (the `// ── Conductor Types ──` block near L966 and `ConductorTask` near L887)
- Create: `apps/dashboard-web/src/lib/api.conductor.test.ts`

**Interfaces:**
- Consumes: A1 REST from the contract (`GET /:id/tree`, `POST /:id/review`, `POST /:id/route`, `GET /agents`).
- Produces (all exported from `@/lib/api`):
  - `type Executor = 'claude' | 'codex' | 'agy' | 'gemini'`, `const EXECUTORS: readonly Executor[]`
  - `interface RouteSpec { executor: Executor | null; model: string | null; effort: string | null }`
  - `interface EngineInfo { executor: Executor; models: string[]; defaultModel: string | null }`
  - `interface TaskReview { at: string; by: string; verdict: 'approve' | 'reject'; feedback: string }`
  - `ConductorTask` gains, each typed `?: T | null`:
    - `task_key`, `kind`, `approver`, `executor`, `model`, `effort`, `fallback`, `files`, `branch`
    - `pinned_agent`, `review_required`, `attempt`, `fail_count`, `reject_count`, `current_route`
    - `lease_expires_at`, `wait_reason`, `wait_until`, `escalated_at`, `last_agent`, `api_key_owner`
    - JSON columns stay `string`.
  - `interface ConductorWorker`: exactly the contract's WorkerView. It is structurally assignable to the existing `ConductorAgent`, so `AgentDetail`, `TaskBriefingWizard` and `StrategyReview` keep compiling unchanged.
  - `interface ConductorSession`: exactly the contract's SessionView.
  - `interface ConductorTree { root: ConductorTask; tasks: ConductorTask[]; workers: ConductorWorker[] }`
  - `interface ReviewBody { verdict: 'approve' | 'reject'; feedback?: string; by?: string }`
  - `interface RouteBody`: `executor?`, `model?`, `effort?` (each `T | null`), `fallback?: RouteSpec[] | null`, `pinnedAgent?: string | null`, `priority?: number`, `files?: string[]`, `dependsOn?: string[]`, `clearEscalation?: boolean`
  - `getConductorAgents(): Promise<{ agents: ConductorWorker[]; online: number; sessions: ConductorSession[] }>`
  - `getConductorTree(id: string): Promise<ConductorTree>`
  - `reviewConductorTask(id: string, body: ReviewBody): Promise<{ task: ConductorTask }>`
  - `routeConductorTask(id: string, body: RouteBody): Promise<{ task: ConductorTask }>`

- [ ] **Step 1: Add vitest.** Add `"vitest": "^3.0.0"` to devDependencies and `"test": "vitest run"` to scripts, mirroring `apps/dashboard-api` but without `--passWithNoTests`, because this package will have tests. Run `pnpm install`. Add no `vitest.config.ts`: the pure-module rule makes the defaults enough, and turbo's `test` inputs already cover `src/**`.
- [ ] **Step 2: Write the failing tests** in `api.conductor.test.ts`. Use `vi.stubGlobal('fetch', vi.fn())`, returning `new Response(JSON.stringify(…), { status })`.
  - `getConductorTree requests GET /api/conductor/:id/tree`: the URL ends with `/api/conductor/abc/tree` and the method is GET; the resolved value deep-equals the stubbed `{root, tasks, workers}`.
  - `reviewConductorTask posts the verdict and sends no X-API-Key-Owner header`: method POST; URL `/api/conductor/g1/review`; `JSON.parse(body)` equals `{verdict: 'reject', feedback: 'tighten copy', by: 'dashboard'}`; no header key matches `/x-api-key-owner/i`.
  - `routeConductorTask posts only the given fields`: the body equals `{ clearEscalation: true }`.
  - `a 409 from review rejects with ApiError status 409 and the hub's error text`: `rejects.toMatchObject({ name: 'ApiError', status: 409, message: 'not in review' })`.
  - `a 400 from route exposes the cycle in ApiError.data`: `err.data.cycle` equals `['A', 'B', 'A']`.
  - `getConductorAgents passes sessions through`.
- [ ] **Step 3: Run it and confirm it fails.** `pnpm --filter @cortex/dashboard-web exec vitest run src/lib/api.conductor.test.ts` should fail because `getConductorTree` is not exported.
- [ ] **Step 4: Implement.** Add the types and the three clients above, using `apiFetch`, `encodeURIComponent(id)` and `method: 'POST'`. The clients pass no extra headers. Change only the return type of `getConductorAgents`.
- [ ] **Step 5: Run it and confirm it passes.** Then run `pnpm --filter @cortex/dashboard-web typecheck` to confirm existing `ConductorAgent` consumers still compile.
- [ ] **Step 6: Commit.** Run the gates, then `git add apps/dashboard-web/package.json pnpm-lock.yaml apps/dashboard-web/src/lib/api.ts apps/dashboard-web/src/lib/api.conductor.test.ts` and commit `feat(dashboard): conductor tree, review and route API clients`.

### Task 2: Plan model (rows → PlanTask)

**Files:**
- Create: `src/lib/conductor-plan/model.ts`, `model.test.ts`, `test-fixtures.ts` (all under `apps/dashboard-web/`)

**Interfaces:**
- Consumes: `ConductorTask`, `RouteSpec`, `TaskReview`, `Executor` (types) from Task 1.
- Produces:
  - `type PlanState = 'done' | 'review' | 'needs_user' | 'gate_lead' | 'escalated' | 'running' | 'waiting' | 'ready' | 'blocked' | 'stopped'`
  - `interface PlanTask`, with fields:
    - Identity: `id`, `key`, `title`
    - Kind: `kind: 'work' | 'gate' | 'group'`, `approver: 'user' | 'lead' | null`
    - State: `status`, `state: PlanState`
    - Tree: `parentId`, `groupId: string | null`
    - Dependencies: `deps: string[]`, `externalDeps: number`
    - Work: `files: string[]`, `estimate: number`, `priority: number`
    - Routing: `primary: RouteSpec | null`, `route: RouteSpec | null`
    - Waiting: `waitReason: 'capacity' | 'no_worker' | 'lock' | null`, `waitUntil: string | null`
    - Escalation: `escalated: boolean`, `rejectCount`, `failCount`
    - Assignment and history: `agent: string | null`, `reviews: TaskReview[]`, `row: ConductorTask`
  - `toPlanTasks(root: ConductorTask, rows: ConductorTask[]): PlanTask[]`. This excludes the root and returns deps already resolved.
  - `deriveState(row: ConductorTask): PlanState`
  - `resolveDeps(tasks: PlanTask[]): void` (in place; exported for tests)
  - `parseJson<T>(value: string | null | undefined, fallback: T): T`
  - `shortModel(model: string): string`
  - `routeLabel(route: RouteSpec | null): string | null`
  - `nodeNote(task: PlanTask, now: Date): string | null`
  - `formatUntil(iso: string, now: Date): string`
  - `test-fixtures.ts`: `row(p: Partial<ConductorTask> & { id: string }): ConductorTask`, `worker(p): ConductorWorker`, `session(p): ConductorSession`, `generatePlan(n: number): ConductorTask[]`. `generatePlan` is deterministic, with 3 groups, ~10% gates, chained and cross-group deps, and shared files.

- [ ] **Step 1: Write the failing tests.** Build fixtures with `row()`.
  - `toPlanTasks treats a legacy row as work with a key from the id`. Input: a row with no `kind`, `task_key` or new columns, and `depends_on: '[]'`. Expect `kind 'work'`, `key === id.slice(0, 8)`, `deps []`, `files []`, `estimate 1`, `route null`, `escalated false`.
  - `deriveState maps every status` is table-driven:

    | Row | Expected state |
    |---|---|
    | `completed`, `approved` | `done` (even with `escalated_at` set) |
    | `review` | `review` |
    | `pending` + `escalated_at` | `escalated` |
    | gate `pending` + approver `user` | `needs_user` |
    | gate `pending` + approver `lead` | `gate_lead` |
    | gate `blocked` | `blocked` |
    | `pending` + `wait_reason` `capacity`, `no_worker` or `lock` | `waiting` |
    | `pending` with no reason | `ready` |
    | `assigned`, `accepted`, `in_progress`, `analyzing`, `synthesis`, `discussion`, `strategy_review` | `running` |
    | `blocked` | `blocked` |
    | `cancelled`, `failed`, `rejected` | `stopped` |
  - `malformed JSON columns parse to empty values`. With `files: 'nope'`, `context: '{'` and `current_route: 'x'`, expect `files []`, `estimate 1`, and `route` falling back to `{executor, model, effort}` from the columns, or `null` if those are empty too.
  - `estimate reads context.estimate and defaults to 1`. `{"estimate": 2.5}` gives 2.5; values of 0, a negative number or a string give 1.
  - `resolveDeps drops ids outside the tree and counts them as external`. `deps ['T1', 'zzz']` becomes `deps ['T1']` with `externalDeps 1`.
  - `resolveDeps expands a dependency on a group to the group's sink tasks`. Group G contains A→B; C depends on G; then `C.deps` is `['B']`. Nested groups expand recursively, and a group with no members contributes nothing.
  - `groupId is the nearest group ancestor`. Use root → group P → group P.1 → task, so `groupId === 'P.1'`. A legacy work parent is not a group.
  - `shortModel strips the vendor prefix`:

    | Input | Output |
    |---|---|
    | `gemini-4-argon-low` | `argon-low` |
    | `gemini-3.8-flash-high` | `flash-high` |
    | `claude-opus-5-5` | `opus-5-5` |
    | `opus` | `opus` |
    | `gpt-5-codex` | `gpt-5-codex` |
  - `routeLabel joins executor and short model with a middle dot`. `{agy, gemini-4-argon-low}` gives `'agy·argon-low'`; executor only gives `'claude'`; `null` gives `null`.
  - `nodeNote explains why a task is not running`, with `now` fixed:

    | Task | Note |
    |---|---|
    | `capacity`, `wait_until` now + 2 h 5 min | `'quota · resets in 2h 5m'` |
    | `no_worker` | `'no worker for agy·argon-low'` |
    | `lock` | `'waiting on a file lock'` |
    | escalated, `reject_count 2` | `'escalated · 2 rejections'` |
    | escalated, `fail_count 2` | `'escalated · 2 failures'` |
    | `current_route` model ≠ primary | `'fallback from agy·argon-low'` |
    | none of the above | `null` |

    Precedence: escalated, then wait reason, then fallback.
  - `formatUntil renders hours and minutes`: `'in 2h 5m'`, `'in 40m'`, and `'now'` once past.
- [ ] **Step 2: Run it and confirm it fails.** `…vitest run src/lib/conductor-plan/model.test.ts` fails because the module is missing.
- [ ] **Step 3: Implement.**
  - `primary` comes from the `executor`, `model` and `effort` columns, and is `null` when all three are null. `route = parse(current_route) ?? primary`.
  - `agent = assigned_to_agent ?? last_agent`. `priority` comes from the row.
  - `groupId` walks `parent_task_id` through a `Map`. Guard against parent cycles with a visited set.
  - Group expansion: a group's *sinks* are its descendant work and gate tasks that no other descendant depends on.
  - `nodeNote` uses `formatUntil` for the quota reset time.
- [ ] **Step 4: Run it and confirm it passes.**
- [ ] **Step 5: Commit.** Run the gates, then commit `feat(dashboard): normalise conductor rows into plan tasks`.

### Task 3: Layout — depth columns, machine lanes, phase view

**Files:**
- Create: `src/lib/conductor-plan/layout.ts`, `layout.test.ts`

**Interfaces:**
- Consumes: `PlanTask` (Task 2) and `ConductorWorker` (type).
- Produces:
  - `SIZES`: `{ compact: Size; detail: Size; HEAD_H: 34 }`, where `Size = { W; H; COL_W; ROW_H; LABEL_W }`. Values are in Global Constraints.
  - `computeDepths(tasks: PlanTask[]): { depth: Map<string, number>; cyclic: Set<string> }`
  - `interface Lane { id: string; label: string; sub: string; online: boolean; agentIds: string[] }`
  - `assignLanes(tasks: PlanTask[], workers: ConductorWorker[]): { lanes: Lane[]; laneOf: Map<string, string> }`
  - `interface PhaseSelection { groupId: string; members: Set<string>; inputs: Set<string>; outputs: Set<string> }`
  - `selectPhase(tasks: PlanTask[], groupId: string): PhaseSelection`
  - `interface Cell { id: string; col: number; laneId: string; x: number; y: number; w: number; h: number; ghost: 'input' | 'output' | null }`
  - `interface PlanLayout`: `cells: Cell[]`, `columns: { col: number; x: number; label: string }[]`, `lanes: (Lane & { y: number; height: number })[]`, `width: number`, `height: number`, `cyclic: Set<string>`
  - `layoutPlan(tasks: PlanTask[], workers: ConductorWorker[], opts: { mode: 'compact' | 'detail'; phase?: PhaseSelection }): PlanLayout`

- [ ] **Step 1: Write the failing tests.**
  - `computeDepths gives a chain 0,1,2 and a diamond's join the longest path`.
  - `computeDepths terminates on a cycle and reports its members`. A↔B, and C depends on A. Every depth is a finite integer, `cyclic` equals `{A, B}`, and C is deeper than A.
  - `a legacy tree with no deps lays out in one column`. Five legacy rows give every `cell.col === 0` and a single `queue` lane.
  - `assignLanes groups workers by hostname`. Agents `w1` and `w2` are both on host `mac-1`, giving one lane `mac-1` with `agentIds ['w1', 'w2']` and `online true`.
  - `assignLanes uses last_agent when nothing is assigned`.
  - `a task held by an agent that is not online gets its own lane marked offline`. The lane id is the agent id and `online` is false.
  - `unassigned tasks go to the queue lane, which is last`. Lane order is online lanes by hostname, then offline lanes, then `queue`. Only lanes that are in use appear.
  - `a gate sits in the lane of its first dependent, else in the queue`.
  - `groups and the root never become cells`.
  - `selectPhase returns members, input ghosts and output ghosts`. Inputs are the members' deps outside the group; outputs are tasks outside the group that depend on a member. A task cannot be both a member and a ghost.
  - `layoutPlan in phase mode puts inputs in column 0 and outputs in the last column`. Members start at column 1 when inputs exist. Column labels are `'Inputs'`, `'Step 1'…`, and `'Unlocks next'`.
  - `layoutPlan never overlaps two cells`. Over `generatePlan(150)` in compact mode, no two cell rectangles intersect, and each lane height equals max-cells-in-one-column × `ROW_H` + 24.
- [ ] **Step 2: Run it and confirm it fails.**
- [ ] **Step 3: Implement.**
  - **Depths.** Use Kahn's algorithm over the drawable nodes (work and gate). Nodes left after Kahn are `cyclic`. They are placed at 1 + the largest depth of their non-cyclic deps, so the function always returns.
  - **Lanes.** Map each worker's `agentId` to its `hostname ?? agentId`. The lane label is the hostname; `sub` is `os · agentIds`, or `'offline'`. Gates take the lane of the first dependent in key order.
  - **Cells.** Within one lane and column, sort cells by `priority`, then by `key`. A cell's `y` is the lane top + `HEAD_H` + row × `ROW_H`, and its `x` is `LABEL_W` + col × `COL_W`.
  - **Phase view.** Depths are recomputed over the members only, then shifted by +1 when there are inputs. Outputs go in the column after the members' last one. Detail sizes are used.
- [ ] **Step 4: Run it and confirm it passes.**
- [ ] **Step 5: Commit.** Run the gates, then commit `feat(dashboard): plan layout with depth columns and machine lanes`.

### Task 4: Critical path and same-file conflicts

**Files:**
- Create: `src/lib/conductor-plan/analysis.ts`, `analysis.test.ts`

**Interfaces:**
- Consumes: `PlanTask`, `computeDepths`.
- Produces:
  - `pathsOverlap(a: string, b: string): boolean`
  - `interface FileConflict { from: string; to: string; file: string }`
  - `fileConflicts(tasks: PlanTask[], depth: Map<string, number>): FileConflict[]`
  - `interface CriticalPath { ids: string[]; edges: Set<string> /* 'from>to' */; days: number }`
  - `criticalPath(tasks: PlanTask[], cyclic: Set<string>): CriticalPath`

- [ ] **Step 1: Write the failing tests.**
  - `pathsOverlap follows the trailing-slash prefix rule`:

    | a | b | Overlap |
    |---|---|---|
    | `src/a.ts` | `src/a.ts` | true |
    | `src/a/` | `src/a/b.ts` | true |
    | `src/a/b.ts` | `src/a/` | true (symmetric) |
    | `src/a/` | `src/a/` | true |
    | `src/a` | `src/ab.ts` | false |
    | `src/a/` | `src/ab/x.ts` | false |
    | `src/a` | `src/a/b.ts` | false (no trailing slash means a file) |
  - `fileConflicts chains tasks on one path instead of linking every pair`. Three tasks touch `x.ts` at depths 0, 1 and 2, giving exactly the two pairs 0→1 and 1→2.
  - `fileConflicts skips a pair already joined by a dependency`.
  - `tasks with no files never conflict`. Both `files []` and an unparsable `files` value give `[]`.
  - `fileConflicts leaves out stopped tasks`.
  - `criticalPath picks the heavier branch of a diamond by estimate`. With A(1)→B(3)→D(1) and A→C(1)→D, `ids` is `['A', 'B', 'D']`, `days` is 5, and `edges` is `{'A>B', 'B>D'}`.
  - `criticalPath defaults a missing estimate to 1`.
  - `criticalPath skips done and stopped tasks`. When A is done, the path starts at B.
  - `criticalPath ignores edges inside a cycle and still returns`.
  - `criticalPath breaks ties by key`, so the result is deterministic across polls.
- [ ] **Step 2: Run it and confirm it fails.**
- [ ] **Step 3: Implement.**
  - **Conflicts.** Group tasks by file key. A directory prefix also groups every task whose path falls under it. Sort each group by depth, then key, and pair consecutive tasks.
  - **Critical path.** Longest weighted path over the remaining (not done, not stopped) work and gate nodes, in the topological order from `computeDepths`, with edges into cyclic nodes dropped. A node's weight is its `estimate`.
- [ ] **Step 4: Run it and confirm it passes.**
- [ ] **Step 5: Commit.** Run the gates, then commit `feat(dashboard): critical path and same-file conflict detection`.

### Task 5: Summaries — progress, Needs you, Awaiting lead, tally, workers

**Files:**
- Create: `src/lib/conductor-plan/summary.ts`, `summary.test.ts`

**Interfaces:**
- Consumes: `PlanTask`, `PlanState`, `routeLabel`, `ConductorWorker`.
- Produces:
  - `type ProgressBucket = 'done' | 'review' | 'running' | 'ready' | 'waiting' | 'blocked'`
  - `progressCounts(tasks: PlanTask[]): Record<ProgressBucket, number> & { total: number; stopped: number }`
  - `interface NeedItem`: `kind: 'escalated' | 'user_gate' | 'no_worker' | 'blocked_by_stopped' | 'review' | 'lead_gate'`, `taskId`, `key`, `title`, `detail`, `tone: 'red' | 'amber' | 'violet'`
  - `needsYou(tasks: PlanTask[]): NeedItem[]`
  - `awaitingLead(tasks: PlanTask[]): NeedItem[]`, with kinds `'review'` and `'lead_gate'` and tone `'violet'`.
  - `routeTally(tasks: PlanTask[]): { label: string; count: number }[]`
  - `interface WorkerRow`: `agentId`, `hostname`, `os`, `status`, `currentTask: { id; key; title } | null`, `engines: string`, `quota: { label: string; until: string }[]`
  - `workerRows(workers: ConductorWorker[], tasks: PlanTask[], now: Date): WorkerRow[]`

- [ ] **Step 1: Write the failing tests.**
  - `progressCounts counts work tasks only and files escalated under blocked`. Gates, groups and the root are excluded. `state` maps to a bucket as follows:

    | State | Bucket |
    |---|---|
    | `done` | `done` |
    | `review` | `review` |
    | `running` | `running` |
    | `ready` | `ready` |
    | `waiting` | `waiting` |
    | `blocked` or `escalated` | `blocked` |
    | `stopped` | `stopped`, outside `total` |

    `total` is the sum of the six buckets.
  - `needsYou lists escalations, user gates, no_worker tasks and dependents of a stopped task`. The order is red first, then amber, then by key. `detail` comes from `nodeNote`, or reads `'depends on cancelled TT3'`.
  - `needsYou leaves out lead gates and reviews`.
  - `awaitingLead lists review tasks and lead gates`. `detail` holds the last review feedback when there is one.
  - `routeTally counts completed work tasks per executor·model`. It reads `current_route` and sorts by count descending, then by label. Tasks with no route count as `'unrouted'`, and non-done tasks are ignored.
  - `workerRows shows the current task by key and only quota rows still in the future`. A worker with `currentTaskId` outside this tree shows the raw id and a `null` title.
- [ ] **Step 2: Run it and confirm it fails.**
- [ ] **Step 3: Implement.** These are pure folds over `PlanTask[]`. "Dependents of a stopped task" means tasks whose `state` is `blocked` and that have a dep whose state is `stopped`.
- [ ] **Step 4: Run it and confirm it passes.**
- [ ] **Step 5: Commit.** Run the gates, then commit `feat(dashboard): plan progress, needs-you and fallback tally`.

### Task 6: React Flow building and the PlanDiagram component

**Files:**
- Create: `src/lib/conductor-plan/flow.ts`, `flow.test.ts`, `src/app/conductor/plan/PlanDiagram.tsx`, `src/app/conductor/plan/PlanNodes.tsx`, `src/app/conductor/plan/plan.module.css`

**Interfaces:**
- Consumes: `PlanLayout`, `PlanTask`, `CriticalPath`, `FileConflict`, `nodeNote`, `routeLabel`.
- Produces:
  - `STATUS_COLOR: Record<PlanState, string>`, `STATUS_LABEL: Record<PlanState, string>`
  - `type TaskNodeData`: `{ task: PlanTask; mode; critical: boolean; ghost: 'input' | 'output' | null; note: string | null; route: string | null; noFiles: boolean; selected: boolean }` plus the index signature React Flow 12 requires (see `PipelineDiagram.tsx` L26).
  - `GateNodeData`, `LaneNodeData` (`{ lane; width; height; index }`), `ColNodeData` (`{ label }`)
  - `toFlow(layout: PlanLayout, byId: Map<string, PlanTask>, critical: CriticalPath, conflicts: FileConflict[], mode: 'compact' | 'detail', now: Date, selectedId?: string): { nodes: Node[]; edges: Edge[] }`
  - `PlanDiagram(props: { tasks: PlanTask[]; workers: ConductorWorker[]; phase?: PhaseSelection; selectedId?: string; onSelect: (id: string) => void; viewKey: string })`
  - `nodeTypes` (module constant): `{ task: TaskNode, gate: GateNode, lane: LaneNode, col: ColNode }`

- [ ] **Step 1: Write the failing tests** in `flow.test.ts`.
  - `toFlow emits one node per cell plus background lane and column nodes`. Lane and column nodes have `zIndex -1`, `draggable false` and `selectable false`; there is one lane node per lane and one column node per column.
  - `a critical edge is red and 2.4 wide`.
  - `an edge from a done task is green, and an edge into a running task is animated`.
  - `edges into or out of a gate are amber, and green once the gate is done`.
  - `same-file edges are dashed orange and labelled with the file's basename only in detail mode`. The style has `strokeDasharray '6 4'`; in compact mode `label` is undefined.
  - `nodes carry critical, ghost and noFiles flags`. `noFiles` is true for a work task with `files []` that is not done. Gates never carry it.
  - `edges whose ends are not both laid out are dropped`. This covers phase view, where a ghost's own deps are not drawn.
- [ ] **Step 2: Run it and confirm it fails.**
- [ ] **Step 3: Implement `flow.ts`.**
  - Node ids are task ids; lanes use `lane:<id>` and columns use `col:<n>`.
  - Dependency edges use `smoothstep` and run dep → task with `MarkerType.ArrowClosed`.
  - Conflict edges use the `straight` type with id `file:<from>><to>`.
  - Colours and widths follow Global Constraints.
- [ ] **Step 4: Run it and confirm it passes.**
- [ ] **Step 5: Implement the components.** There is no unit test for these: they only render `toFlow` output. Their verification is Step 6 here and the manual checks in Task 9.
  - **`PlanNodes.tsx`**
    - `TaskNode` (compact) shows key, title (ellipsis) and route chip. The status shows as the left-border colour; the status label and note go in the `title` tooltip.
    - `TaskNode` (detail) shows key and title (2 lines), a status pill with the note, the agent, the route, `≈ N d`, the files (orange) or a muted "no files" tag, and a ghost tag ("input" or "output").
    - `GateNode` is a rounded, dashed amber node, green when done. It shows key, title and "user" or "lead".
    - `LaneNode` and `ColNode` are pointer-events-none backgrounds.
    - Handles are hidden (`.h { opacity: 0 }`).
  - **`PlanDiagram.tsx`**
    - Uses `useMemo` for `computeDepths → layoutPlan → criticalPath → fileConflicts → toFlow`.
    - Renders `<ReactFlow nodesDraggable={false} nodesConnectable={false} minZoom={0.1} maxZoom={1.5}>` with `Background`, `Controls` and a legend overlay (dependency, same-file, critical path, status colours).
    - Calls `fitView` from an effect keyed on `viewKey` only (`useReactFlow` inside a `ReactFlowProvider`), so 5 s polling never resets pan or zoom.
    - `onNodeClick` passes task and gate ids to `onSelect` and ignores lane and column nodes.
  - **`plan.module.css`**: port the mock rules listed in Global Constraints.
- [ ] **Step 6: Verify.** Run `pnpm --filter @cortex/dashboard-web typecheck` and `pnpm --filter @cortex/dashboard-web lint`.
- [ ] **Step 7: Commit.** Run the gates, then commit `feat(dashboard): plan diagram with lanes, gates, critical path and file edges`.

### Task 7: Progress bar and side panel

**Files:**
- Create: `src/app/conductor/plan/PlanProgress.tsx`, `src/app/conductor/plan/PlanSidePanel.tsx`
- Modify: `src/lib/conductor-plan/summary.ts`, `summary.test.ts`, `src/app/conductor/plan/plan.module.css`

**Interfaces:**
- Consumes: Task 5 outputs and `STATUS_COLOR`.
- Produces:
  - `progressSegments(counts): { bucket: ProgressBucket; count: number; percent: number; color: string }[]`, in `summary.ts`.
  - `PlanProgress({ counts })`
  - `PlanSidePanel({ needs, awaiting, workers, tally, critical, byId, onSelect })`

- [ ] **Step 1: Write the failing test.** `progressSegments drops empty buckets and its percentages sum to 100`. Use counts `{done 3, review 1, running 0, ready 2, waiting 0, blocked 4}`. Expect four segments in the fixed order done, review, running, ready, waiting, blocked, with percents summing to 100 ± 0.01. Also `progressSegments of an empty plan is []`.
- [ ] **Step 2: Run it and confirm it fails.**
- [ ] **Step 3: Implement.**
  - **`progressSegments`.**
  - **`PlanProgress`.** A stacked bar plus the legend `done/total · N%`, with one entry per bucket, plus `N cancelled` when `stopped > 0`.
  - **`PlanSidePanel` sections, in order:**
    - *Needs you*: red and amber items, each a button calling `onSelect(taskId)`, with a count badge. With no items it shows "Nothing needs you".
    - *Awaiting lead*: violet items, also buttons calling `onSelect`.
    - *Workers*: a dot (green idle, blue busy), agent, host, `current: KEY title` or idle, engines, and quota rows "agy·argon-low until 14:05 (in 2h)". With no workers it shows "No workers online for this project".
    - *Fallback tally*: `.route-row` bars, normalised to the largest count.
    - *Critical path*: `KEY → KEY → … · N d`.
- [ ] **Step 4: Run it and confirm it passes.** Then run `pnpm --filter @cortex/dashboard-web typecheck`.
- [ ] **Step 5: Commit.** Run the gates, then commit `feat(dashboard): plan progress bar and side panel`.

### Task 8: Task actions — approve, reject, clear escalation, reroute

**Files:**
- Create: `src/lib/conductor-plan/actions.ts`, `actions.test.ts`, `src/app/conductor/plan/PlanTaskActions.tsx`
- Modify: `src/app/conductor/components/TaskDetail.tsx`, which gets an `actions?: React.ReactNode` prop rendered above the existing footer buttons. No other behaviour changes.

**Interfaces:**
- Consumes: `reviewConductorTask`, `routeConductorTask`, `PlanTask`, `ConductorWorker`, `EXECUTORS`.
- Produces:
  - `availableActions(task: PlanTask): { review: boolean; clearEscalation: boolean; route: boolean }`
  - `interface RouteForm { executor: Executor | ''; model: string; effort: string; pinnedAgent: string }`
  - `routeFormFrom(task: PlanTask): RouteForm`
  - `routeBodyFromForm(form: RouteForm, task: PlanTask): RouteBody`. It returns only the changed fields, so an unchanged form gives `{}`.
  - `actionErrorMessage(err: unknown): string`. It duck-types `{ status, message, data }` and imports no `ApiError` value.
  - `PlanTaskActions({ task, workers, onDone }: { task: PlanTask; workers: ConductorWorker[]; onDone: () => void })`

- [ ] **Step 1: Write the failing tests.**
  - `a review task can be approved or rejected; a done task cannot`.
  - `a user gate awaiting approval can be reviewed; a lead gate is read-only on the dashboard`.
  - `clear escalation is offered only for escalated tasks`.
  - `route editing is offered for unfinished work tasks only`. It is not offered for gates, groups, done or stopped tasks.
  - `routeBodyFromForm sends only what changed`:

    | Change | Body |
    |---|---|
    | none | `{}` |
    | executor changed | `{ executor }` |
    | model cleared | `{ model: null }` |
    | pinned agent cleared | `{ pinnedAgent: null }` |
  - `actionErrorMessage maps 409, 403 and a 400 cycle`. A 409 gives `'This task changed state on the hub — the view has been refreshed.'`. A 403 gives the hub's own `message`. A 400 with `data.cycle ['A','B','A']` gives `'That change would create a cycle: A → B → A'`. A plain `Error` gives its message.
- [ ] **Step 2: Run it and confirm it fails.**
- [ ] **Step 3: Implement.**
  - **`actions.ts`.**
  - **`PlanTaskActions`.**
    - *Approve* and *Reject* buttons. Reject opens a required feedback textarea and is disabled while the textarea is empty. Both send `by: 'dashboard'`.
    - *Clear escalation* calls `routeConductorTask(id, { clearEscalation: true })`.
    - *Route* is a form:
      - an executor `<select>` over `EXECUTORS` plus "any";
      - a model `<input list>` whose `<datalist>` comes from the selected executor's `engines[].models` across `workers`, skipping `'*'`;
      - an effort text input;
      - a pinned-agent `<select>` over the workers.
      - *Save* is disabled while `routeBodyFromForm` returns `{}`.
    - Each call sets a busy state. On success it calls `onDone()`, which revalidates the tree; on failure it shows `actionErrorMessage(err)` inline in `var(--status-error)`, and on a 409 it also calls `onDone()`.
    - The review history (`task.reviews`) shows below as `by · verdict · feedback · time ago`, using `formatTimeAgo` from `components/shared`.
- [ ] **Step 4: Run it and confirm it passes.** Then run `pnpm --filter @cortex/dashboard-web typecheck`.
- [ ] **Step 5: Commit.** Run the gates, then commit `feat(dashboard): approve, reject, clear escalation and reroute from the plan`.

### Task 9: PlanView on /conductor (tree fetch, polling, phase tabs) and removal of PipelineDiagram

**Files:**
- Create:
  - `src/app/conductor/plan/PlanView.tsx`
  - `src/lib/conductor-plan/__fixtures__/seed-plan.json`
- Modify:
  - `src/lib/conductor-plan/summary.ts` and `summary.test.ts` (`groupTabs`)
  - `src/app/conductor/page.tsx`
  - `src/app/conductor/page.module.css`
  - `src/app/conductor/components/index.ts`
- Delete: `src/app/conductor/components/PipelineDiagram.tsx`, `PipelineDiagram.module.css`

**Interfaces:**
- Consumes: everything above, plus `getConductorTree` and `TaskDetail` with its `actions` slot.
- Produces:
  - `groupTabs(tasks: PlanTask[]): { id: string; label: string; count: number; days: number }[]`, in `summary.ts`.
  - `PlanView({ rootId, onClose }: { rootId: string; onClose: () => void })`

- [ ] **Step 1: Write the failing test.** `groupTabs lists groups in key order with work-task counts and summed estimates`. The label is `task_key ?? title`. A group with no work tasks shows `count 0`, and a legacy tree gives `[]`.
- [ ] **Step 2: Run it and confirm it fails.**
- [ ] **Step 3: Implement `groupTabs` and run the test until it passes.**
- [ ] **Step 4: Implement `PlanView`.**
  - **Data.**
    - `useSWR(['conductor-tree', rootId], () => getConductorTree(rootId), { refreshInterval: 5000, keepPreviousData: true })`. SWR does not poll hidden tabs by default.
    - `useMemo(() => toPlanTasks(root, tasks))`.
  - **Layout.** A full-viewport overlay (`position: fixed; inset: 0`) containing:
    - a header with the root title, a "× Close" button and group tabs ("All" + `groupTabs`);
    - `PlanProgress`;
    - a body with `PlanDiagram` (flex: 1) and `PlanSidePanel` (330 px).
    - Below 900 px wide the side panel stacks under the diagram.
  - **Phase view.** With a group selected, `phase = selectPhase(tasks, groupId)`, `viewKey = rootId + ':' + groupId`, and detail mode.
  - **Task detail.** Clicking a node or a side-panel item sets `selectedId` and opens the existing `TaskDetail` for `byId.get(selectedId).row`, with `actions={<PlanTaskActions … onDone={() => mutate()} />}`. `TaskDetail`'s existing `onCancel` calls `cancelConductorTask` and then `mutate()`. `onMarkDone` is not passed, because completion goes through review.
  - **Error states.**
    - A 404 shows "This plan no longer exists" with a Close button.
    - Other errors show the message, and a Retry button calls `mutate()`.
    - A tree with no drawable tasks shows "This plan has no tasks yet".
- [ ] **Step 5: Wire it into `page.tsx`.**
  - Rename `diagramPipelineId` to `planRootId`, and the card button label "Diagram" to "Plan".
  - Replace the "Pipeline Diagram Modal" block (L708–729) with `{planRootId && <PlanView rootId={planRootId} onClose={() => setPlanRootId(null)} />}`.
  - Delete the `diagramTasks` memo (L488–499) and the `PipelineDiagram` import.
  - The flat `getConductorTasks({ limit: 200 })` list stays: it only feeds the pipeline cards, and the plan view no longer depends on it. A1 adds `parent_task_id=none` (top-level tasks only) to `GET /api/conductor`; moving the cards onto it is a follow-up, not part of this plan.
  - Delete both `PipelineDiagram` files, the `PipelineDiagram` export in `components/index.ts`, and the `.diagramModal*` rules in `page.module.css` (L2728–2785 and the one in the `@media` block near L3415).
- [ ] **Step 6: Write `seed-plan.json`.** This is a `POST /api/conductor/tree` body: `{ "tasks": [...] }` with a root group `DEMO` "Plan view demo", groups `P1` and `P2` (`parentKey: DEMO`), and these tasks:

  | key | kind | group | dependsOn | files | estimate | route |
  |---|---|---|---|---|---|---|
  | A1 | work | P1 | — | `src/db/schema.ts` | 1 | agy / gemini-4-argon-low, fallback `[{claude, opus}]` |
  | A2 | work | P1 | A1 | `src/routes/` | 2 | codex |
  | A3 | work | P1 | A1 | `src/routes/items.test.ts` | 1 | — |
  | A4 | work | P1 | — | *(none)* | 0.5 | — |
  | G1 | gate, approver `user` | P1 | A2, A3 | — | — | — |
  | B1 | work | P2 | G1 | `src/ui/list.tsx` | 3 | agy / gemini-4-argon-low |
  | B2 | work | P2 | G1 | `src/ui/list.tsx` | 1 | — |
  | B3 | work | P2 | P1, B1, B2 | — | 1 | — |
  | G2 | gate, approver `lead` | P2 | B3 | — | — | — |

  `estimate` goes in `context`.
- [ ] **Step 7: Manual check** (A1 running, `pnpm --filter @cortex/dashboard-web dev`). Seed with `curl -sX POST $API/api/conductor/tree -H 'Content-Type: application/json' -d @apps/dashboard-web/src/lib/conductor-plan/__fixtures__/seed-plan.json`. Add your API key header if your hub requires one. Then open the plan from its card on `/conductor` and confirm:
  - **Columns.** A1 and A4 are in Step 1; A2 and A3 in Step 2; G1 in Step 3; B1 and B2 in Step 4; B3 in Step 5; G2 in Step 6. B3's dependency on `P1` draws edges from G1 and A4, the sinks of P1.
  - **No workers.** With no worker online, ready tasks show as *waiting · no worker for …* and are listed under *Needs you*. That is the expected §7 behaviour.
  - **Lanes.** With no worker running, every node is in the `queue` lane. If an A2 worker is available, start it: the task it takes moves to that machine's lane within 5 s.
  - **Same-file edges.** Dashed orange A2→A3 (`src/routes/` contains `items.test.ts`) and B1→B2. A4 shows "no files".
  - **Critical path.** A1→A2→G1→B1→B3→G2 is outlined in red, and the side panel reads "≈ 9 d".
  - **Phase view.** The `P2` tab shows G1 greyed in the "Inputs" column, plus A4, because of B3's group dependency. Polling does not reset zoom or pan after 15 s.
  - **Review and escalation.**
    - `PUT /api/conductor/<A1 id> {"status":"completed"}`, then `PUT <A2 id> {"status":"review"}`. A2 appears under *Awaiting lead*.
    - Reject A2 with feedback; it returns to `pending`, shown as ready or waiting.
    - Put it back in review and reject again. A2 appears under *Needs you* in red as escalated; *Clear escalation* removes it.
  - **Gate.** Complete A2 and A3 (PUT). G1 appears under *Needs you* as a user gate; *Approve* moves B1 and B2 out of blocked.
  - **Errors.** Approve A2 a second time from a stale panel: the 409 message shows and the view refreshes.
  - **Reroute.** Change B1's route to codex. The chip updates to `codex` on the next poll.
  - **Legacy.** An old pipeline (created before A1) opens as a single column with no errors.
- [ ] **Step 8: Commit.** Run the gates, then commit `feat(dashboard): plan view replaces the pipeline diagram`. Stage the deletions with `git add -A apps/dashboard-web/src/app/conductor`, then check `git status` to confirm that none of the user's pending files are staged.

### Task 10: Agents Online lists MCP sessions (conductor page and home)

**Files:**
- Modify:
  - `src/lib/conductor-plan/summary.ts` and `summary.test.ts` (`agentsOnline`)
  - `src/app/conductor/page.tsx` (Agents section, about L385–400 and L552–620)
  - `src/app/conductor/page.module.css`
  - `src/app/page.tsx` (L170). Rebase onto the user's fix first.

**Interfaces:**
- Consumes: `getConductorAgents` (with `sessions`), `getIdeInfo` and `formatTimeAgo` from `components/shared`.
- Produces: `agentsOnline(workers: ConductorWorker[], sessions: ConductorSession[]): { workers: ConductorWorker[]; sessions: ConductorSession[]; total: number }`. `sessions` is the list of sessions whose `agentId` is not already a worker, and `total` is the count of unique agent ids.

- [ ] **Step 1: Write the failing tests.**
  - `agentsOnline counts an agent that is both a worker and a session once`.
  - `agentsOnline with no workers lists all sessions`.
  - `agentsOnline tolerates a missing sessions array` (`undefined` from an older hub gives `[]`).
- [ ] **Step 2: Run it and confirm it fails.**
- [ ] **Step 3: Implement.**
  - **`/conductor`.**
    - The section renders when `total > 0`, and the header reads "Agents · N online".
    - Worker cards gain an *Engines* row (`executor (n models)`) and a *Task* row (the current task id, or "idle").
    - Below the worker grid, an *MCP sessions* list shows compact rows: IDE icon, `agentId`, hostname, branch and `lastActivity` time ago.
    - Session rows are not clickable, because `AgentDetail` expects a worker.
  - **Home.** `onlineAgents = agentsOnline(agentsData?.agents ?? [], agentsData?.sessions ?? []).total`.
- [ ] **Step 4: Run it and confirm it passes.** Then do a manual check: with one worker and one Claude Code MCP session open, `/conductor` shows both, and the home "Agents Online" card shows 2. If the session uses the same agent id as the worker, it shows 1.
- [ ] **Step 5: Commit.** Run the gates, then commit `feat(dashboard): agents online lists MCP sessions next to workers`. If the user's fix has not landed yet, commit the `/conductor` part now and the home-page line after rebasing. Never stage the user's hunks.

### Task 11: Final verification

**Files:** none new.

- [ ] **Step 1:** Run `pnpm build && pnpm typecheck && pnpm lint && pnpm test` from the repo root. All pass, and the dashboard-web suite reports the tests from Tasks 1–10.
- [ ] **Step 2:** Run `git diff --stat master...HEAD`. Expect only `apps/dashboard-web/**` and `pnpm-lock.yaml`, with none of the user's pending files.
- [ ] **Step 3:** Re-run the Task 9 Step 7 checklist on a fresh seed with the production build. Use `pnpm --filter @cortex/dashboard-web build`, then serve `apps/dashboard-web/out` behind the API as the Docker image does, or use `next dev` if the static serve is not set up locally.
- [ ] **Step 4:** Spec §7 self-check. Each bullet maps to a task:
  - tree fetch and polling: Task 9;
  - columns, lanes, deps, gates, same-file edges, critical path, node contents: Tasks 3, 4 and 6;
  - progress: Tasks 5 and 7;
  - side panel: Tasks 5 and 7;
  - phase view: Tasks 3 and 9;
  - actions: Task 8;
  - Agents Online: Task 10;
  - §11 "no files" marker: Task 6.
- [ ] **Step 5:** Run `cortex_detect_changes` with the staged diff headers and record the risk level in the PR description.
