# Cortex Hub — Agent Guidelines

> **Current Phase:** 6 (Polish, docs, testing, GA release)

---

## Session Lifecycle

### Start
1. `cortex_session_start({ repo: "<repo URL>", mode: "development", agentId: "<your id>" })` — save the returned `sessionId`
2. `cortex_knowledge_search` + `cortex_memory_search` — recall what happened last session
3. `cortex_task_pickup()` — check for Conductor tasks assigned to you
4. If `recentChanges.count > 0` → `git pull` before editing


### During Work
Use cortex tools as your primary workflow — they're faster, more focused, and save tokens compared to grep/find.

| What you need | Tool | Why it's better |
|---------------|------|-----------------|
| Find code | `cortex_code_search` | AST-aware, returns focused results (~90% fewer tokens than grep) |
| Understand a symbol | `cortex_code_context` | Shows callers, callees, imports, process participation |
| Check blast radius | `cortex_code_impact` | Know what breaks before you edit |
| Pre-commit risk | `cortex_detect_changes` | Affected symbols + risk rating |
| Graph queries | `cortex_cypher` | Direct Cypher on the knowledge graph |
| Known solutions | `cortex_knowledge_search` | Search before debugging from scratch |
| Past decisions | `cortex_memory_search` | Recall what you or other agents learned |
| Save a fix | `cortex_knowledge_store` | Team-wide — so nobody debugs this twice |
| Save context | `cortex_memory_store` | Personal recall for future sessions |
| Other agents' changes | `cortex_changes` | Check before editing shared files |
| Tool effectiveness | `cortex_tool_stats` | Usage analytics and success rates |

**Start from what you know, not from a fixed ladder:**

| You already know | Start with |
|---|---|
| A symbol name | `cortex_code_context(name)` — exact graph lookup, plus callers/callees/imports in one call |
| Only the behaviour | `cortex_code_search(query, limit: 10)` — ranked hybrid search, one call |
| An exact literal (env var, config key, error string) | `rg` / `grep` — this is not a ranking problem |
| A relationship across files | `cortex_cypher` |

**Search once, read all ten.** Measured on cortex-hub's own index (`benchmarks/retrieval_bench.ts`,
n=15): the target file is in the top 10 for 15/15 queries but at rank 1 for only 8/15. So scan
the whole result set, and never re-run a reworded version of the same query — recall@10 is
already 1.000, so it returns the same set. Ask a different question or switch tool instead.

**Knowledge and memory are for errors and decisions, not for locating code.** Recall them once
at session start, then when something breaks — not before every lookup.

`cortex_code_impact` before editing something exported or shared; `cortex_changes` before
touching a file another agent may hold.

**Bug protocol**: search knowledge/memory first → fix → store non-obvious fixes via `knowledge_store`.

### End
1. Verify: `pnpm build && pnpm typecheck && pnpm lint`
2. `cortex_quality_report` — report gate results
3. `cortex_memory_store` — persist session context (what was done, decisions, next steps)
4. `cortex_session_end(sessionId, summary)` — closes session + auto-saves summary as searchable memory

---

## Project Context

Self-hosted MCP platform: code intelligence, persistent memory, shared knowledge, quality enforcement for AI agents.

### Tech Stack
- **Monorepo:** pnpm + Turborepo
- **MCP Gateway:** Hono (Docker)
- **Dashboard:** Hono API + Next.js 15
- **Backend:** Qdrant, mem9, GitNexus (Docker Compose)
- **Infra:** Cloudflare Tunnel, Watchtower

### Code Conventions
- `camelCase` vars/functions, `PascalCase` types/components
- `@cortex/*` path aliases — never relative cross-package imports
- Strict TypeScript — no `any` without comment
- Conventional commits: `feat:`, `fix:`, `docs:`, `chore:`

### Quality Gates
| Step | Command |
|------|---------|
| Build | `pnpm build` (full, never `--filter`) |
| Typecheck | `pnpm typecheck` |
| Lint | `pnpm lint` |
| Test (deploy only) | `pnpm test` |

### Endpoints
| Service | URL |
|---------|-----|
| Dashboard | http://localhost:3000 |
| API | http://localhost:4000 |
| MCP | http://localhost:8318 |

---

## Phase Roadmap

- [x] Phase 1: Server + Cloudflare Tunnel
- [x] Phase 2: Monorepo skeleton + shared packages
- [x] Phase 3: Docker stack (Qdrant, CLIProxy, Watchtower)
- [x] Phase 4: Hub MCP Server — `apps/hub-mcp`
- [x] Phase 5: Dashboard — `apps/dashboard-web`
- [/] **Phase 6: Polish, docs, testing, GA release**

### Key Documents
| Document | Path |
|----------|------|
| Code Conventions | `.cortex/code-conventions.md` |
| MCP Tool Reference | `docs/api/hub-mcp-reference.md` |
| Architecture Overview | `docs/architecture/overview.md` |
| Docker Stack | `infra/docker-compose.yml` |

---

## Compliance (Automated)

Tool usage is tracked and scored automatically:

1. **Session Compliance Score** — `cortex_session_end` grades your session (A/B/C/D) across 5 categories: Discovery, Safety, Learning, Contribution, Lifecycle
2. **MCP Response Hints** — every tool response includes context-aware hints about what to use next

These work on any MCP client — Claude Code, Antigravity, Cursor, Windsurf, Codex.
