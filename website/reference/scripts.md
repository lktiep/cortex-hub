# Scripts

Everything in `scripts/`, grouped by who runs it. Scripts with a `.ps1` twin work the same way on
Windows.

## Setting up a project

| Script | What it does |
|---|---|
| `install.sh`, `install.ps1` | Sets up a project: MCP config, hooks, commands, rules, profile, git hooks. See [Installer](./installer) |
| `onboard.sh`, `onboard.ps1` | Interactive onboarding: asks for the API key, MCP URL and IDEs, writes the MCP config, then hands the hooks and rules to `install.sh`. `--tool claude` (or another IDE) skips the prompt; `--tool bot` prints connection details for a headless agent |
| `uninstall.sh` | Removes the local Cortex config for every IDE |
| `setup-hooks.sh` | Writes a `lefthook.yml` from `.cortex/project-profile.json`, with per-language file filters. Needs `python3`; installs lefthook if missing |
| `install-extension.sh`, `install-extension.ps1` | Installs the `cortex-agent` VS Code extension into Antigravity, VS Code, Cursor and Windsurf. `--ide`, `--release`, `--vsix`. See [Multi-IDE](../guide/multi-ide) |

## Setting up a hub

| Script | What it does |
|---|---|
| `bootstrap.sh` | Asks whether you are an administrator (the whole Docker stack) or a member (connect a project to an existing hub) and runs the matching installer |
| `install-hub.sh` | Installs the hub: checks dependencies, prepares the directory and environment, starts the stack, builds the shared packages |
| `prune-leaked-images.sh` | Emergency cleanup: removes locally cached Cortex images and the builder cache, in case an image was built with data that should not be in it. Stop the stack first |

See [Self-host](../guide/self-host).

## Running agents

| Script | What it does |
|---|---|
| `run-agent.sh`, `run-agent.ps1` | The worker bootstrap: downloads the TypeScript worker from your hub, installs `cw` and starts it. See [Run a worker](../conductor/workers) |
| `cortex-agent.sh`, `cortex-agent.ps1` | A shell client for the hub's conductor WebSocket that receives tasks and starts an engine. It speaks the hub's first agent protocol |
| `cortex-worker.sh`, `cortex-worker.ps1` | A background loop that polls for assigned tasks and runs them with `claude -p` (or `--engine codex`). `--name`, `--interval` |
| `cortex-listen.sh` | A listener to run in the background inside Claude Code; prints a line when a task arrives |
| `orchestrator-prompt.md` | The prompt that makes an agent the Conductor lead. See [Conductor](../conductor/overview) |
| `merge-check.sh <worktree>` | Checks a parallel agent's worktree before you merge it, ending with an API smoke test when a server is running |

## Maintaining Cortex

| Script | What it does |
|---|---|
| `release.sh` | Cuts a stable release; see below |
| `bump-version.sh` | Changes `version.json`: `patch` (default), `minor`, `major`, or `set <x.y.z>` |
| `sync-install-templates.sh` | Copies the canonical hooks and commands into both installers; `--check` reports drift and exits 1, for CI. A wrapper around `sync_install_templates.py` |
| `test-hooks.sh` | Tests for the enforcement [hooks](./hooks). Every case is a gap that was open in a shipped version |
| `test-run-agent.sh` | Tests for `cw` as `run-agent.sh` installs it, against a scratch home folder and a local stand-in hub |

## Release

CI owns the version number. Every merge to `master` that touches the hub's code claims the next
patch version in `version.json` and publishes the images under it (`cortex-api`, `cortex-hub-web`,
`cortex-mcp`, `cortex-gitnexus` on `ghcr.io/lktiep`).

A stable release goes through the same workflow:

```bash
./scripts/release.sh            # minor (default)
./scripts/release.sh patch      # or major
./scripts/release.sh current    # finish a release whose version was claimed but whose builds failed
```

The script needs `gh`. It refuses while another publish run is in progress, asks for
confirmation, then runs the **Build and Publish Docker Images** workflow with `stable` on. That
workflow claims the version, builds every image from one commit, tags them `v<version>` and
`:stable`, and creates the git tag and a GitHub Release on that same commit. Edit the notes
afterwards with:

```bash
gh release edit v<version> --notes-file notes.md
```

A self-hosted stack with Watchtower picks up new images on its own: Watchtower polls every 5
minutes and updates only the containers labelled for it (the Cortex images, not Qdrant or Ollama).
