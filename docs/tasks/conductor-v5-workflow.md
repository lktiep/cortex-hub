# Conductor v5: Multi-Agent Research Workflow

> **Status**: Planning (2026-04-01)
> **Author**: claude-code
> **Depends on**: commit `044be04` (UX overhaul by antigravity)

## Context

When a user creates a multi-agent research task (e.g., "Rà soát workflow cần cải thiện gì"), the expected flow is:

1. User describes task → selects Lead Agent → Lead Agent receives via WebSocket
2. Lead Agent (real AI agent running in IDE) **analyzes** → creates strategy → creates subtasks → assigns agents
3. Agents complete subtasks with structured findings → Lead Agent synthesizes
4. User reviews & approves individual findings on dashboard

### What's already done (commit `044be04`)
- Task outcome visibility (`getResultSummary`, `getTaskDuration` on cards/rows/diagram)
- Diagram edge labels + colors + result preview in nodes
- LiveOutput shows all lifecycle events, not just progress

### What's broken
- **Strategy is fake**: `TaskBriefingWizard.tsx:139-214` uses `setTimeout(2500)` + keyword matching instead of waiting for the Lead Agent's real analysis
- **MCP tools call legacy endpoints**: All 6 tools hit `/api/tasks` instead of `/api/conductor` (which has orchestration logic: dependency chains, auto-review, delegation)
- **No structured output**: Agents submit `result` as arbitrary JSON, no schema enforcement
- **Parent auto-completes**: `checkParentCompletion()` auto-sets parent to `completed` instead of letting Lead Agent synthesize
- **No discussion**: Agents can't comment on each other's findings
- **No approval UX**: User can't approve/reject individual findings

### Out of scope
- LLM calls from backend (agents handle their own AI)
- Inter-agent SDK conversation (extension scope, not dashboard)
- UX improvements already shipped in `044be04`

---

## Phase 1: Real Strategy Flow + MCP Migration

**Goal**: Lead Agent actually analyzes the task. No more keyword simulation.

### 1A. Backend: New statuses + strategy endpoint

**File: `apps/dashboard-api/src/routes/conductor.ts`**

Add `PUT /api/conductor/:id/strategy`:
```
Body: { strategy: TaskStrategy }
Effect: Save to context.strategy, set status='strategy_review', broadcast WS task.strategy_ready
```

Add `POST /api/conductor/:id/strategy/approve`:
```
Effect: Set status='in_progress', context.phase='execution'
```

**File: `apps/dashboard-api/src/db/schema.sql`**
- Add to CHECK constraint: `'analyzing'`, `'strategy_review'`, `'synthesis'`, `'discussion'`

**File: `apps/dashboard-api/src/ws/conductor.ts`**
- Broadcast `task.strategy_ready` when strategy submitted

### 1B. MCP Tool: `cortex_task_submit_strategy`

**File: `apps/hub-mcp/src/tools/tasks.ts`**
```
cortex_task_submit_strategy(taskId, strategy: {
  summary: string
  roles: { role, label, agent, rationale, capabilities? }[]
  subtasks: { title, description?, role, dependsOn?, priority? }[]
  estimatedEffort?: string
})
```
Calls `PUT /api/conductor/:id/strategy`. Lead Agent uses this after analyzing the task.

### 1C. Dashboard: Wizard waits for real strategy

**File: `apps/dashboard-web/src/app/conductor/components/TaskBriefingWizard.tsx`**

`handleAssignAndAnalyze()` (line 106-220):
- **Remove**: `setTimeout(2500)` + keyword matching block (line 139-214)
- **Replace with**:
  1. Create task with status `analyzing` (keep existing)
  2. Poll `GET /api/conductor/:id` every 3s
  3. When `task.status === 'strategy_review'` → read `task.context.strategy` → show StrategyReview
  4. 5-minute timeout → show retry message

