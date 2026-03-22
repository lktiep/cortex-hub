# Cortex Hub — Agent Guidelines

> **Current Phase:** 6 (Polish, docs, testing, GA release)
> **Engagement:** Express | **Mode:** Greenfield → Brownfield
> **Last Gate Passed:** Gate 5 (Phase 5→6) on 2026-03-19

---

## Session Protocol (MANDATORY)

### At Session Start — ALWAYS do:

0. **Call `cortex_session_start`** → registers session with Cortex Hub, returns project context
   ```
   cortex_session_start({ repo: "<repo URL>", mode: "development" })
   ```
   Save the returned `sessionId` — needed for session close at end.
1. **Read `STATE.md`** → current task & progress
2. **Read `.cortex/project-profile.json`** → `verify` commands & fingerprint
3. **Run `/onboard`** (only if first session or Hub credentials missing/broken) → sync MCP, rules, and local audit
4. **Acknowledge context:** "Phase X, resuming: [task]. Standards: SOLID, Clean Architecture. Verify: [profile commands]"

### At Session End — ALWAYS do:

1. **Run full verify** from `project-profile.json` → `verify.pre_commit`:
   - `pnpm build` **(FULL build, not --filter)**
   - `pnpm typecheck`
   - `pnpm lint`
2. **Report quality:** `Build ✅/❌ | Typecheck ✅/❌ | Lint ✅/❌`
3. **Update `STATE.md`** with progress, completed tasks, new decisions
4. **Commit** with conventional prefix: `feat:`, `fix:`, `docs:`, `chore:`
5. **Close session** — call `cortex_quality_report` with final gate status

### Before Deploy — ALWAYS do:

Run `verify.full` from `project-profile.json`:
- All `pre_commit` commands + `pnpm test`
- ALL must pass before deploying

---

## Project Context

Cortex Hub is a self-hosted, MCP-compliant platform that unifies code intelligence, persistent memory, shared knowledge, and quality enforcement for AI coding agents. All backend services run in Docker, exposed via Cloudflare Tunnel.

### Tech Stack
- **Monorepo:** pnpm workspaces + Turborepo
- **MCP Gateway:** Cloudflare Worker (Hono)
- **Dashboard API:** Hono + SQLite (Node.js)
- **Dashboard Web:** Next.js 15 + React 19
- **Backend:** Qdrant, mem9, GitNexus (Docker Compose)
- **Infra:** Cloudflare Tunnel, Watchtower

### Endpoints
| Service | URL |
|---------|-----|
| Dashboard | hub.jackle.dev |
| API | cortex-api.jackle.dev |
| MCP | cortex-mcp.jackle.dev |
| LLM Proxy | cortex-llm.jackle.dev |

---

## Routing Rules (Natural Language)

| User Pattern | Mode | Auto-Actions |
|-------------|------|-------------|
| "phase N" / "start phase N" / "bắt đầu phase N" | Phase Build | Read STATE.md → gate check → DEFINE → PLAN → EXECUTE → VERIFY |
| "continue" / "tiếp" / "go" / "tiếp tục" | Resume | Read STATE.md → resume `[/]` task → EXECUTE → VERIFY |
| "add X" / "implement X" / "thêm X" / "làm X" | Feature | Read profile → PLAN → get approval → EXECUTE → VERIFY |
| "fix X" / "sửa X" / "debug X" | Debug | Locate issue → fix → run verify.pre_commit |
| "deploy" / "ship" / "đẩy lên" | Deploy | Run verify.full → deploy from profile → verify live |
| "onboard" / "setup" / "cài đặt" | Setup | Run scripts/onboard.sh or scripts/install-hub.sh |
| "review" / "check" / "kiểm tra" | Review | Run verify.full → check conventions → report |
| ANY other message in cortex-hub workspace | Session Init | `cortex_session_start` → Read STATE.md → acknowledge context → then respond |

---

## Phase Roadmap & Gates

### Completed Phases
- [x] **Phase 1:** Server + Cloudflare Tunnel
- [x] **Phase 2:** Monorepo skeleton + shared packages
- [x] **Phase 3:** Docker stack (Qdrant, CLIProxy, Watchtower)
- [x] **Phase 4:** Hub MCP Server (Cloudflare Worker) — `apps/hub-mcp`
- [x] **Phase 5:** Dashboard Frontend (Next.js) — `apps/dashboard-web`

### Current Phase
- [/] **Phase 6:** Polish, docs, testing, GA release

### Gate Criteria

> ⚠️ **MANDATORY:** Before starting Phase N, Gate N-1→N MUST pass.
> Run `/phase N` or say "start phase N" to trigger automated gate checks.

| Gate | From → To | Required Checks |
|------|-----------|-----------------|
| Gate 1 | Phase 1→2 | Server accessible, Docker installed, Tunnel active |
| Gate 2 | Phase 2→3 | `turbo build` passes, shared packages compile, CI green |
| Gate 3 | Phase 3→4 | All Docker services healthy, CLIProxy API responding on :8317 |
| Gate 4 | Phase 4→5 | MCP tools respond via Worker, auth middleware works, logs written |
| Gate 5 | Phase 5→6 | Dashboard renders, setup wizard works, scoped API keys functional |

---

## Phase Workflow: DEFINE → PLAN → EXECUTE → VERIFY → COMMIT

```
DEFINE   → Read BRD epics + requirements for this phase
PLAN     → Create/update implementation plan, get user approval
EXECUTE  → Write code, follow code-conventions.md
VERIFY   → Run verify commands from project-profile.json
COMMIT   → Conventional commit, update STATE.md
```

---

## Code Conventions

See: [.cortex/code-conventions.md](.cortex/code-conventions.md)

Key rules:
- **camelCase** for variables/functions, **PascalCase** for types/components
- **Path aliases** (`@cortex/*`) — never relative cross-package imports
- **Custom error classes** extending `CortexError`
- **Strict TypeScript** — no `any` without explicit comment
- **Co-located tests** — `foo.ts` → `foo.test.ts`

---

## Quality Gates

Every code session MUST end with verification from `project-profile.json`:

| Step | Command | Source |
|------|---------|--------|
| 1. Full Build | `pnpm build` | `verify.pre_commit[0]` |
| 2. Typecheck | `pnpm typecheck` | `verify.pre_commit[1]` |
| 3. Lint + Prettier | `pnpm lint` | `verify.pre_commit[2]` |
| 4. Test (deploy only) | `pnpm test` | `verify.full[3]` |

### Quality Score (per session)
| Dimension | Weight | Description |
|-----------|--------|-------------|
| Build | 25 | Code compiles, no errors |
| Regression | 25 | No existing tests broken |
| Standards | 25 | Follows code-conventions.md |
| Traceability | 25 | Changes linked to requirements |

---

## Key Documents

| Document | Path |
|----------|------|
| **STATE.md** | `STATE.md` (read FIRST every session) |
| **Project Profile** | `.cortex/project-profile.json` (verify commands) |
| **Code Conventions** | `.cortex/code-conventions.md` |
| Database ERD | `docs/database/erd.md` |
| Agent Quality Strategy | `docs/architecture/agent-quality-strategy.md` |
| Docker Stack | `infra/docker-compose.yml` |

---

## Never Do

- ❌ Start a new phase without passing the gate
- ❌ Skip the PLAN step (always get user approval before major code changes)
- ❌ Use `any` in TypeScript without explicit comment
- ❌ Commit without running verify commands from `project-profile.json`
- ❌ Edit infrastructure (Docker, Tunnel) without updating docs
- ❌ Ignore quality gate failures
- ❌ Hardcode verify commands — always read from `project-profile.json`
