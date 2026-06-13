# ♊ Gemini Agent Runbook & Reference Guide

This document acts as a persistent memory and configuration guide for any future AI agents (Gemini, Claude, etc.) pair programming on this repository. It documents the self-hosted server setup, deployment pipelines, configuration parameters, and architectural conventions.

---

## 🗺️ Workspace & Repository Configuration

- **Personal Fork Repository**: `https://github.com/DuyPrX/cortex-hub.git`
- **Upstream Repository**: `https://github.com/lktiep/cortex-hub.git`
- **Docker Image Namespace**: `ghcr.io/duyprx` (e.g. `ghcr.io/duyprx/cortex-api:latest`, `ghcr.io/duyprx/cortex-mcp:latest`)

---

## 🖥️ Server Infrastructure & Deployment Details

- **Host IP (Tailscale)**: `100.115.117.31`
- **SSH Username**: `dnxk`
- **Target Directory**: `/home/dnxk/cortex-hub`

### Deploying Updates to Server
To push local changes that have already been pushed to `DuyPrX/cortex-hub` on GitHub:
```bash
# Fetch latest fork commits, stash local config diffs, reset master, pop configs, build and restart containers:
ssh dnxk@100.115.117.31 "cd ~/cortex-hub && git fetch fork && git stash && git reset --hard fork/master && git stash pop && docker compose -f infra/docker-compose.yml build && docker compose -f infra/docker-compose.yml up -d"
```

### Server Services Layout (Port Mapping)

| Service Name | Port (Host) | Internal Port | Notes / Purpose |
| :--- | :--- | :--- | :--- |
| **cortex-api** | `4000` / `3000` | `4000` | Dashboard Web App & Backend Hono API |
| **cortex-mcp** | `8318` | `8317` | WebSocket Agent Conductor & Claude MCP Server |
| **cortex-llm-proxy**| `8317` | `8317` | CLI Proxy API for LLM request routing |
| **cortex-qdrant** | `6333` / `6334` | `6333` / `6334` | Vector Database for memory and knowledge points |
| **cortex-gitnexus** | `4848` | `4848` | Git context indexer and repository sync |

---

## 📁 Critical Files & State Databases

- **Cortex Database (Host)**: Located under `/home/dnxk/cortex-hub/data/cortex.db` (mounted inside the `cortex-api` container to `/app/data/cortex.db`).
- **CLI Proxy Secrets (Host)**: Located under `/home/dnxk/cortex-hub/infra/cliproxy-config.yaml`. The `remote-management.secret-key` is custom-configured per deployment; preserve this diff when performing git updates.

---

## ⚙️ Key Architectural Constraints & Conventions

Future coding agents **MUST** follow these rules to maintain compatibility:

### 1. Zero Namespace Leaks
- Never hardcode the domain `jackle.dev` or user namespaces `jackle` / `lktiep`.
- Use dynamic hostname resolving (e.g. `getExternalUrl` in `apps/dashboard-web/src/lib/config.ts`) that adapts to local localhost or Tailscale connections.
- Ensure all container images point to `ghcr.io/duyprx/cortex-...`.

### 2. Timezone-Suffix & ISO Dates
- All date-times written to SQLite databases should be ISO-8601 UTC strings (`YYYY-MM-DDTHH:MM:SSZ`).
- When parsing stored dates in JavaScript, verify if the suffix `Z` is already present before appending it (to avoid double timezone indicators like `ZZ` which fail to parse in JavaScript's `new Date()`).

### 3. Project ID Normalization
- The knowledge-base indexing system uses the project's **UUID** (`project.id`) from the database rather than the slug format. Keep `normalizeProjectId` inside `apps/dashboard-api/src/routes/knowledge.ts` updated to always query and return the project's primary UUID key.

### 4. Layout Flexibility Breakpoints
- Maintain the breakpoint for column grid stacking at **`1280px`** (rather than 1024px) to ensure proper vertical formatting on portrait displays (e.g. `1080x1920` monitors).
- Keep content containers at `max-width: 100%` on widescreen viewports to optimize layout usage on high-resolution displays (e.g. `2560x1600` monitors).

### 5. Single-Model Embedding Configuration
- Never configure fallback routing chains for embedding models. Because different embedding models use different vector spaces and dimensions (e.g., 384 vs. 768 vs. 1536), switching models dynamically will cause database index insertion/query crashes or corrupt search results. Enforce single-model selection for embedding.

### 6. Flexbox Scrollbar Prevention
- Always ensure `.main` and `.content` flex containers in layout styling (e.g., `DashboardLayout.module.css`) include `min-width: 0`. Without `min-width: 0`, standard browser flexbox calculation defaults to `min-width: auto`, allowing long continuous strings or tables to stretch the main area and create page-level horizontal scrollbars.

### 7. In-Memory Auth Caching
- `hub-mcp` implements an in-memory validation cache (TTL: 2 minutes) for Bearer tokens in [auth.ts](file:///E:/Code/cortex-hub/apps/hub-mcp/src/middleware/auth.ts) to eliminate database roundtrips on consecutive tool calls. Keep this in mind when developing or editing MCP authorization flows.

### 8. Database Performance & Table Indexes
- Always ensure database tables that accumulate high volume (like `query_logs` and `usage_logs`) have proper indexes on filtering columns (`agent_id`, `created_at`, `project_id`, `key_hash`). Unindexed lookups inside request filters will block SQLite and trigger connection timeouts.

### 9. Docker Build DNS / IPv6 Enforcement
- Docker builds on the remote host fail to resolve package registries over IPv6. In `Dockerfile` stages, set `ENV NODE_OPTIONS="--dns-result-order=ipv4first"` to force IPv4 DNS queries during dependency installations.

---

## 🩺 Diagnostic Commands

```bash
# Check service health
ssh dnxk@100.115.117.31 "curl -s http://localhost:4000/health"

# View live docker container logs
ssh dnxk@100.115.117.31 "cd ~/cortex-hub && docker compose -f infra/docker-compose.yml logs -f cortex-api"
```