`handleApproveStrategy()` (line 223-263):
- After creating subtasks → call `POST /api/conductor/:id/strategy/approve`
- `StrategyReview.tsx` unchanged (already renders `TaskStrategy` shape correctly)

### 1D. MCP Tools: Migrate to `/api/conductor`

**File: `apps/hub-mcp/src/tools/tasks.ts`**

| Tool | Current endpoint | New endpoint |
|------|-----------------|--------------|
| `cortex_task_create` | POST `/api/tasks` | POST `/api/conductor` |
| `cortex_task_pickup` | GET `/api/tasks?status=...` | POST `/api/conductor/pickup` |
| `cortex_task_accept` | PATCH `/api/tasks/:id` | PUT `/api/conductor/:id` |
| `cortex_task_update` | PATCH `/api/tasks/:id` | PUT `/api/conductor/:id` |
| `cortex_task_list` | GET `/api/tasks` | GET `/api/conductor` |
| `cortex_task_status` | GET `/api/tasks/:id` | GET `/api/conductor/:id` |

Keep `/api/tasks` routes as deprecated alias.

---

## Phase 2: Structured Output + Lead Agent Synthesis

### 2A. Structured Output Schema

**File: `apps/dashboard-web/src/app/conductor/components/shared.ts`**
```typescript
interface StructuredFinding {
  id: string
  title: string
  description: string
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
  category: string
  evidence: string[]
  proposal: string
  effort: 'trivial' | 'small' | 'medium' | 'large'
}

interface StructuredTaskResult {
  summary: string
  findings: StructuredFinding[]
}
```

Update `getResultSummary()` (from `044be04`) to handle findings:
```typescript
if (Array.isArray(parsed.findings)) {
  const count = parsed.findings.length
  const critical = parsed.findings.filter(f => f.severity === 'critical').length
  return `${count} findings (${critical} critical): ${parsed.summary?.slice(0, 60) ?? ''}`
}
```

### 2B. MCP Tool: `cortex_task_submit_findings` (PLANNED — not yet implemented)

> **Current workaround:** Use `cortex_task_update(taskId, status: "completed", result: { summary, findings })` instead.

Calls PUT `/api/conductor/:id` with `{ status: 'completed', result: { summary, findings } }`

### 2C. Lead Agent Synthesis (replace auto-complete)

**File: `apps/dashboard-api/src/routes/conductor.ts`**

