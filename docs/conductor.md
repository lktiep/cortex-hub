# Cortex Conductor — Multi-Agent Orchestration

> **Production-ready for the rows marked ✅ below; 🔄 and 📋 rows are not.**
>
> One-page tour: [lktiep.github.io/cortex-hub/conductor](https://lktiep.github.io/cortex-hub/conductor/). Before relying
> on it on your machines, run the [manual test checklist](conductor/manual-test-checklist.md).

## What It Is

Cortex Conductor coordinates multiple AI coding agents (across machines, IDEs, and engines) so they can delegate tasks to each other instead of waiting on a human.

```
Agent A (Claude/macOS)            Agent B (Codex/Linux)            Agent C (Antigravity)
═════════════════════             ═════════════════════            ═════════════════════
Build feature X        ─────►     Pickup: write tests      ─────►  Pickup: review PR
                                   ████████ running                 ░░░░ queued
Switch to feature Y               Tests done ✓                     Review done ✓
(non-blocked)                     → notify A                       → notify A

Apply tests + review feedback
████████ Feature X complete ✓
```

## Current Status

✅ means a test file on this branch covers the row and passes. 🔄 means it works but rests on a
check nobody has run yet; the Evidence column names that check. 📋 means planned.

| Capability | State | Evidence |
|------------|-------|----------|
| Plan trees and cycle check | ✅ | `apps/dashboard-api/src/conductor/tree.test.ts` |
| Dispatcher (dependencies, priority, file locks) | ✅ | `apps/dashboard-api/src/conductor/dispatch.test.ts`, `files.test.ts` |
| Per-task routing and fallback | ✅ | `apps/dashboard-api/src/conductor/select.test.ts` |
| Quota record, wait reason and lead notice | ✅ | `apps/dashboard-api/src/conductor/lifecycle-attempts.test.ts`, `notify.test.ts` |
| Leases and offline reclaim | ✅ | `apps/dashboard-api/src/conductor/scheduler.test.ts` |
| Review approve/reject on the same branch | ✅ | `apps/dashboard-api/src/conductor/lifecycle-review.test.ts` |
| Escalation after two failures or rejections | ✅ | `apps/dashboard-api/src/conductor/lifecycle-attempts.test.ts`, `lifecycle-review.test.ts` |
| User and lead gates | ✅ | `apps/dashboard-api/src/routes/conductor-v2.test.ts`, `apps/hub-mcp/src/tools/conductor-lead.test.ts` |
| The 📋 lead notifications (`review_ready`, `escalated`, `capacity`, `gate_ready`, `no_worker`) | ✅ | `apps/dashboard-api/src/conductor/notify.test.ts` |
| TypeScript worker on macOS and Linux (worktree → PR) | ✅ | `apps/conductor-worker/src/e2e/worker.e2e.test.ts` |
| TypeScript worker on Windows (worktree → PR) | 🔄 | The end-to-end test is skipped on Windows; manual check 8 of the [checklist](conductor/manual-test-checklist.md#8-worker-on-windows) is pending |
| Engine: agy | ✅ | `apps/conductor-worker/src/engines/agy.test.ts` pins its verified quota output |
| Engines: claude, codex, gemini | 🔄 | Quota patterns are best effort; checked only against fixtures, no live quota hit yet ([check 6](conductor/manual-test-checklist.md#6-quota-output-of-claude-codex-and-gemini)) |
| Dashboard plan view | ✅ | `apps/dashboard-web/src/lib/conductor-plan/*.test.ts` |
| Extension URL detection | ✅ | `apps/cortex-extension/src/mcp-config.test.ts` |
| Setup guide | 🔄 | [`conductor/setup.md`](conductor/setup.md) is written; no machine has followed it end to end yet. Dashboard Settings shows the copyable worker bootstrap ("Run a worker") and the `"type": "http"` Claude Code snippet |
| Per-task cost tracking | 📋 | Planned |
| Autostart on boot | 📋 | Planned |
| Semantic capability matching | 📋 | Planned |
| Editing a task's description over MCP | 📋 | Planned |

## Quick Tour

### 1. Start a worker
Run this inside a clone of the project. Setup for each machine is in
[`conductor/setup.md`](conductor/setup.md).

```bash
curl -fsSL https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/run-agent.sh | CORTEX_API_KEY=<worker-api-key> bash -s -- start --daemon --hub https://<your-mcp-host>
```

```powershell
$env:CORTEX_API_KEY="<worker-api-key>"; iwr -useb https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/run-agent.ps1 -OutFile $env:TEMP\run-agent.ps1; powershell -NoProfile -ExecutionPolicy Bypass -File $env:TEMP\run-agent.ps1 start --daemon --hub https://<your-mcp-host>
```

### 2. Create a plan (from Claude Code or any MCP client)
A plan goes under one `group` task. Each top-level item sets its key as `parentKey`.

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

### 3. Watch on Dashboard
Navigate to `/conductor` to see:
- The plan tree with dependencies and gates
- Live agent cards (online/busy/idle)
- Task detail panel with logs, result, review and routing

## MCP Tools

| Tool | Purpose |
|------|---------|
| `cortex_task_create` | Create a task, optionally assign to agent or by capabilities |
| `cortex_task_tree_create` | Create a plan of tasks with keys, `dependsOn`, `files` and gates in one call |
| `cortex_task_list` | Filter tasks by project, status, assignee |
| `cortex_task_pickup` | Get tasks assigned to current agent |
| `cortex_task_accept` | Accept an assigned task before working |
| `cortex_task_status` | Get full task details with logs |
| `cortex_task_update` | Transition status (in_progress → completed/failed) |
| `cortex_task_submit_strategy` | Propose execution plan for user review (Lead Agent pattern) |
| `cortex_agents` | List online workers, their engines and quota |
| `cortex_task_review` | Approve or reject a finished task (`verdict`, `feedback`); also closes `approver: 'lead'` gates. User gates are refused over MCP and are closed from the dashboard |
| `cortex_task_route` | Change a task's executor, model, fallback, files or `dependsOn` (stored task IDs) |
| `cortex_task_cancel` | Cancel a task (`taskId`, optional `reason`) |

## Known Limitations

1. **Quota patterns are unverified** for claude, codex and gemini. Only agy's quota output has been verified.
2. **Locks are only as good as `files`.** A task that does not list the files it touches is not protected from conflicts.
3. **agy start-up takes about 2 minutes** per task, because it starts every MCP server it has. To shorten it, trim agy's MCP server list.
4. **A shared key splits notifications.** Notices are delivered once per API key, to whichever session polls first. A worker's engines calling hub tools with the lead's key would consume the lead's notices. Use separate API keys for the lead and for workers (see [API keys](conductor/setup.md#2-api-keys)).
5. **User gates are dashboard-only, and the dashboard has no login.** Anyone who can open it can approve a user gate.
6. **No MCP tool edits a task's description.** Replace the task instead.

## Design Document

Full architecture design at [`docs/architecture/conductor-design.md`](architecture/conductor-design.md). Its worker, dispatch and review parts are superseded by the [2026-10-16 spec](superpowers/specs/2026-10-16-conductor-production-ready-design.md); read it for the scope model and identity resolution.

## When to Use vs When to Wait

**Use Conductor today for:**
- Plans whose tasks list their `files`, so the dispatcher can lock them
- Workers on the ✅ rows above (agy; macOS or Linux)
- Work where you review each result or gate yourself

**Wait on the 🔄 and 📋 rows if:**
- You depend on claude, codex or gemini quota handling, or on Windows workers
- You need per-task cost tracking, autostart on boot or semantic capability matching
