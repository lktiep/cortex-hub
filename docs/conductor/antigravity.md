# Antigravity on macOS, Windows and Ubuntu

Antigravity comes in three forms, and each one reaches Cortex Hub in its own way. Set up the ones
you use.

| You run | It connects through | Who it is to the hub |
|---|---|---|
| **Antigravity IDE** (the editor) | The `cortex-agent` extension, over the conductor WebSocket | The name you give each window |
| **Antigravity** (the agent app) | MCP only, from `~/.gemini/config/mcp_config.json` | The key in that file |
| **agy** (the CLI), headless | A Conductor worker started with `--engines agy` | `--agent-id` and the worker's own key |

Placeholders: `https://<your-mcp-host>` (your hub), `<dashboard-url>`, `<worker-api-key>`. Create
keys in Dashboard, Settings, API Keys. Use one key per agent that runs at the same time, so you can
tell them apart and revoke one without stopping the others.

## 1. Antigravity IDE: install the extension

The extension is attached to every release as `cortex-agent.vsix`. This link always serves the
newest one:

```
https://github.com/lktiep/cortex-hub/releases/latest/download/cortex-agent.vsix
```

### macOS

```bash
curl -fsSL https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/install-extension.sh | bash -s -- --ide antigravity
```

Leave out `--ide antigravity` to install into every editor the script finds: Antigravity IDE, VS
Code, Cursor and Windsurf. It looks on your PATH, then inside the app in `/Applications`. By hand,
with a downloaded VSIX:

```bash
"/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide" --install-extension cortex-agent.vsix --force
```

### Ubuntu

The same one-liner as macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/install-extension.sh | bash -s -- --ide antigravity
```

The script needs `curl`, and `unzip` to read the version inside the VSIX (`sudo apt install curl
unzip`). It looks on your PATH, then in `/usr/share/antigravity-ide/bin/` (a .deb install) and
`/snap/bin/` (unverified: check where your package put it with `dpkg -L` or `snap list`).

### Windows (PowerShell)

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/install-extension.ps1))) -Ide antigravity
```

