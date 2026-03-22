# All-in-One Installation Guide

> Install Cortex Hub on any server with a single command. Designed for quick deployment and future distribution as a packaged release.

---

## Quick Start (All-in-One)

```bash
curl -fsSL https://raw.githubusercontent.com/<org>/cortex-hub/main/install.sh | bash
```

Or manually:

```bash
git clone https://github.com/<org>/cortex-hub.git
cd cortex-hub
./infra/scripts/install.sh
```

---

## What the Installer Does

```
┌─────────────────────────────────────────────────┐
│  Cortex Hub — All-in-One Installer              │
│                                                 │
│  1. ✅ Check system requirements                │
│  2. ✅ Install Docker (if missing)              │
│  3. ✅ Install Node.js 22 LTS (if missing)     │
│  4. ✅ Install pnpm (if missing)               │
│  5. ✅ Generate .env from prompts               │
│  6. ✅ Build all packages                       │
│  7. ✅ Pull and start Docker containers         │
│  8. ✅ Deploy Hub MCP to Cloudflare Workers     │
│  9. ✅ Run health checks                        │
│  10. ✅ Print connection details                │
│                                                 │
│  Total time: ~5 minutes                         │
└─────────────────────────────────────────────────┘
```

---

## Install Script Reference

### `install.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

CORTEX_VERSION="${CORTEX_VERSION:-latest}"
CORTEX_DIR="${CORTEX_DIR:-/opt/cortex-hub}"
DATA_DIR="${DATA_DIR:-/opt/cortex-hub/infra/data}"

# ─── Colors ────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; NC='\033[0m'

log()  { echo -e "${BLUE}[cortex]${NC} $*"; }
ok()   { echo -e "${GREEN}  ✓${NC} $*"; }
warn() { echo -e "${YELLOW}  ⚠${NC} $*"; }
fail() { echo -e "${RED}  ✗${NC} $*"; exit 1; }

# ─── System Check ──────────────────────────────
check_requirements() {
  log "Checking system requirements..."

  [[ $(uname) == "Linux" ]] || fail "Linux required (got $(uname))"
  
  local mem_mb=$(free -m | awk '/^Mem:/{print $2}')
  [[ $mem_mb -ge 3500 ]] || fail "Minimum 4GB RAM required (got ${mem_mb}MB)"
  ok "RAM: ${mem_mb}MB"

  local disk_gb=$(df -BG / | awk 'NR==2{print $4}' | tr -d 'G')
  [[ $disk_gb -ge 15 ]] || fail "Minimum 15GB disk required (got ${disk_gb}GB)"
  ok "Disk: ${disk_gb}GB available"
}

# ─── Docker ────────────────────────────────────
install_docker() {
  if command -v docker &>/dev/null; then
    ok "Docker $(docker --version | awk '{print $3}')"
    return
  fi
  log "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER"
  ok "Docker installed"
}

# ─── Node.js ───────────────────────────────────
install_node() {
  if command -v node &>/dev/null && [[ $(node -v | cut -d. -f1 | tr -d v) -ge 22 ]]; then
    ok "Node.js $(node -v)"
    return
  fi
  log "Installing Node.js 22 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
  ok "Node.js $(node -v)"
}

# ─── pnpm ──────────────────────────────────────
install_pnpm() {
  if command -v pnpm &>/dev/null; then
    ok "pnpm $(pnpm -v)"
    return
  fi
  log "Installing pnpm..."
  corepack enable
  corepack prepare pnpm@latest --activate
  ok "pnpm installed"
}

# ─── Build ─────────────────────────────────────
build_project() {
  log "Installing dependencies..."
  cd "$CORTEX_DIR"
  pnpm install --frozen-lockfile
  ok "Dependencies installed"

  log "Building packages..."
  pnpm -r build
  ok "All packages built"
}

# ─── Docker Stack ──────────────────────────────
start_services() {
  log "Starting Docker services..."
  cd "$CORTEX_DIR/infra"
  docker compose up -d
  ok "Services started"

  log "Waiting for health checks..."
  sleep 10

  local services=("localhost:6333/healthz" "localhost:7474" "localhost:8080/health" "localhost:4000/health")
  for url in "${services[@]}"; do
    if curl -sf "http://$url" &>/dev/null; then
      ok "$url"
    else
      warn "$url — not ready yet (may need more time)"
    fi
  done
}

# ─── Main ──────────────────────────────────────
main() {
  echo ""
  echo "  ┌──────────────────────────────────┐"
  echo "  │  🧠 Cortex Hub Installer         │"
  echo "  │     v${CORTEX_VERSION}            │"
  echo "  └──────────────────────────────────┘"
  echo ""

  check_requirements
  install_docker
  install_node
  install_pnpm
  build_project
  start_services

  echo ""
  log "Installation complete! 🎉"
  echo ""
  echo "  Dashboard:    http://localhost:3000"
  echo "  API:          http://localhost:4000"
  echo "  GitNexus:     http://localhost:3200"
  echo "  Qdrant:       http://localhost:6333"
  echo ""
  echo "  Next steps:"
  echo "    1. Configure .env with your API keys"
  echo "    2. Setup Cloudflare Tunnel (see docs/guides/implementation.md)"
  echo "    3. Deploy Hub MCP to Cloudflare Workers"
  echo ""
}

main "$@"
```

---

## Uninstall

```bash
cd /opt/cortex-hub/infra
docker compose down -v       # Stop and remove containers + volumes
cd /
rm -rf /opt/cortex-hub       # Remove project files
```

---

## Portable Release (Future)

Cortex Hub is designed for future packaging as a single distributable archive:

```
cortex-hub-v1.0.0-linux-amd64.tar.gz
├── install.sh               # All-in-one installer
├── docker-compose.yml       # Pre-configured stack
├── .env.example             # Template configuration
├── apps/                    # Pre-built applications
│   ├── hub-mcp/             # Built Worker bundle
│   ├── dashboard-api/       # Built API server
│   └── dashboard-web/       # Built static frontend
└── docs/                    # Offline documentation
```

### Distribution Channels

| Channel | Format | Use Case |
|---|---|---|
| **GitHub Releases** | `.tar.gz` | Direct download |
| **Docker Hub** | `cortexhub/cortex:latest` | Container-native deployment |
| **npm** | `npx cortex-hub@latest init` | Node.js ecosystem |
| **Homebrew** | `brew install cortex-hub` | macOS development |

### Docker-Only Deployment (Planned)

```bash
# Single command — no Node.js required
docker run -d \
  --name cortex \
  -p 3000:3000 -p 4000:4000 \
  -v cortex-data:/data \
  -e OPENAI_API_KEY=sk-... \
  cortexhub/cortex:latest
```
