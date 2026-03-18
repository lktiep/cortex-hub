# Cortex Hub — Agent Guidelines

> **Current Phase:** 4 (Hub MCP Server) ✅ — Ready for Phase 5
> **Engagement:** Express | **Mode:** Greenfield
> **Last Gate Passed:** Gate 3 (Phase 3→4) on 2026-03-18

---

## Project Context

Cortex Hub is a self-hosted, MCP-compliant platform that unifies code intelligence, persistent memory, shared knowledge, and quality enforcement for AI coding agents. All backend services run in Docker, exposed via Cloudflare Tunnel.

### Tech Stack
- **Monorepo:** pnpm workspaces + Turborepo
- **MCP Gateway:** Cloudflare Worker (Hono)
- **Dashboard API:** Hono + SQLite (Node.js)
- **Dashboard Web:** Next.js 15 + React 19
- **Backend:** Qdrant, Neo4j, mem0, CLIProxy (Docker Compose)
- **Infra:** Cloudflare Tunnel, Watchtower

### Endpoints
| Service | URL | 
|---------|-----|
| Dashboard | hub.jackle.dev |
| API | api.hub.jackle.dev |
| MCP | mcp.hub.jackle.dev |
| LLM Proxy | llm.hub.jackle.dev |

---

## Phase Roadmap & Gates

### Completed Phases
- [x] **Phase 1:** Server + Cloudflare Tunnel
- [x] **Phase 2:** Monorepo skeleton + shared packages
- [x] **Phase 3:** Docker stack (Qdrant, Neo4j, mem0, CLIProxy, Watchtower)
- [x] **Phase 4:** Hub MCP Server (Cloudflare Worker) — `apps/hub-mcp`

### Upcoming Phases
- [ ] **Phase 5:** Dashboard Frontend (Next.js) — `apps/dashboard-web`
- [ ] **Phase 6:** Polish, docs, testing, GA release

### Gate Criteria

> ⚠️ **MANDATORY:** Before starting Phase N, Gate N-1→N MUST pass.
> Run `/phase N` to trigger automated gate checks.

| Gate | From → To | Required Checks |
|------|-----------|-----------------|
| Gate 1 | Phase 1→2 | Server accessible, Docker installed, Tunnel active |
| Gate 2 | Phase 2→3 | `turbo build` passes, shared packages compile, CI green |
| Gate 3 | Phase 3→4 | All Docker services healthy, CLIProxy API responding on :8317 |
| Gate 4 | Phase 4→5 | MCP tools respond via Worker, auth middleware works, logs written |
| Gate 5 | Phase 5→6 | Dashboard renders, setup wizard works, scoped API keys functional |

See: [Gate Definitions](Antigravity-Production-Grade-Suite/.protocols/gate-definitions.md)

---

## Forgewright Pipeline

When starting ANY phase, follow the **DEFINE → PLAN → EXECUTE → VERIFY → COMMIT** workflow:

```
DEFINE   → Read BRD epics + requirements for this phase
PLAN     → Create/update implementation plan, get user approval
EXECUTE  → Write code, follow code-conventions.md
VERIFY   → Run tests, health checks, validate acceptance criteria
COMMIT   → Commit with conventional prefix, update task.md
```

See: [Phase Workflow](Antigravity-Production-Grade-Suite/.protocols/phase-workflow.md)

### Routing Rules

| User Says | Mode | What To Do |
|-----------|------|------------|
| "Start Phase N" / `/phase N` | Full Build | Check gate → DEFINE → PLAN → EXECUTE → VERIFY |
| "Add [feature]..." | Feature | BA check → Architect → Implement → Test |
| "Debug this / fix bug" | Debug | GitNexus impact → Fix → Verify |
| "Review my code" | Review | Code review against conventions |
| "Deploy / ship" | Ship | Run tests → Build → Deploy → Verify |
| "Optimize performance" | Optimize | Profile → Identify → Fix → Benchmark |

---

## Code Conventions

See: [.forgewright/code-conventions.md](.forgewright/code-conventions.md)

Key rules:
- **camelCase** for variables/functions, **PascalCase** for types/components
- **Path aliases** (`@cortex/*`) — never relative cross-package imports
- **Custom error classes** extending `CortexError`
- **Strict TypeScript** — no `any` without explicit comment
- **Co-located tests** — `foo.ts` → `foo.test.ts`

---

## Quality Gates

Every code session MUST end with:
1. ✅ Build passes (`turbo build`)
2. ✅ Tests pass (`turbo test`)
3. ✅ Lint clean (`turbo lint`)
4. ✅ No HIGH/CRITICAL impact warnings ignored
5. ✅ `task.md` updated with progress

### Quality Score (per session)
| Dimension | Weight | Description |
|-----------|--------|-------------|
| Build | 25 | Code compiles, no errors |
| Regression | 25 | No existing tests broken |
| Standards | 25 | Follows code-conventions.md |
| Traceability | 25 | Changes linked to requirements (R001–R013) |

---

## Key Documents

| Document | Path |
|----------|------|
| BRD | `Antigravity-Production-Grade-Suite/product-manager/BRD/brd.md` |
| Requirements Register | `Antigravity-Production-Grade-Suite/business-analyst/elicitation/requirements-register.md` |
| Feasibility Assessment | `Antigravity-Production-Grade-Suite/business-analyst/evaluation/feasibility-assessment.md` |
| BA Handoff Package | `Antigravity-Production-Grade-Suite/business-analyst/handoff/ba-package.md` |
| Architecture Decisions | `Antigravity-Production-Grade-Suite/solution-architect/analysis/architecture-decisions.md` |
| Gate Definitions | `Antigravity-Production-Grade-Suite/.protocols/gate-definitions.md` |
| Phase Workflow | `Antigravity-Production-Grade-Suite/.protocols/phase-workflow.md` |
| Code Conventions | `.forgewright/code-conventions.md` |
| Project Profile | `.forgewright/project-profile.json` |
| Docker Stack | `infra/docker-compose.yml` |
| Onboarding Guide | `docs/guides/onboarding.md` |

---

## Never Do

- ❌ Start a new phase without passing the gate
- ❌ Skip the PLAN step (always get user approval before major code changes)
- ❌ Use `any` in TypeScript without explicit comment
- ❌ Commit without running `turbo build && turbo test`
- ❌ Edit infrastructure (Docker, Tunnel) without updating docs
- ❌ Ignore quality gate failures
