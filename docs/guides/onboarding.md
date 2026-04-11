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

## Quick Start (Recommended)

### 1. Global Install (one time per machine)

```bash
# From cortex-hub repo
bash scripts/install.sh

# Or via curl (no clone needed)
curl -fsSL https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/install.sh | bash
```

This installs:
- `/install` slash command globally (works in any project)
- MCP config in `~/.claude.json` (reads API key from `HUB_API_KEY` env or `.env` file)

### 2. Per-Project Setup

Navigate to any project and type `/install` inside Claude Code. That's it.

Or run directly:
```bash
# macOS / Linux
bash scripts/install.sh

# Windows PowerShell
.\scripts\install.ps1

# Specific IDEs only
bash scripts/install.sh --tools claude,gemini,cursor
```

The setup script is **idempotent** — safe to run multiple times. It:
- Auto-detects installed IDEs (Claude, Gemini, Cursor, Windsurf, VS Code, Codex)
- Configures MCP for each detected IDE
- Generates `.cortex/project-profile.json` (build/lint/test commands)
- Installs enforcement hooks (Claude Code + Gemini CLI)
- Creates instruction files (`.cursorrules`, `.windsurfrules`, etc.)
- Sets up `lefthook.yml` (git pre-commit/pre-push hooks)
- Injects cortex integration into `CLAUDE.md`

### 3. Auto-Update

The hooks system is version-tracked (`.cortex/.hooks-version`). When a new version is released, running `/install` or `install.sh` will automatically detect the outdated version and regenerate hooks.

```bash
# Check current status without making changes
bash scripts/install.sh --check

# Force regenerate everything
bash scripts/install.sh --force
```

---

## Setup Scripts Reference

| Script | Purpose | When to Use |
|--------|---------|-------------|
| `install.sh` | **Unified installer** — global skill + MCP + project hooks + IDE setup | Everything. Use this. |
| `install.ps1` | Windows PowerShell equivalent | Windows users |
| `onboard.sh` | Full interactive onboarding (legacy) | First-time guided setup with prompts |
| `onboard.ps1` | Windows interactive onboarding (legacy) | First-time on Windows with prompts |

### Relationship: `install.sh` vs `onboard.sh`

- **`install.sh`** — The unified installer. One script does everything: global `/install` skill, MCP config, project hooks, IDE detection, auto-update. Idempotent and non-interactive (reads API key from env/`.env` file).
- **`onboard.sh`** — Legacy interactive onboarding. Prompts for API key, MCP URL, tool selection. Use if you prefer a guided step-by-step setup.

---

## IDE Enforcement Matrix

| IDE | Runtime Hooks | Instruction File | MCP Config |
|-----|:---:|:---:|:---:|
| Claude Code | 5 hooks (.claude/hooks/) | CLAUDE.md | ~/.claude.json |
| Gemini CLI | 5 hooks (.gemini/hooks/) | AGENTS.md | ~/.gemini/antigravity/mcp_config.json |
| Cursor | instruction-only | .cursorrules | ~/.cursor/mcp.json |
| Windsurf | instruction-only | .windsurfrules | ~/.codeium/windsurf/mcp_config.json |
| VS Code | instruction-only | .vscode/copilot-instructions.md | .vscode/mcp.json |
| OpenAI Codex | instruction-only | .codex/instructions.md | ~/.codex/config.toml |

**Runtime hooks** = automated enforcement (blocks edits without session, blocks commits without quality gates).
**Instruction-only** = guidance via markdown files (no automated blocking, relies on agent compliance + server-side scoring).

---

## Supported Project Types

`install.sh` auto-detects **all** stacks present in the repo and generates smart, glob-filtered pipelines. Each pipeline only runs when files matching its pattern are changed.

### Single-Stack Projects

| Stack | Detected by | Pre-commit | Pre-push | Glob filter |
|-------|-------------|------------|----------|-------------|
| **Node.js** (pnpm/npm/yarn) | `package.json` | build, typecheck, lint | + test | `**/*.{ts,tsx,js,jsx,json,css,scss}` |
| **Go** | `go.mod` | build, vet | + test | `**/*.go` |
| **Rust** | `Cargo.toml` | build, clippy | + test | `**/*.rs` |
| **Python** | `requirements.txt`, `pyproject.toml`, `setup.py`, `Pipfile` | py_compile | + pytest | `**/*.py` |
| **.NET** | `*.csproj`, `*.sln` (root) | dotnet build | + test | `**/*.{cs,csproj,sln}` |
| **.NET** (subdirectory) | `*.sln` (depth 2) | dotnet build path/to.sln | + test | `path/**/*.{cs,csproj,sln}` |
| **Godot** | `project.godot` (depth 2) | info message | — | `path/**/*.{gd,tscn,tres}` |
| **Python scripts** (no manifest) | `*.py` files exist but no `requirements.txt` etc. | py_compile {staged_files} | — | `**/*.py` |

### Mixed / Monorepo Projects

For repos with multiple stacks (e.g., a C# server + Python tools + Godot client), `install.sh` detects **all** stacks and generates a combined `lefthook.yml`:

```yaml
# Example: multi-lang project (Python + .NET + Godot)
pre-commit:
  parallel: true
  commands:
    python_check:
      glob: "**/*.py"                                    # only when .py changes
      run: python3 -m py_compile {staged_files}
    dotnet_build:
      glob: "server/**/*.{cs,csproj,sln}"                # only when .cs changes
      run: dotnet build ./server/MyProject.sln
    godot_check:
      glob: "godot-client/**/*.{gd,tscn,tres}"          # only when .gd changes
      run: echo 'Godot files changed — verify in editor'
```

**Key behavior:**
- Commit a `.md` file → **no pipeline runs** (no matching glob)
- Commit a `.py` file → only Python check runs
- Commit `.py` + `.cs` files → both Python and .NET run **in parallel**
- Each stack is independent — a failing .NET build does not block a Python-only commit

### Custom Quality Gates

For projects not auto-detected, edit `.cortex/project-profile.json` manually:

```json
{
  "schema_version": "2.0",
  "fingerprint": {
    "stacks": ["custom"],
    "package_manager": "custom"
  },
  "verify": {
    "pre_commit": ["make lint", "make build"],
    "full": ["make lint", "make build", "make test"]
  }
}
```

Then run `/install --force` to regenerate `lefthook.yml`.

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

## Manual Setup (Alternative)

If you prefer manual setup over `/install`:

### 1. Clone & Run Bootstrap

```bash
git clone https://github.com/lktiep/cortex-hub.git
cd cortex-hub
bash scripts/bootstrap.sh
# Select: "2) Member"
```

### 2. Full Interactive Onboarding

```bash
bash scripts/install.sh          # macOS/Linux
.\scripts\onboard.ps1            # Windows
```

### 3. Verify Connection

```bash
curl -s -X POST 'https://cortex-mcp.jackle.dev/mcp' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_KEY' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | head -100
```

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
| MCP tools not available | Run `/install` or `bash scripts/install.sh --force` |
| Hooks not enforcing | Check `.cortex/.hooks-version` — run `/install` to update |
| Post-push webhook not firing | Set `CORTEX_API_URL` env var, or use default (cortex-api.jackle.dev) |
| Windows hooks not working | Use `.\scripts\install.ps1` to generate PS1 hooks |
| `/install` not found | Run `bash scripts/install.sh` from cortex-hub repo first |
