# Implementation Guide

> Step-by-step deployment and configuration guide for Cortex Hub. Each phase includes verification checklists.

---

## Prerequisites

| Requirement | Minimum | Recommended |
|---|---|---|
| **Server** | 2 vCPU, 4GB RAM | 4 vCPU, 8GB RAM |
| **OS** | Ubuntu 22.04 LTS | Ubuntu 24.04 LTS |
| **Docker** | 24.x + Compose v2 | Latest stable |
| **Node.js** | 22 LTS | 22 LTS |
| **Domain** | Any domain with Cloudflare DNS | — |
| **Cloudflare Account** | Free tier | Free tier |

---

## Phase 1: Infrastructure Setup

### 1.1 — Server Access

```bash
# Connect via VPN (if required)
sudo openvpn --config server.ovpn

# SSH into the server
ssh user@<server-ip>

# Verify server resources
cat /proc/cpuinfo | grep "model name" | head -1
free -h
df -h
lsb_release -a
```

**Verification:**
- [ ] SSH login successful
- [ ] ≥ 4GB RAM available
- [ ] ≥ 20GB disk free

### 1.2 — Docker Installation

```bash
# Install Docker Engine
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER

# Install Docker Compose v2
sudo apt-get update && sudo apt-get install -y docker-compose-plugin

# Verify
docker --version          # Expected: Docker version 27.x+
docker compose version    # Expected: Docker Compose version v2.x+
```

**Verification:**
- [ ] `docker run hello-world` succeeds
- [ ] `docker compose version` returns v2.x
- [ ] No `sudo` required for docker commands (re-login if needed)

### 1.3 — Cloudflare Tunnel

```bash
# Install cloudflared
curl -L --output cloudflared.deb \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb

# Authenticate and create tunnel
cloudflared tunnel login
cloudflared tunnel create cortex

# Configure ingress rules
cat > ~/.cloudflared/config.yml << 'EOF'
tunnel: <TUNNEL_ID>
credentials-file: /root/.cloudflared/<TUNNEL_ID>.json

ingress:
  - hostname: cortex-api.yourdomain.com
    service: http://localhost:4000
  - hostname: cortex.yourdomain.com
    service: http://localhost:3000
  - hostname: cortex-gn.yourdomain.com
    service: http://localhost:3200
  - service: http_status:404
EOF

# Run as system service
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

**Verification:**
- [ ] `sudo systemctl status cloudflared` shows active
- [ ] DNS CNAME records created in Cloudflare dashboard
- [ ] `curl https://cortex-api.yourdomain.com/health` returns OK (after API is running)

---

## Phase 2: Repository Setup

### 2.1 — Clone and Initialize

```bash
git clone https://github.com/<org>/cortex-hub.git /opt/cortex-hub
cd /opt/cortex-hub

# Install dependencies
corepack enable
pnpm install

# Verify monorepo
pnpm -r build
```

### 2.2 — Environment Configuration

```bash
cp .env.example .env
```

```env
# .env
NODE_ENV=production

# Cloudflare
CF_ACCOUNT_ID=<your-account-id>
CF_API_TOKEN=<your-api-token>

# OpenAI (for mem9 embeddings)
OPENAI_API_KEY=<your-key>

# Hub MCP Auth
HUB_API_KEY_ANTIGRAVITY=<generated-key>
HUB_API_KEY_GOCLAW=<generated-key>

# Dashboard
DASHBOARD_SECRET=<session-secret>
```

**Verification:**
- [ ] `pnpm -r build` completes with 0 errors
- [ ] `.env` populated with all required values
- [ ] `.env` is in `.gitignore`

---

## Phase 3: Backend Services

### 3.1 — Start Docker Stack

```bash
cd /opt/cortex-hub/infra
docker compose up -d
```

### 3.2 — Index Repositories with GitNexus

```bash
# Clone all project repos
mkdir -p /opt/repos
cd /opt/repos
git clone https://github.com/<org>/project-a.git
git clone https://github.com/<org>/project-b.git

# Index each repo
for repo in /opt/repos/*/; do
  cd "$repo" && npx gitnexus analyze
done

# Start GitNexus server
npx gitnexus serve --port 3200
```

### 3.3 — Service Health Checks

```bash
# Qdrant
curl -s http://localhost:6333/healthz | jq .

# mem9 (runs in-process within Dashboard API)
curl -s http://localhost:8080/health | jq .

# Dashboard API
curl -s http://localhost:4000/health | jq .

# GitNexus
curl -s http://localhost:3200/status | jq .
```

**Verification:**
- [ ] All 5 services return healthy status
- [ ] `docker compose ps` — all containers `running`
- [ ] GitNexus shows indexed repos in `~/.gitnexus/registry.json`

---

## Phase 4: Hub MCP Server Deployment

```bash
cd /opt/cortex-hub/apps/hub-mcp

# Deploy to Cloudflare Workers
npx wrangler deploy

# Set secrets
npx wrangler secret put HUB_API_KEY_ANTIGRAVITY
npx wrangler secret put HUB_API_KEY_GOCLAW
npx wrangler secret put GITNEXUS_URL
npx wrangler secret put MEM9_URL
npx wrangler secret put QDRANT_URL
```

**Verification:**
- [ ] `curl https://hub.yourdomain.com/health` returns OK
- [ ] Auth rejects invalid API key (401)
- [ ] `code.query` proxies to GitNexus successfully

---

## Phase 5: Dashboard Deployment

```bash
cd /opt/cortex-hub/apps/dashboard-web

# Build and deploy to Cloudflare Pages
pnpm build
npx wrangler pages deploy out
```

**Verification:**
- [ ] Dashboard loads at `https://cortex.yourdomain.com`
- [ ] Overview page shows live service metrics
- [ ] Knowledge search returns indexed results

---

## Phase 6: Agent Configuration

### Antigravity (MCP Client)

Add to your MCP server configuration:

```json
{
  "cortex-hub": {
    "url": "https://hub.yourdomain.com/mcp",
    "headers": {
      "Authorization": "Bearer <HUB_API_KEY_ANTIGRAVITY>"
    }
  }
}
```

### GoClaw (MCP Client)

```yaml
# In GoClaw's MCP config
mcp_servers:
  cortex-hub:
    url: https://hub.yourdomain.com/mcp
    api_key: ${HUB_API_KEY_GOCLAW}
```

**Verification:**
- [ ] Antigravity can call `code.query` through Hub MCP
- [ ] GoClaw can call `knowledge.search` through Hub MCP
- [ ] Dashboard shows queries from both agents in real-time

---

## Maintenance

### Auto-Update Script (Cron)

```bash
# /opt/cortex-hub/infra/scripts/auto-update.sh
#!/bin/bash
set -e

cd /opt/repos
for repo in */; do
  cd "$repo"
  git pull --ff-only
  npx gitnexus analyze
  cd ..
done

echo "$(date) — Repos reindexed" >> /var/log/cortex-update.log
```

```bash
# Cron: reindex every 6 hours
crontab -e
# 0 */6 * * * /opt/cortex-hub/infra/scripts/auto-update.sh
```

### Backup

```bash
# /opt/cortex-hub/infra/scripts/backup.sh
#!/bin/bash
BACKUP_DIR="/opt/backups/cortex/$(date +%Y%m%d)"
mkdir -p "$BACKUP_DIR"

# SQLite
cp /opt/cortex-hub/infra/data/sqlite/hub.db "$BACKUP_DIR/"

# Qdrant snapshots
curl -X POST http://localhost:6333/snapshots

echo "$(date) — Backup completed → $BACKUP_DIR"
```