`checkParentCompletion()` (line 233-284):
- **Current**: Auto-completes parent with `{ subtaskResults, autoCompleted: true }`
- **Change to**:
  1. Set parent status = `'synthesis'`
  2. Collect all subtask results into `context.subtaskResults`
  3. Notify Lead Agent (parent's `assigned_to_agent`) via WS: `task.synthesis_ready`
  4. Lead Agent receives notification → reads subtask results → synthesizes → submits via `cortex_task_update` or `cortex_task_submit_findings`
  5. Fallback: if Lead Agent offline >10 minutes → auto-complete as before

---

## Phase 3: Discussion + Decision Matrix

### 3A. Comments

**File: `apps/dashboard-api/src/db/schema.sql`**
```sql
CREATE TABLE IF NOT EXISTS conductor_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  finding_id TEXT,
  agent_id TEXT NOT NULL,
  comment TEXT NOT NULL,
  comment_type TEXT DEFAULT 'comment', -- comment/agree/disagree/amendment
  created_at TEXT DEFAULT (datetime('now'))
);
```

**File: `apps/dashboard-api/src/routes/conductor.ts`**
- `POST /api/conductor/:id/comments` — agent/user submit comment
- `GET /api/conductor/:id/comments` — list comments for a task

**File: `apps/hub-mcp/src/tools/tasks.ts`**
- `cortex_task_comment(taskId, comment, findingId?, commentType?)` **(PLANNED — not yet implemented)**

### 3B. Decision Matrix UI

**File: `apps/dashboard-web/src/app/conductor/components/DecisionMatrix.tsx`** (NEW)
- Table columns: Title | Severity | Category | Agent | Effort | Comments | Approve/Reject
- Sortable, filterable, bulk approve/reject
- Expandable rows (description, evidence, comments)

**File: `apps/dashboard-web/src/app/conductor/components/TaskDetail.tsx`**
- When task has `result.findings[]` → render DecisionMatrix instead of raw JSON
- Leverage timeline component from `044be04`

### 3C. Decision API

**File: `apps/dashboard-api/src/routes/conductor.ts`**
- `PUT /api/conductor/:id/matrix/:findingId` — approve/reject individual finding
- `POST /api/conductor/:id/finalize` — complete task with only approved findings
- Decision state stored in `context.decisions`:
  ```json
  { "finding-1": { "status": "approved" }, "finding-2": { "status": "rejected", "reason": "..." } }
  ```

---

## Phase 4: WebSocket Dashboard (replace polling)

### 4A. useConductorWebSocket hook

**File: `apps/dashboard-web/src/hooks/useConductorWebSocket.ts`** (NEW)
- Connect to `/ws/conductor?apiKey=...&agentId=dashboard-web`
- Listen: `task.*`, `agent.*`, `strategy_ready`, `task.comment`
- Auto-reconnect with exponential backoff
- Fallback to SWR polling at 30s interval

### 4B. Replace polling in page

**File: `apps/dashboard-web/src/app/conductor/page.tsx`**
- Replace `useSWR({ refreshInterval: 10000 })` with WS hook
- Keep SWR for initial data load + fallback

**File: `apps/dashboard-web/src/app/conductor/components/LiveOutput.tsx`**
- Replace 5s polling (from `044be04`) with WS subscription for `task.progress`

---

## Implementation Order

```
Phase 1 (1-2 sessions) ← START HERE
  1A: Backend statuses + strategy endpoint
  1B: cortex_task_submit_strategy tool
  1C: Wizard waits for real agent strategy
  1D: MCP tools migrate to /api/conductor

Phase 2 (1 session)
  2A: StructuredFinding types + update getResultSummary
  2B: cortex_task_submit_findings tool
  2C: checkParentCompletion → synthesis + notify Lead Agent

Phase 3 (1 session)
  3A: Comments table + API + MCP tool
  3B: DecisionMatrix.tsx component
  3C: Decision API + finalize endpoint

Phase 4 (1 session)
  4A-4B: WS hook + replace polling
```

## Critical Files

| File | Phase | Changes |
|------|-------|---------|
| `apps/dashboard-api/src/routes/conductor.ts` | 1,2,3 | Strategy endpoint, synthesis logic, comments API, decision API |
| `apps/dashboard-api/src/ws/conductor.ts` | 1,3 | strategy_ready broadcast, comment handler |
| `apps/dashboard-api/src/db/schema.sql` | 1,3 | New statuses, comments table |
| `apps/hub-mcp/src/tools/tasks.ts` | 1,2,3 | Migrate endpoints + 3 new tools |
| `apps/dashboard-web/.../TaskBriefingWizard.tsx` | 1 | Replace simulation with agent polling |
| `apps/dashboard-web/.../shared.ts` | 2 | StructuredFinding types, update getResultSummary |
| `apps/dashboard-web/.../DecisionMatrix.tsx` | 3 | NEW component |
| `apps/dashboard-web/.../TaskDetail.tsx` | 3 | DecisionMatrix integration |
| `apps/dashboard-web/src/hooks/useConductorWebSocket.ts` | 4 | NEW hook |

## Verification

- **Phase 1**: Wizard → assign lead → agent receives via WS → submits strategy via MCP → dashboard shows real strategy → approve → subtasks created
- **Phase 2**: Agents submit structured findings → parent enters synthesis → Lead Agent synthesizes
- **Phase 3**: Comments + DecisionMatrix visible on dashboard → user approve/reject per finding
- **Phase 4**: Dashboard updates in real-time via WS, no polling

Quality gates: `pnpm build && pnpm typecheck && pnpm lint`
