<p align="center">
  <img src="docs/assets/logo-placeholder.svg" alt="Cortex Hub" width="120" />
</p>

<h1 align="center">Cortex Hub</h1>

<p align="center">
  <strong>The Neural Intelligence Platform for AI Agent Orchestration</strong>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#features">Features</a> •
  <a href="#installation">Installation</a> •
  <a href="#documentation">Documentation</a> •
  <a href="#contributing">Contributing</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License" />
  <img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg" alt="Node" />
  <img src="https://img.shields.io/badge/pnpm-9.x-orange.svg" alt="pnpm" />
  <img src="https://img.shields.io/badge/docker-24%2B-blue.svg" alt="Docker" />
  <img src="https://img.shields.io/badge/status-in%20development-yellow.svg" alt="Status" />
</p>

---

## What is Cortex Hub?

**Cortex** is a self-hosted platform that connects multiple AI coding agents through a unified **MCP (Model Context Protocol)** interface. It provides shared code intelligence, persistent memory, a collaborative knowledge base, quality enforcement, and cross-agent session continuity.

Think of it as **the brain that connects all your AI assistants** — they share knowledge, remember decisions, understand your codebase at a deep level, and hand off work to each other seamlessly.

### Key Capabilities

| Capability | Description |
|---|---|
| 🧠 **Code Intelligence** | AST-aware search, symbol context, impact analysis across all your repos |
| 💾 **Persistent Memory** | Agents remember decisions and context across sessions |
| 📚 **Shared Knowledge** | Agents contribute and consume a shared, searchable knowledge base |
| 🛡️ **Quality Gates** | Automated scoring and enforcement after every work session |
| 🔄 **Session Handoff** | One agent picks up where another left off — zero context loss |
| 🔌 **Universal MCP** | Single endpoint for any MCP-compatible client |

---

## Architecture

```
                    ┌──────────────────────────┐
                    │      AI Agents           │
                    │  ┌─────┐ ┌─────┐ ┌─────┐ │
                    │  │ AG  │ │ GC  │ │ N   │ │
                    │  └──┬──┘ └──┬──┘ └──┬──┘ │
                    └─────┼───────┼───────┼────┘
                          │       │       │
                          ▼       ▼       ▼
               ┌──────────────────────────────────┐
               │   Hub MCP Server                  │
               │   Cloudflare Worker               │
               │                                   │
               │   🔐 Auth  →  🔀 Router           │
               │   📋 Logger → 🛡️ Policy           │
               │                                   │
               │   code.*  memory.*  knowledge.*   │
               │   quality.*  session.*            │
               └──────────┬───────────────────────┘
                          │
            ┌─────────────┼─────────────┐
            ▼             ▼             ▼
     ┌────────────┐ ┌──────────┐ ┌──────────┐
     │  GitNexus  │ │   mem0   │ │  Qdrant  │
     │  Code      │ │  Memory  │ │  Vectors │
     │  Graph     │ │  + Neo4j │ │          │
     └────────────┘ └──────────┘ └──────────┘
            │
     ┌──────┴──────┐
     │  All Repos  │
     │  Indexed    │
     └─────────────┘
```

> **Full architecture docs:** [`docs/architecture/overview.md`](docs/architecture/overview.md)

---

## Features

### 🧠 Code Intelligence (via GitNexus)

- **Semantic code search** — natural language queries against your entire codebase
- **360° symbol context** — every caller, callee, import, and process for any symbol
- **Blast radius analysis** — see exactly what breaks before you change anything
- **Execution flow tracing** — follow code paths across files and modules
- **Multi-repo support** — all repositories indexed in a single knowledge graph

### 💾 Agent Memory (via mem0)

- **Cross-session memory** — agents remember past decisions, patterns, and context
- **Semantic recall** — search memories by meaning, not just keywords
- **Per-agent isolation** — each agent has private memory with optional shared spaces
- **Graph relationships** — Neo4j tracks connections between memories

### 📚 Knowledge Base (via Qdrant)

- **Auto-contribution** — agents contribute discovered patterns during work
- **Human curation** — weekly review cycle for quality control
- **Cross-project sharing** — "how to deploy to Cloudflare" is useful everywhere
- **Domain tagging** — organized by technology domain and project

### 🛡️ Quality Gates

