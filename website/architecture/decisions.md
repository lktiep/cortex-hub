# Design decisions

The first five architecture decision records were written in March 2026, before most of the
current code. They are in
[`docs/architecture/architecture-decision-records/ADR-001-to-005.md`](https://github.com/lktiep/cortex-hub/blob/master/docs/architecture/architecture-decision-records/ADR-001-to-005.md).
This page gives each decision and where the code has since moved on.

| ADR | Decision | Today |
|---|---|---|
| 001 Modular monorepo | pnpm workspaces and Turborepo; `hub-mcp`, `dashboard-api`, `dashboard-web` as apps | Holds. The worker, the VS Code extension and the benchmarks joined it. The dashboard is not on Cloudflare Pages as planned: `cortex-api` serves it |
| 002 MCP, REST and WebSocket | MCP for agents, REST for the dashboard, WebSocket for live updates, no message broker | Holds. The REST routes live under `/api/*`. The WebSocket also carries Conductor: workers and extension windows connect to `/ws/conductor` |
| 003 SQLite, vectors and a graph | SQLite (WAL) for app data, Qdrant for vectors, GitNexus for the code index | Holds. Code search is now hybrid: vector and BM25 fused in Qdrant |
| 004 API keys and OAuth | API keys for agents; GitHub OAuth login for the dashboard | API keys hold. The dashboard login was not built: the dashboard has no login, and `API_AUTH` with an access proxy guards the API instead |
| 005 Single tenant | One database and one collection; agents told apart by `agent_id` | Superseded. Projects belong to organizations, keys are scoped to them, cross-repo search stays inside one organization, and each project's code vectors have their own Qdrant collection |

## Decisions made since, as the code shows them

- **Hooks enforce the workflow, on evidence.** A marker counts only if a tool call wrote it, and a
  write after the gates clears them. See [Hooks](../reference/hooks).
- **Hybrid code search.** It was the only option that moved rank-1 accuracy on the repo's own
  benchmark; an LLM reranker did not. See [Benchmarks](./benchmarks).
- **Notices ride on tool results.** The lead hears about reviews, gates and escalations in the
  result of its next hub call, not by polling. See [Review](../conductor/review).
- **Workers push their work.** A worker that runs out of quota or is stopped commits and pushes
  what it has, so the next attempt continues from it. See [Run a worker](../conductor/workers).
- **CI owns the version number.** Every merge to `master` claims a patch version; a stable release
  runs the same workflow. See [Scripts](../reference/scripts#release).

The Conductor design is in
[`docs/architecture/conductor-design.md`](https://github.com/lktiep/cortex-hub/blob/master/docs/architecture/conductor-design.md),
and the current state in
[`docs/conductor.md`](https://github.com/lktiep/cortex-hub/blob/master/docs/conductor.md). The
design document predates the TypeScript worker; read the second one first.
