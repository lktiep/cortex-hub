# Quick start

You need a running hub and an API key. If you do not have a hub yet, [self-host one](./self-host)
first; it takes one `docker compose up`.

## 1. Get an API key

Open the dashboard, go to **API Keys** (`/keys`) and create a key. Give each person, and each
worker machine, its own key: the hub tells sessions apart by key name, and Conductor notices are
delivered per key.

## 2. Install into your project

Run this in the root of the project you work on. `HUB_MCP_URL` is your hub's MCP endpoint and
`HUB_API_KEY` the key from step 1.

::: code-group

```bash [macOS / Linux]
curl -fsSL "https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/install.sh" \
  | HUB_MCP_URL=https://<your-mcp-host>/mcp HUB_API_KEY=<api-key> bash
```

```powershell [Windows]
$env:HUB_MCP_URL="https://<your-mcp-host>/mcp"; $env:HUB_API_KEY="<api-key>"
iwr -useb "https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/install.ps1" -OutFile $env:TEMP\install.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File $env:TEMP\install.ps1
```

:::

::: warning Set HUB_MCP_URL
Without `HUB_MCP_URL`, the installer falls back to a hub URL built into the script, which is not
yours. If an IDE already has a `cortex-hub` MCP entry, the installer keeps it and does not write a
new one.
:::

The installer detects your IDEs (Claude Code, Gemini/Antigravity, Cursor, Windsurf, VS Code,
Codex) and, for each, writes the MCP config and the workflow rules. For Claude Code it also
installs the eight hooks and the `/cs` and `/ce` commands. It is safe to run again; `--check`
reports what is installed without changing anything. Every flag is in the
[installer reference](../reference/installer).

Once the installer has run once, Claude Code has a global `/install` command that runs it again
in any project.

The key is also read from a `HUB_API_KEY=` line in the project's `.env`, or from an existing
`cortex-hub` entry in another IDE's config.

## 3. Start a session

Restart your agent so it loads the new MCP server, then:

```
/cs
```

`/cs` opens a session on the hub, recalls the team's knowledge and your memory for this repo,
shows who else is editing, and picks up any task assigned to you. In Claude Code, edits are
blocked until it has run. See [Sessions and recall](./sessions).

When you are done:

```
/ce
```

`/ce` runs build, typecheck and lint, reports them to the hub, stores what you learned and closes
the session with a summary the next session starts from.

## Without the installer

Any MCP client can talk to the hub directly. For Claude Code:

```bash
claude mcp add --transport http --scope user cortex-hub https://<your-mcp-host>/mcp \
  --header "Authorization: Bearer <api-key>"
```

The same entry in `~/.claude.json` needs `"type": "http"`; without it Claude Code reads the entry
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

The dashboard's **Settings** page shows this snippet with your hub's URL filled in. Other IDEs are
covered in [Multi-IDE](./multi-ide). You get the tools this way, but not the hooks that make an
agent use them.

## Next

- [Self-host the hub](./self-host)
- [Run a worker](../conductor/workers) so other machines can take tasks
- [`cw` reference](../reference/cli)