Inspired by [Forgewright](https://github.com/buiphucminhtam/forgewright-agents)'s quality framework:

- **4-dimension scoring** — Build (25) + Regression (25) + Standards (25) + Traceability (25)
- **Grade system** — A through F, with configurable thresholds
- **Trend tracking** — see quality score over time per project
- **Policy enforcement** — code reuse gate, incremental change guard, test coverage gate

### 🔄 Session Handoff

- **Structured context** — files changed, decisions made, blockers encountered
- **Priority queue** — pick up the most important pending work first
- **Agent-specific or open** — target a specific agent or let anyone claim it
- **Auto-expiry** — handoffs expire after 7 days to prevent stale work

### 📊 Dashboard

- **Real-time monitoring** — service health, query logs, active sessions
- **Knowledge management** — search, approve, reject contributed items
- **Quality trends** — line charts showing score progression
- **Dependency checker** — track third-party service versions and updates

---

## Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| **Gateway** | Cloudflare Workers | Hub MCP Server (edge-deployed) |
| **Code Intel** | GitNexus | AST parsing + knowledge graph |
| **Memory** | mem0 + Neo4j | Long-term agent memory |
| **Vectors** | Qdrant | Semantic search engine |
| **App DB** | SQLite (WAL) | Quality reports, query logs, sessions |
| **API** | Hono | Dashboard backend |
| **Frontend** | Next.js 15 | Dashboard web interface |
| **Infra** | Docker Compose | Service orchestration |
| **Tunnel** | Cloudflare Tunnel | Secure exposure, zero open ports |
| **CI/CD** | GitHub Actions | Automated testing and deployment |
| **Monorepo** | pnpm + Turborepo | Build orchestration |

> **Full stack details:** [`docs/architecture/tech-stack.md`](docs/architecture/tech-stack.md)

---

## Quick Start

### Prerequisites

- Docker 24+ with Compose v2
- Node.js 22 LTS
- pnpm 9.x
- A Cloudflare account (free tier)

### One-Command Install

```bash
curl -fsSL https://raw.githubusercontent.com/lktiep/cortex-hub/master/install.sh | bash
```

### Manual Setup

```bash
# 1. Clone
git clone https://github.com/<org>/cortex-hub.git
cd cortex-hub

# 2. Install dependencies
corepack enable
pnpm install

# 3. Configure environment
cp .env.example .env
# Edit .env with your API keys

# 4. Start backend services
cd infra && docker compose up -d

# 5. Build and start
pnpm -r build
pnpm dev
```

### Verify Installation

```bash
# All services healthy?
curl http://localhost:4000/health     # Dashboard API
curl http://localhost:6333/healthz    # Qdrant
curl http://localhost:3200/status     # GitNexus
```

> **Full installation guide:** [`docs/guides/installation.md`](docs/guides/installation.md)

---

## Installation

### Development (Local)

```bash
git clone https://github.com/<org>/cortex-hub.git
cd cortex-hub
pnpm install
pnpm dev
```

### Production (Self-Hosted Server)

See the complete [Implementation Guide](docs/guides/implementation.md) for:
1. Server provisioning and Docker setup
2. Cloudflare Tunnel configuration
3. Service deployment and health checks
4. Agent connection configuration

### Docker-Only (Planned)

```bash
docker run -d \
  --name cortex \
  -p 3000:3000 -p 4000:4000 \
  -v cortex-data:/data \
  -e OPENAI_API_KEY=sk-... \
  cortexhub/cortex:latest
```

### Package Manager (Planned)

```bash
# npm
npx cortex-hub@latest init

# Homebrew
brew install cortex-hub
```

---

## Project Structure

```
cortex-hub/
├── packages/                    # Shared libraries
│   ├── shared-types/            #   TypeScript type definitions
│   ├── shared-utils/            #   Common utility functions
│   └── ui-components/           #   Shared React components
├── apps/
│   ├── hub-mcp/                 # Hub MCP Server (Cloudflare Worker)
│   ├── dashboard-api/           # Dashboard Backend (Hono + SQLite)
│   └── dashboard-web/           # Dashboard Frontend (Next.js 15)
├── infra/                       # Docker Compose + scripts
├── docs/                        # Documentation
└── .github/workflows/           # CI/CD
```

> **Full structure breakdown:** [`docs/architecture/monorepo-structure.md`](docs/architecture/monorepo-structure.md)

---

## Documentation

| Document | Description |
|---|---|
| [`docs/architecture/overview.md`](docs/architecture/overview.md) | System architecture and component diagram |
| [`docs/architecture/monorepo-structure.md`](docs/architecture/monorepo-structure.md) | Detailed directory layout and package graph |
| [`docs/architecture/tech-stack.md`](docs/architecture/tech-stack.md) | Technology choices with versions and licenses |
| [`docs/guides/implementation.md`](docs/guides/implementation.md) | Step-by-step deployment guide |
| [`docs/guides/installation.md`](docs/guides/installation.md) | All-in-one installer and packaging |
| [`docs/api/hub-mcp-reference.md`](docs/api/hub-mcp-reference.md) | Complete MCP tool API reference |
| [`docs/api/database-schema.md`](docs/api/database-schema.md) | Database schema definitions |
| [`docs/policies/ai-policies.md`](docs/policies/ai-policies.md) | Quality gates and AI policy enforcement |
| [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md) | Contributing guidelines |

---

## Roadmap

| Phase | Scope | Timeline |
|---|---|---|
| **Phase 1: Foundation** | Infrastructure, monorepo, Docker stack | Weeks 1-2 |
| **Phase 2: Integration** | Hub MCP Server, agent connections | Weeks 3-4 |
| **Phase 3: Intelligence** | Semantic search, quality trending, auto-contribution | Weeks 5-6 |
| **Phase 4: Evolution** | Auto-skill generation, multi-branch indexing, agent metrics | Weeks 7+ |

### Planned Features

- [ ] AI-powered code review on pull requests
- [ ] Interactive knowledge graph visualization
- [ ] Agent performance leaderboard
- [ ] Slack/Discord alert integrations
- [ ] Mobile-responsive PWA dashboard
- [ ] Plugin marketplace for community skills

---

## Cost

Cortex is designed to run almost entirely on free tiers:

| Component | Cost |
|---|---|
| Self-hosted server | Your existing infrastructure |
| Cloudflare Workers | Free (100K req/day) |
| Cloudflare Pages | Free |
| Cloudflare Tunnel | Free |
| OpenAI (embeddings) | ~$0.05/month |
| **Total** | **≈ $0.05/month** |

---

## Contributing

We welcome contributions! See our [Contributing Guide](docs/CONTRIBUTING.md) for:
- Development setup
- Branch strategy and commit conventions
- Code standards and review process
- Knowledge contribution guidelines

---

## License

MIT © Cortex Hub Contributors
