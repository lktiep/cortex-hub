# Multi-IDE

Every agent reaches the hub through the same MCP endpoint, `https://<your-mcp-host>/mcp`, with an
API key as a bearer token. What differs between IDEs is the config file and how much of the
workflow can be enforced.

## What the installer sets up

| IDE | MCP config | Workflow |
|---|---|---|
| Claude Code | `~/.claude.json` | 8 hooks in `.claude/settings.json`, `/cs` and `/ce`, a Cortex section in `CLAUDE.md` |
| Gemini / Antigravity | `~/.gemini/antigravity/mcp_config.json` | 5 hooks in `.gemini/hooks/` and `.gemini/settings.json` |
| Cursor | `~/.cursor/mcp.json` | `.cursorrules` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `.windsurfrules` |
| VS Code (Copilot) | `.vscode/mcp.json` | `.vscode/copilot-instructions.md` |
| Codex | not written; see below | `.codex/instructions.md` |

Rules files are kept between `<!-- cortex-hub:auto-mcp -->` markers, so running the installer
again updates its section and leaves the rest of the file alone. Hooks block; rules files only
ask. Only Claude Code and Gemini enforce the workflow. See the [installer reference](../reference/installer).

## Writing the entry yourself

The forms below come from [`docs/conductor/setup.md`](https://github.com/lktiep/cortex-hub/blob/master/docs/conductor/setup.md#5-point-each-engine-at-the-hub).

### Claude Code

```bash
claude mcp add --transport http --scope user cortex-hub https://<your-mcp-host>/mcp \
  --header "Authorization: Bearer <api-key>"
```

As JSON in `~/.claude.json`, `"type": "http"` is required; without it Claude Code reads the entry
as a stdio server:

```json
{
  "mcpServers": {
    "cortex-hub": {
      "type": "http",
      "url": "https://<your-mcp-host>/mcp",
      "headers": { "Authorization": "Bearer <api-key>" }
    }
  }
}
```

### Antigravity (agy) and Cursor

`~/.gemini/antigravity/mcp_config.json` or `~/.cursor/mcp.json`, through `mcp-remote`:

```json
{
  "mcpServers": {
    "cortex-hub": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<your-mcp-host>/mcp", "--header", "Authorization: Bearer <api-key>"],
      "env": { "HUB_API_KEY": "<api-key>" }
    }
  }
}
```

Antigravity 2.x, the app and the agy that ships with it, reads `~/.gemini/config/mcp_config.json`
instead, and also accepts the direct form with `serverUrl` and `headers`.

::: warning
`agy mcp list` prints MCP server secrets in plain text. Do not run it where others can see the
screen, and never paste its output.
:::

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.cortex-hub]
command = "npx"
args = ["-y", "mcp-remote", "https://<your-mcp-host>/mcp", "--header", "Authorization: Bearer <api-key>"]

[mcp_servers.cortex-hub.env]
HUB_API_KEY = "<api-key>"
```

Codex can also connect directly with `url = "https://<your-mcp-host>/mcp"` and
`bearer_token_env_var` naming an environment variable that holds the key.

## The VS Code extension

The `cortex-agent` extension (`cortex-hub.cortex-agent`) adds an Agent Panel to Antigravity IDE,
VS Code, Cursor and Windsurf, and connects each window to the hub as an agent over the Conductor
WebSocket. Install it from the latest release:

::: code-group

```bash [macOS / Linux]
curl -fsSL https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/install-extension.sh | bash
```

```powershell [Windows]
irm https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/install-extension.ps1 | iex
```

:::

`--ide antigravity|code|cursor|windsurf` picks one IDE, `--release vX` a release, and
`--vsix <path>` installs a local file.

Each window can have its own agent name and key, set with the pencil in the Agent Panel; the key
goes to the OS keychain. The extension finds the hub in this order: the `cortexHub.hubUrl`
setting, then `CORTEX_HUB_WS_URL` or `CORTEX_HUB_URL`, then the MCP config it detects. It does not
read `~/.codex/config.toml`.

## One key per person and machine

The hub tells sessions apart by API key name, and Conductor delivers notices once per key. Two
agents sharing a key split each other's notices. Create a key for each person and each worker
machine under **API Keys**.
