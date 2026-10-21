# Installer

`scripts/install.sh` (macOS, Linux) and `scripts/install.ps1` (Windows) set up a project to use
the hub. Run them in the project root. They are idempotent: a second run updates what changed and
leaves the rest.

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

To pass flags through `curl | bash`, use `bash -s -- <flags>`.

## Flags

| `install.sh` | `install.ps1` | Effect |
|---|---|---|
| `--force`, `-f` | `-Force` | Regenerate every file, even when it is up to date |
| `--check`, `-c` | `-CheckOnly` | Report what is installed; change nothing |
| `--skip-global` | `-SkipGlobal` | Project only; skip the global `/install` skill |
| `--tools <list>`, `-t`, `--tools=<list>` | `-Tools <list>` | Only these IDEs: `claude`, `gemini`, `cursor`, `windsurf`, `vscode`, `codex` |

Without `--tools`, the installer detects IDEs: `claude` on the PATH or `~/.claude`, `~/.gemini`,
`~/.cursor`, `~/.codeium` or `windsurf`, `code`, `codex` or `~/.codex`. With none found it sets up
Claude Code.

## Environment

| Variable | Meaning |
|---|---|
| `HUB_MCP_URL` | Your hub's MCP endpoint, ending in `/mcp`. Unset, the script falls back to a URL built into it, which is not your hub |
| `HUB_API_KEY` | The API key. Also read from a `HUB_API_KEY=` line in the project's `.env`, or from an existing `cortex-hub` entry in another IDE's config |
| `CORTEX_MCP_URL` | Read by the installed hooks at run time; takes precedence over `HUB_MCP_URL` |

If an IDE config already has a `cortex-hub` entry, the installer keeps it and does not write a new
one.

## What it does, in order

1. **Global `/install` skill**: `~/.claude/skills/install/SKILL.md`, so any project can run the
   installer again from Claude Code. Skipped by `--skip-global`.
2. **MCP config** for each selected IDE:

   | IDE | File |
   |---|---|
   | Claude Code | `~/.claude.json` |
   | Cursor | `~/.cursor/mcp.json` |
   | Windsurf | `~/.codeium/windsurf/mcp_config.json` |
   | Gemini / Antigravity | `~/.gemini/antigravity/mcp_config.json` |
   | VS Code | `.vscode/mcp.json` |

3. **Project profile**: `.cortex/project-profile.json`, from the stacks it detects (Node.js, Go,
   Rust, Python, .NET, Godot). Its `verify` section lists the checks for `pre_commit` and `full`
   runs. Add a [`worker` section](../conductor/workers#the-worker-section) by hand for Conductor.
   An existing profile is left alone.
4. **Agent identity**: `.cortex/agent-identity.json`. Edit it to add a role or capabilities.
5. **Claude Code**: the eight [hooks](./hooks) in `.claude/hooks/`, `.claude/settings.json`, and
   the [`/cs` and `/ce` commands](./slash-commands) in `.claude/commands/`. Stale Cortex hooks are
   removed from `~/.claude/settings.json` so they do not run twice.
6. **Gemini / Antigravity**: five hooks in `.gemini/hooks/` (session-init, enforce-session,
   enforce-commit, track-quality, session-end-check) and `.gemini/settings.json`.
7. **Rules files** for IDEs without hooks: `.cursorrules`, `.windsurfrules`,
   `.vscode/copilot-instructions.md`, `.codex/instructions.md`. The Cortex part sits between
   `<!-- cortex-hub:auto-mcp -->` markers.
8. **`CLAUDE.md`**: created, or a Cortex section is added between markers.
9. **Version marker**: `.cortex/.hooks-version`. A newer installer regenerates the hooks.
10. **Git hooks** through [lefthook](https://github.com/evilmartians/lefthook), from the profile.
11. **`.gitignore`**: `.claude/`, `.cortex/.session-state/`, `.codex/`, `.windsurfrules`,
    `.cursorrules`.

## Repos that own their git hooks

If the repo already runs its own checks from git hooks (a committed lefthook config, husky, a
`.pre-commit-config.yaml`, or a `core.hooksPath` with hooks in it), the installer adds no
pre-commit or pre-push. Where the repo's own lefthook config can take it, it merges in only
Cortex's post-push hook. A `core.hooksPath` that holds no hooks is unset so lefthook can install.

## `/install` in Claude Code

After the first run, `/install` is a global Claude Code skill. It takes the same flags
(`--force`, `--check`, `--tools claude,gemini`), downloads the current `install.sh` from GitHub
and runs it. Claude does not call it on its own (`disable-model-invocation: true`).

## Removing it

`scripts/uninstall.sh` removes the local Cortex config for every IDE.
