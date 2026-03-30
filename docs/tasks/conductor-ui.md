# Conductor Dashboard UI — Task for Antigravity

## Your Mission
Build the `/conductor` page for Cortex Hub dashboard — a real-time task orchestration board where users see live agents and manage cross-agent tasks.

## Read First
- `docs/architecture/conductor-design.md` — full spec with wireframes
- `apps/dashboard-web/src/app/sessions/page.tsx` — reference pattern for page structure
- `apps/dashboard-web/src/lib/api.ts` — API client pattern (add new functions here)
- `apps/dashboard-web/src/components/layout/Sidebar.tsx` — add new nav entry

## API Endpoints (already built, just call them)

```
GET  /api/tasks                 — list tasks (?status=pending&assignedTo=agent-1)
GET  /api/tasks/board           — kanban grouped by status
GET  /api/tasks/agent/:agentId  — tasks for one agent
POST /api/tasks                 — create task { title, description, assignTo, priority }
PATCH /api/tasks/:id            — update { status, result }
POST /api/tasks/:id/assign      — assign { agentId, sessionId }
GET  /api/tasks/:id/logs        — activity log
GET  /api/sessions/all          — active sessions (for agent list)
```

## Files to Create/Edit

### New files:
1. `apps/dashboard-web/src/app/conductor/page.tsx` — main page
2. `apps/dashboard-web/src/app/conductor/page.module.css` — styles

### Edit:
3. `apps/dashboard-web/src/components/layout/Sidebar.tsx` — add nav item
4. `apps/dashboard-web/src/lib/api.ts` — add Task types + API functions

## Layout (3-panel)

```
┌─ Left Panel ──────┬─ Center Panel ──────────────┬─ Right Panel ─────┐
│ Active Agents      │ Task Board (Kanban)          │ Task Detail       │
│                    │                              │                   │
│ 🟢 claude-mac     │ Pending │ Active │ Done      │ Title: ...        │
│   macOS, godot     │ ┌─────┐ ┌─────┐ ┌─────┐    │ Status: active    │
│                    │ │task1│ │task3│ │task5│    │ Agent: claude-vps │
│ 🟢 claude-vps     │ │task2│ │task4│ │     │    │ Logs:             │
│   Windows, extract │ └─────┘ └─────┘ └─────┘    │ - created 2m ago  │
│                    │                              │ - accepted 1m ago │
│ 🔴 codex          │ [+ New Task]                 │ - progress: 60%   │
│   offline          │                              │                   │
└────────────────────┴──────────────────────────────┴───────────────────┘
```

## Design Requirements
- Match existing dark theme (CSS variables from other pages)
- Use SWR for real-time polling (5s interval) — see sessions/page.tsx pattern
- Agent cards show: name, OS badge, role, capabilities, current task
- Task cards show: title, priority badge, assigned agent, status
- Click task → right panel shows detail + activity log
- "New Task" button opens create dialog
- Responsive: stack panels vertically on mobile

## Tech Stack (match existing)
- Next.js 15 App Router
- CSS Modules (page.module.css)
- SWR for data fetching
- No additional dependencies

## Use Cortex tools
Before coding, search for patterns:
```
cortex_code_search("dashboard page component SWR fetch")
cortex_knowledge_search("conductor dashboard design")
```
