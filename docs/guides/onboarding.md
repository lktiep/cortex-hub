# Onboarding Guide — Cortex Hub

> Get started with Cortex Hub in under 5 minutes.

---

## How It Works

Cortex Hub connects AI agents through a unified **MCP (Model Context Protocol)** endpoint. Agents authenticate with **Bearer API keys**, and all LLM calls route through CLIProxy (multi-provider gateway with OAuth support).

```
AI Agent → MCP Server (Bearer token) → Dashboard API → Backend Services
                                          ├── Qdrant (vectors)
                                          ├── GitNexus (code intelligence)
                                          ├── mem9 (agent memory)
                                          └── CLIProxy → OpenAI/Gemini/Claude
```

---

## First-Time Setup (Admin)

### 1. Open Cortex Hub Dashboard

Navigate to **https://hub.jackle.dev**

The **Setup Wizard** launches automatically on first visit — configure your LLM provider (OAuth or API key).

### 2. Create Organization & Projects

```
Organization: MyTeam
├── Project: main-app
├── Project: api-service
└── Project: docs
```

### 3. Generate API Keys

Go to **Settings → API Keys → Generate New**:

| Field | Example |
|-------|---------|
| Name | `agent-claude-prod` |
| Scope | Organization: MyTeam |
| Permissions | code.search, memory.store, knowledge.* |
| Expires | 90 days |

Copy the key — it won't be shown again.

---

## Team Member Setup

### 1. Clone & Run Bootstrap

```bash
git clone https://github.com/lktiep/cortex-hub.git
cd cortex-hub
bash scripts/bootstrap.sh
# Select: "2) Member"
```

The script will prompt for:
- **MCP URL** (default: `https://cortex-mcp.jackle.dev/mcp`)
- **API Key** (get from your Hub admin or Dashboard → API Keys)

### 2. Onboard Your AI Agent

```bash
bash scripts/onboard.sh
```

This auto-detects your IDE (Claude Code, Cursor, Windsurf, VS Code) and:
- Injects MCP server config
- Generates `lefthook.yml` (quality gates)
- Creates `.cortex/project-profile.json`
- Sets up post-push webhook

### 3. Verify Connection

```bash
curl -s -X POST 'https://cortex-mcp.jackle.dev/mcp' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_KEY' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | head -100
```

You should see a list of Cortex tools.

### 4. Connect Your Agent Config

For **Claude Code** (`~/.claude/settings.json`):
```json
{
  "mcpServers": {
    "cortex-hub": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://cortex-mcp.jackle.dev/mcp", "--header", "Authorization: Bearer YOUR_KEY"]
    }
  }
}
```

For other tools, `onboard.sh` handles this automatically.

---

## Infrastructure Endpoints

| Service | URL | Port |
|---------|-----|------|
| Dashboard | https://hub.jackle.dev | 3000 |
| API | https://cortex-api.jackle.dev | 4000 |
| MCP Server | https://cortex-mcp.jackle.dev | 8318 |
| LLM Proxy | https://cortex-llm.jackle.dev | 8317 |
| GitNexus (internal) | http://gitnexus:4848 | 4848 |

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `502 Bad Gateway` | Services not started — `docker compose up -d` |
| `401 Unauthorized` | API key invalid or expired — regenerate at Dashboard → API Keys |
| OAuth login fails | Check CLIProxy logs: `docker logs cortex-llm-proxy` |
| MCP tools not available | Verify onboard.sh completed — check agent MCP config |
| Post-push webhook not firing | Set `CORTEX_API_URL` env var, or use default (cortex-api.jackle.dev) |
