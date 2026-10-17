# Conductor manual test checklist

The automated suites cover the hub, the worker on macOS and Linux, and the dashboard logic (see
the status table in [`../conductor.md`](../conductor.md#current-status)). This page covers what they
cannot: real machines, real engine accounts, Windows, Docker and the packaged extension. Run the
checks in order. Each one says where to run it, what you need, the steps, and what a pass looks
like. Record each result in the [results table](#results).

Placeholders: `https://<your-mcp-host>` (your hub's MCP address), `<dashboard-url>` (where you
open the dashboard), `<lead-api-key>` and `<worker-api-key>`.

> **Never share keys.** When a check fails, send the failing lines, not whole files. MCP configs
> hold keys in plain text. The worker log redacts keys, but read what you paste before you send
> it. Never run `agy mcp list`: it prints MCP secrets.

## 0. Before you start

- [ ] The hub runs the release you are testing. `curl -s <dashboard-url>/health` (or port 4000
  on the hub host) returns `"version": "1.0.0"`. The compose file uses `:latest` images with
  watchtower; to pull now, run `docker compose pull && docker compose up -d` in `infra/`.
- [ ] The hub serves the same worker: `curl -s https://<your-mcp-host>/conductor/worker.version`
  prints `1.0.0`.
- [ ] Two keys exist in Dashboard, Settings, API Keys: `lead`, and one `worker-<host>` per worker
  machine ([setup §2](setup.md#2-api-keys)).
- [ ] A sandbox repository on GitHub that you do not mind getting pull requests: a README and one
  small source file are enough. Clone it on every machine you test. Tasks open PRs there, not in a
  real project.

## 1. Hub on Docker with `EXTERNAL_MCP_URL`

**Where:** the hub server. **Covers:** the MCP address shown on the dashboard.

1. In `infra/.env`, set `EXTERNAL_MCP_URL=https://<your-mcp-host>` (no `/mcp`; it is appended).
2. `cd infra && docker compose up -d`.
3. Open `<dashboard-url>/settings`.

**Pass when:**

- [ ] Every MCP snippet shows `https://<your-mcp-host>/mcp`, and the Claude Code snippet contains
  `"type": "http"`.
- [ ] The Home page snippet shows the same address.
- [ ] "Run a worker" shows a macOS/Linux line and a PowerShell line, both with `--hub
  https://<your-mcp-host>`. Each Copy button copies its line.
- [ ] With `EXTERNAL_MCP_URL` empty: opened on `http://localhost:4000`, the dashboard shows
  `http://localhost:8318/mcp`; opened through a domain, it says the address is not configured
  instead of guessing.
- [ ] Modals open centred on the screen.

## 2. Worker on macOS or Linux, live run

**Where:** one macOS or Linux machine, inside the sandbox clone. **Covers:** bootstrap, doctor,
one task from queue to pull request.

1. Install at least one engine and log in once ([setup §4](setup.md#4-engines)). Point it at the
   hub with the **worker** key ([setup §5](setup.md#5-point-each-engine-at-the-hub)).
2. Start the worker:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/run-agent.sh | CORTEX_API_KEY=<worker-api-key> bash -s -- start --daemon --hub https://<your-mcp-host>
   ```

3. `node ~/.cortex/worker/cortex-worker.mjs doctor --probe`
4. `node ~/.cortex/worker/cortex-worker.mjs status`
5. From the lead (check 3), or any MCP client with the lead key, create a one-task plan in the
   sandbox repo, for example "add a line to README.md" with `files: ["README.md"]`.
6. `node ~/.cortex/worker/cortex-worker.mjs logs -f` while it runs.

**Pass when:**

- [ ] Doctor exits 0. `hub health`, `handshake` and `origin` pass, `worker version` matches the hub,
  and every engine you installed answers the probe.
- [ ] The machine shows as online on `/conductor` within a few seconds.
- [ ] The task moves into this machine's lane within 5 s of being created.
- [ ] A new branch and a pull request appear in the sandbox repo (or the log prints a compare URL
  when `gh` is not logged in).
- [ ] The task ends in `review` or `completed`. Its worktree under `~/.cortex/worker/<agentId>/wt/`
  is removed afterwards, unless the log says `worktree kept at ...`.
- [ ] `node ~/.cortex/worker/cortex-worker.mjs stop` stops the daemon, and `status` says so.

## 3. A real lead with `orchestrator-prompt.md`

**Where:** the lead machine, Claude Code with the **lead** key, in the sandbox clone. Keep the
worker from check 2 running. **Covers:** planning in one call, notices, review.

1. Add the hub with the lead key ([setup §9](setup.md#9-lead-setup)).
2. Start a session and say: *Read `scripts/orchestrator-prompt.md` and act as the conductor lead.*
3. Ask for a small plan: three tasks on different files of the sandbox repo, one depending on
   another, and a user gate at the end.

**Pass when:**

- [ ] The lead calls `cortex_agents` and then a single `cortex_task_tree_create`, with one `group`
  root, `files` on every work task, and a gate with `approver: "user"`.
- [ ] `/conductor` shows the plan: depth columns, the dependency edge, the gate.
- [ ] When a task reaches review, the lead receives a `review_ready` notice and approves or
  rejects it with `cortex_task_review`.
- [ ] The lead cannot close the user gate over MCP (403); it says to approve it on the dashboard.

## 4. Dashboard with a real worker

**Where:** `/conductor`, with the plan from check 3 and the worker from check 2.

**Pass when:**

- [ ] **Lanes.** A queued task sits in the `queue` lane; when the worker takes it, it moves to the
  machine's lane within 5 s.
- [ ] **User gate.** When the gate's dependencies finish, it appears under *Needs you*. *Approve*
  unblocks the tasks after it.
- [ ] **Reject.** Reject a task in review with feedback. It returns to `pending` and runs again on
  the same branch.
- [ ] **Reroute a running task.** Change the route of a task that is running. A confirmation
  appears; accept it. The task moves to the new route, and the chip updates on the next poll.
- [ ] **Models.** The worker's card lists each engine as `<engine> (N models)`, and the route form
  suggests those models.
- [ ] **Stale action.** Approve the same task from two tabs. The second shows the 409 message and
  refreshes the view.

## 5. agy MCP config path

**Where:** a machine with `agy` installed. **Covers:** which file agy reads its MCP servers from.

1. Put the `cortex-hub` entry only in `~/.gemini/antigravity/mcp_config.json`
   ([setup §5](setup.md#agy-antigravity-cli)). Edit the file in an editor; do not print it.
2. Start `agy` in the sandbox clone and ask it to call the `cortex_health` tool.
3. If agy does not see the tool, move the entry to `~/.gemini/config/mcp_config.json` (the
   vendor's path) and try again.
4. `node ~/.cortex/worker/cortex-worker.mjs doctor` and read the `engine MCP configs` row.

**Pass when:**

- [ ] You know which of the two paths your agy build reads. Report the path, and your
  `agy --version`.
- [ ] Doctor's `engine MCP configs` row raises no warning.

## 6. Quota output of claude, codex and gemini

**Where:** any worker machine, when an engine actually runs out of quota. You cannot force this
check; run it when it happens, or with an account that has little quota left.

**Pass when:**

- [ ] The task waits with reason `capacity` and a reset time on the dashboard, instead of failing.
- [ ] The lead receives a `capacity` notice.

**If the task fails instead:** send the engine name, its version, and the worker log lines around
the failure (`node ~/.cortex/worker/cortex-worker.mjs logs`). These lines are what the quota
patterns need. Remove anything that looks like a key, an email address or a host before sending.

## 7. VS Code extension (packaged VSIX)

**Where:** a machine with VS Code and a clone of cortex-hub. **Covers:** the extension finds the hub
and connects to `/ws/conductor` once.

1. Build and package:

   ```bash
   pnpm install
   pnpm --filter cortex-agent build
   cd apps/cortex-extension && pnpm package
   ```

2. `code --install-extension apps/cortex-extension/cortex-agent-<version>.vsix`, then reload VS
   Code and open the sandbox clone.
3. Open View, Output, and pick **Cortex Agent**.

**Pass when:**

- [ ] The log has `Config loaded: ... hubSource=<source>`, where `<source>` is the setting, env var
  or config file you expect. The key shows only as `***` and its last 8 characters.
- [ ] The URL it connects to ends in `/ws/conductor` exactly once (never
  `/ws/conductor/ws/conductor`).
- [ ] The agent shows in Agents Online on the dashboard.

## 8. Worker on Windows

**Where:** Windows 10 or 11, PowerShell, inside the sandbox clone. **Covers:** the parts the
end-to-end test skips on Windows: `.cmd` shims, process-tree kill, `cmd.exe`.

1. Install Node 20+, git, gh and at least one engine ([setup §3–4](setup.md#3-prerequisites)).
2. Start the worker:

   ```powershell
   $env:CORTEX_API_KEY="<worker-api-key>"; iwr -useb https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/run-agent.ps1 -OutFile $env:TEMP\run-agent.ps1; powershell -NoProfile -ExecutionPolicy Bypass -File $env:TEMP\run-agent.ps1 start --daemon --hub https://<your-mcp-host>
   ```

3. `node $HOME\.cortex\worker\cortex-worker.mjs doctor --probe`
4. Run a one-task plan as in check 2.
5. Start a second task and run `node $HOME\.cortex\worker\cortex-worker.mjs stop` while it runs.

**Pass when:**

- [ ] The bootstrap line works under the default execution policy, and the machine's policy is
  unchanged afterwards (`Get-ExecutionPolicy -List`).
- [ ] Doctor exits 0 and finds the engines installed as `.cmd` shims (for example `agy` or
  `claude` from npm).
- [ ] The first task ends with a branch and a pull request, as on macOS. agy runs with
  `accept-edits` there, since Windows has no `--mode auto`.
- [ ] After `stop`, no engine process is left running in Task Manager.

## 9. `install.ps1` and `onboard.ps1` on Windows

**Where:** Windows PowerShell 5.1 and PowerShell 7, in a project clone.

1. Download and run the installer the way the README shows:

   ```powershell
   iwr -useb "https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/install.ps1" -OutFile $env:TEMP\install.ps1; powershell -NoProfile -ExecutionPolicy Bypass -File $env:TEMP\install.ps1
   ```

2. Run it again (it should be idempotent), then with `-CheckOnly`.
3. Run `scripts\onboard.ps1` with `$env:HUB_API_KEY` set to a worker key, once interactively and
   once with `-Tool cursor`.

**Pass when:**

- [ ] Both scripts finish without errors under the default execution policy, in both PowerShell
  versions.
- [ ] The second run changes nothing; `-CheckOnly` reports everything as set up.
- [ ] Each MCP config onboard writes points at `https://<your-mcp-host>/mcp` (check in an editor;
  do not paste the file).
- [ ] A worker started afterwards (check 8) finds the hub and key without `--hub` or
  `--api-key`.

## Results

Copy this table into an issue or a message, one row per check and environment.

| Check | Environment (OS, engine, versions) | Result | Notes |
|---|---|---|---|
| 0. Before you start | | | |
| 1. Docker `EXTERNAL_MCP_URL` | | | |
| 2. Worker macOS/Linux | | | |
| 3. Lead | | | |
| 4. Dashboard with worker | | | |
| 5. agy MCP path | | | |
| 6. Quota output | | | |
| 7. VSIX | | | |
| 8. Worker Windows | | | |
| 9. `install.ps1` / `onboard.ps1` | | | |