Or `irm https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/install-extension.ps1 | iex`
for every editor it finds. The script looks for `antigravity-ide` on your PATH, then under
`%LOCALAPPDATA%\Programs\Antigravity*\bin\` (unverified: check where your installer put it). By
hand: open the Extensions view, use the `...` menu, choose **Install from VSIX...**, and pick the
downloaded file.

### What the script prints

- `[cortex] Antigravity IDE: cortex-hub.cortex-agent@1.0.x` means it worked. The script checks by
  asking the editor which version it lists, not by the installer's exit code.
- Antigravity IDE writes a warning while it installs: `... depends on antigravityAnalytics which is
  NOT registered`. It is harmless and the extension works. An older copy of the Windows script
  turned that line into a red error and stopped, even though the install had gone through. Check
  with `--list-extensions` (below) before installing again.
- When the install really fails, the script prints the editor's last lines and keeps the
  downloaded VSIX in your Downloads folder as `cortex-agent-<version>.vsix`. Install that file by
  hand: Extensions view, `...` menu, **Install from VSIX...**.

### Then, on every OS

1. Reload each window: **Developer: Reload Window**.
2. Check the version. It should list `cortex-hub.cortex-agent@1.0.0` or newer:
   `antigravity-ide --list-extensions --show-versions` (on macOS, the full path above; on Windows,
   `antigravity-ide.cmd`).
3. An older 0.x copy has the same id and is replaced. If it still shows, remove it and install again:
   `antigravity-ide --uninstall-extension cortex-hub.cortex-agent`.

## 2. Antigravity IDE: one agent per window

Open **Cortex: Open Agent Panel** and click the pencil next to the agent name. You can set:

- **Name**: what the hub and the dashboard show.
- **Capabilities**: the tags the hub matches tasks on.
- **API key**: leave it empty to keep the current key.

Click **Save**. The change applies to this window only, and the extension reconnects with it.

- **Where it is kept.** The name and capabilities go in the workspace state. The key goes in the
  OS keychain (Keychain on macOS, Credential Manager on Windows), through the editor's
  SecretStorage. Nothing is written to `settings.json`.
- **What the panel shows.** The key appears as `***` plus its last 8 characters, followed by where
  it came from. The sources are `window`, `setting`, `env:<NAME>` or a config path.
- **Undoing it.** **Reset window**, or the command **Cortex: Reset This Window's Agent and Key**,
  forgets this window's choices. The window then uses the `cortexHub.*` settings again.

If a window has no key of its own, the extension looks for one in this order:

1. the `cortexHub.apiKey` setting;
2. the `CORTEX_HUB_API_KEY`, `HUB_API_KEY` or `CORTEX_API_KEY` env var;
3. the `cortex-hub` entry in an MCP config: Claude Code, Gemini, Antigravity
   (`~/.gemini/antigravity/` and `~/.gemini/config/`), Cursor, Windsurf or VS Code.

Its name defaults to `cortexHub.agentId`, else `<hostname>-<ide>`.

**Two windows need two names.** The hub keeps one connection per name. A second window with the
same name replaces the first, closing it with code 4000.

Before 1.0, the replaced window reconnected and took the name back, so the two windows took turns
forever. The panel showed "connected" and "disconnected" over and over. From 1.0 the replaced
window stops and says why, with a button to rename it. The workspace state belongs to a folder,
so to run two agents, open two different folders. A git worktree of the same repo is a good
second folder.

When the extension stops, the panel shows the reason:

| Close | Meaning | What to do |
|---|---|---|
| 4000 | Another window on this machine connected with the same name | Click **Rename this window**, or set a name with the pencil |
| 4009 | That name is connected from another machine | Choose another name |
| 4001 | No key was sent | Set a key with the pencil, **Set key for this window** |
| 4003 | The hub refused the key (wrong, revoked or for another project) | Set the right key for this window |

After you fix it, click **Reconnect**, or run **Cortex: Connect**.

## 3. Antigravity (the agent app): MCP

The app talks to the hub only through MCP. Edit its MCP config, then restart the app.

- macOS: `~/.gemini/config/mcp_config.json`
- Windows: `%USERPROFILE%\.gemini\config\mcp_config.json` (unverified: check the vendor's MCP page)

Older builds read `~/.gemini/antigravity/mcp_config.json`. On some Macs that file is a symlink to
the one above, so check before you keep two copies: `ls -l ~/.gemini/antigravity/mcp_config.json`.

```json
{
  "mcpServers": {
    "cortex-hub": {
      "serverUrl": "https://<your-mcp-host>/mcp",
      "headers": { "Authorization": "Bearer <worker-api-key>" }
    }
  }
}
```

This is the vendor's direct form. `scripts/onboard.sh` writes the `mcp-remote` form instead (see
[setup.md](setup.md#agy-antigravity-cli)). The worker and the extension read both forms.

The app has one MCP config per OS user. That means one key for every conversation in the app, and
the agy CLI may read the same file. To give something else its own key, run it as a headless
worker (section 4).

> **Never run `agy mcp list`.** It prints MCP server secrets in plain text. To see which hub the
> app points at, look at the dashboard's Sessions page after you ask the app to call
> `cortex_health`.

## 4. agy headless, with a key you choose

A Conductor worker runs agy without a window. It picks up tasks the hub sends it, each in its own
git worktree. First install agy and sign in once ([setup.md, section 4](setup.md#4-engines)).
Then run this inside a clone of the project.

### macOS

```bash
curl -fsSL https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/run-agent.sh | CORTEX_API_KEY=<worker-api-key> bash -s -- start --daemon --hub https://<your-mcp-host> --engines agy --agent-id <host>-agy
```

Ubuntu takes the same command. Install Node.js 20 or newer first.

### Windows (PowerShell)

```powershell
$env:CORTEX_API_KEY="<worker-api-key>"; iwr -useb https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/run-agent.ps1 -OutFile $env:TEMP\run-agent.ps1; powershell -NoProfile -ExecutionPolicy Bypass -File $env:TEMP\run-agent.ps1 start --daemon --hub https://<your-mcp-host> --engines agy --agent-id <host>-agy
```

On Windows, agy runs with `--mode accept-edits`, because agy on Windows has no `auto` mode.

### Which key does what

- **The worker's connection.** The worker uses `CORTEX_API_KEY` (or `--api-key`). That key is how
  the hub identifies the worker and which tasks it gets. It is not read from any file, so it can
  differ from the key of the app and of every IDE window.
- **agy's own tool calls.** Each agy run reads agy's MCP config (section 3) for its `cortex-hub`
  tool calls. Doctor's `engine MCP configs` row warns when that config points at a different hub.

### Manage it

```bash
node ~/.cortex/worker/cortex-worker.mjs doctor --engines agy --agent-id <host>-agy --probe
node ~/.cortex/worker/cortex-worker.mjs status --agent-id <host>-agy
node ~/.cortex/worker/cortex-worker.mjs logs -f --agent-id <host>-agy
node ~/.cortex/worker/cortex-worker.mjs stop --agent-id <host>-agy
```

On Windows, use `node $HOME\.cortex\worker\cortex-worker.mjs ...`. To run a second headless agy
with another key, start it with another `--agent-id` and another `CORTEX_API_KEY`.

The daemon does not survive a reboot: run `start --daemon` again after a restart. Keep in mind
that agy takes about 2 minutes to start, almost all of it spent starting its MCP servers.

## 5. Checklist

Run it on each machine and tick the steps that pass. Where a step fails, note what you saw:
the panel's text, or the log lines with hosts and keys removed.

| # | Step | Expected | macOS | Windows | Ubuntu |
|---|---|---|---|---|---|
| 1 | Install the extension with the one-liner (section 1) | `[cortex] Antigravity IDE: cortex-hub.cortex-agent@1.0.0` or newer | ☐ | ☐ | ☐ |
| 2 | Reload the window and open **Cortex: Open Agent Panel** | Green dot. The key shows as `***xxxxxxxx · <source>` | ☐ | ☐ | ☐ |
| 3 | Pencil: set a name, a capability and a new key, then Save | The toast says "Saved for this window". The dashboard shows the new name. The key source is `window` | ☐ | ☐ | ☐ |
| 4 | Check that the key is not in `settings.json` | Search your user `settings.json` for `cortexHub.apiKey`: it is unchanged | ☐ | ☐ | ☐ |
| 5 | Open a second folder in a second window, with another name and key | Both stay connected for 5 minutes, with no flapping. The dashboard lists two agents | ☐ | ☐ | ☐ |
| 6 | Give the second window the first one's name | The first window stops with the 4000 message and stays stopped. **Rename this window** fixes it | ☐ | ☐ | ☐ |
| 7 | **Reset window** | The panel's key source goes back to `setting`, env or a config path | ☐ | ☐ | ☐ |
| 8 | Antigravity app: add the MCP entry (section 3), restart the app, ask it to call `cortex_health` | The hub answers. A session appears on the dashboard | ☐ | ☐ | ☐ |
| 9 | Headless agy: start it (section 4), then run `doctor --engines agy --probe` | Every required row passes. The `engine agy` row answers | ☐ | ☐ | ☐ |
| 10 | Send the headless agy a small task from the lead | It accepts the task, works in a worktree and reports back | ☐ | ☐ | ☐ |

## Troubleshooting

- **The panel flips between connected and disconnected.** Two windows, or a window and a worker,
  use the same name with an extension older than 1.0. Install 1.0 (section 1) and give each
  window its own name (section 2).
- **"No API key configured".** Set one with the pencil, or see the lookup order in section 2.
- **The old version still runs after installing.** Reload the window. If it still shows the old
  version, uninstall and install again (section 1).
- **The script finds no editor.** Pass the VSIX by hand: `--vsix ./cortex-agent.vsix`
  (`-Vsix` on Windows), or use **Install from VSIX...**.
- **A red error on Windows, but Install from VSIX works.** An older copy of the script stopped on
  the harmless `NOT registered` warning (section 1). Run `antigravity-ide.cmd --list-extensions
  --show-versions`: if it lists `cortex-hub.cortex-agent`, the install went through. Reload the
  window.
- **Windows refuses to run the script** ("running scripts is disabled"). Use the `irm` one-liner,
  which does not run a file, or start PowerShell with `-ExecutionPolicy Bypass` for that session.
