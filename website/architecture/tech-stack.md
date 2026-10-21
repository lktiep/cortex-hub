# Tech stack

Taken from the `package.json` files and `infra/` on `master`.

## Monorepo

| | |
|---|---|
| Package manager | pnpm 10 (`packageManager: pnpm@10.32.1`) |
| Build | Turborepo 2 |
| Language | TypeScript 5.7, strict |
| Runtime | Node.js 22 or newer for the hub; the worker runs on Node 20 or newer |
| Tests | Vitest |
| Path aliases | `@cortex/*` |

```
apps/
  hub-mcp/            MCP gateway
  dashboard-api/      API, Conductor, LLM gateway
  dashboard-web/      dashboard
  conductor-worker/   worker and the cw CLI
  cortex-extension/   VS Code extension (cortex-agent)
packages/
  shared-types/  shared-utils/  shared-mem9/
mods/cortex-bar/      Claude Code mod
benchmarks/           retrieval benchmarks (@cortex/benchmarks)
infra/                Docker Compose, Dockerfiles
scripts/              installers, worker bootstrap, release
website/              this site (VitePress)
```

## Apps

| App | Main dependencies |
|---|---|
| `hub-mcp` | Hono 4, `@hono/node-server`, `@modelcontextprotocol/sdk` 1.x, Zod 4, `ws` |
| `dashboard-api` | Hono 4, `better-sqlite3` 11, `ws`, `@cortex/shared-mem9` |
| `dashboard-web` | Next.js 15, React 19, SWR, `react-markdown`, `lucide-react` |
| `conductor-worker` | No runtime dependencies; bundled with esbuild into one file, `cortex-worker.mjs`. Uses `ws` and `smol-toml` |
| `cortex-extension` | `antigravity-sdk`, `ws`; VS Code 1.85 or newer |

## Data and services

| | |
|---|---|
| Relational store | SQLite (`better-sqlite3`) in the `api-data` volume |
| Vectors | Qdrant 1.13 |
| Code graph | GitNexus, in the `cortex-gitnexus` image |
| Embeddings | Ollama 0.34 with `all-minilm` (384 dimensions) by default, through the hub's LLM gateway |
| Chat models | Whatever is routed under LLM Providers: API-key providers, or subscriptions through CLIProxyAPI |
| Images | `node:22-slim` builds, published to `ghcr.io/lktiep` |
| Deployment | Docker Compose; Watchtower for updates |

## Docs site

VitePress 1.6, in `website/`, outside the pnpm workspace. GitHub Pages builds it on every push to
`master` that changes `website/`.

```bash
cd website
pnpm install --ignore-workspace
pnpm dev
```
