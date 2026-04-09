# Cortex Conductor — Multi-Agent Orchestration

> ⚠️ **Experimental Feature.** Conductor is being actively developed and is **not feature-complete**. Use at your own risk in non-critical projects.

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

| Capability | State | Notes |
|------------|-------|-------|
| Agent identity (hostname, OS, IDE, capabilities) | ✅ Shipped | Auto-detected via `cortex_session_start` |
| Agent registry + WebSocket connection | ✅ Shipped | Real-time agent status, project/branch tracking |
| Task creation + assignment (`cortex_task_create`) | ✅ Shipped | Including `dependsOn` and `requiredCapabilities` |
| Task pickup (`cortex_task_pickup`) | ✅ Shipped | Auto-detects via agentId or API key name |
| Task lifecycle (accept → in_progress → completed) | ✅ Shipped | With status transitions and logs |
| Strategy review (`cortex_task_submit_strategy`) | ✅ Shipped | Lead agent proposes plan → user approves |
| Dashboard /conductor page | ✅ Shipped | Task list, agent cards, pipeline view, detail panel |
| Auto-reassignment on failure | 🔄 Partial | Limited retry logic, no smart fallback |
| Strategy auto-approval policies | 🔄 Partial | All strategies require human approval |
| Cross-IDE notification (push, not poll) | 🔄 Partial | Claude Code CLI works, others incomplete |
| Smart agent matching by capability | 📋 Planned | Currently manual or first-available |
| Task dependency auto-resolution | 📋 Planned | Manual `dependsOn` only |
| Multi-step plan execution with checkpoints | 📋 Planned | No mid-task pause/resume |
| Conductor cost analysis (token spent per task) | 📋 Planned | Per-task budget tracking missing |

**Bottom line:** You can already create tasks, see agents, and track progress. But the "agents autonomously delegate to each other without human oversight" vision isn't fully realized — humans still need to approve strategies and many edge cases need polishing.

## Quick Tour

### 1. Start an agent daemon
```bash
curl -fsSL https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/run-agent.sh \
  | bash -s -- start --daemon --preset fullstack
```

### 2. Create a task (from Claude Code or any MCP client)
```
cortex_task_create(
  title: "Add JWT refresh token rotation",
  description: "...",
  requiredCapabilities: ["backend", "auth"],
  priority: "high"
)
```

### 3. Watch on Dashboard
Navigate to `/conductor` to see:
- Task pipeline with agent assignments
- Live agent cards (online/busy/idle)
- Task detail panel with logs and result

## MCP Tools

| Tool | Purpose |
|------|---------|
| `cortex_task_create` | Create a task, optionally assign to agent or by capabilities |
| `cortex_task_list` | Filter tasks by project, status, assignee |
| `cortex_task_pickup` | Get tasks assigned to current agent |
| `cortex_task_accept` | Accept an assigned task before working |
| `cortex_task_status` | Get full task details with logs |
| `cortex_task_update` | Transition status (in_progress → completed/failed) |
| `cortex_task_submit_strategy` | Propose execution plan for user review (Lead Agent pattern) |

## Known Limitations

1. **No autonomous strategy execution** — every plan needs explicit human approval before agents act
2. **Single-machine reliability not battle-tested** — most testing done with 1-3 agents on local network
3. **Cross-IDE push notifications** work for Claude Code but Codex/Antigravity rely on polling
4. **Capability matching is keyword-based** — no semantic understanding (e.g., "auth" doesn't auto-match "authentication")
5. **No automatic retry strategies** — if an agent fails, you manually re-assign
6. **Conductor doesn't handle conflicts** — if two agents touch the same files concurrently, you resolve manually

## Design Document

Full architecture design at [`docs/architecture/conductor-design.md`](architecture/conductor-design.md). Read this if you want to understand the WebSocket protocol, scope model, and identity resolution strategy.

## When to Use vs When to Wait

**Use Conductor today if:**
- You have 2-4 agents and want a dashboard to coordinate
- You're OK reviewing every strategy before execution
- Your tasks are loosely coupled (can be parallelized without conflict)

**Wait for v1.0 if:**
- You need fully autonomous multi-agent workflows
- You need production reliability for critical paths
- You expect smart auto-recovery from failures
