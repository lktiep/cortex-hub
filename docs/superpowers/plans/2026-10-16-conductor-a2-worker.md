# Conductor A2 — Worker Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `scripts/cortex-agent.sh` and `scripts/cortex-agent.ps1` with one TypeScript worker. It runs on macOS, Linux and Windows, takes one task at a time from the hub, runs it headless in a git worktree with agy, Claude Code, Codex or Gemini, and returns a pushed branch, a PR (or compare URL) and test output. When a model's quota runs out, the worker pushes its work in progress and hands the task back.

**Architecture:** New package `apps/conductor-worker` (`@cortex/conductor-worker`). esbuild bundles `src/cli.ts` and `ws` into one ESM file, `dist/cortex-worker.mjs`, stamped with the hub's release version. hub-mcp's Node entry serves that file at `GET /conductor/worker.mjs` and `GET /conductor/worker.version`. The `run-agent.sh/.ps1` bootstraps download it from the hub and run it.

Inside the worker, the pieces are small, injectable modules:
- config detection
- hub client: WebSocket, reconnect, close codes
- git flow
- engine adapters
- task runner: one task end to end
- worker: protocol state machine
- CLI commands

Each one is unit-tested with vitest against fixtures, a temporary git repo with a bare `origin`, and a local `ws` server.

**Tech Stack:** TypeScript (strict, ES2022, ESM), Node ≥ 20 at runtime, `ws` ^8.18, `smol-toml` ^1.3 (bundled, used for Codex config), esbuild ^0.27 (already in the lockfile), vitest ^3, `node:util` `parseArgs`, `node:child_process`. No runtime install step: everything is bundled.

**Spec:** `docs/superpowers/specs/2026-10-16-conductor-production-ready-design.md`. This plan covers §6.12, the worker side of §6.5, defects W1–W7 (§2), the worker and end-to-end parts of §10, and the worker rows of §11.

**Contract:** protocol type names come verbatim from `@cortex/shared-types` (`packages/shared-types/src/conductor.ts`, created by **A1 Task 1**):
- constants: `CONDUCTOR_PROTOCOL_VERSION`, `Executor`, `EXECUTORS`
- task data: `RouteSpec`, `EngineInfo`, `TaskReview`, `TaskHandoff`, `TaskResult`, `AssignedTask`
- worker → hub: `WorkerRegisterMsg`, `TaskAcceptMsg`, `TaskProgressMsg`, `TaskCompleteMsg`, `TaskQuotaExhaustedMsg`, `TaskDeclineMsg`, `StatusUpdateMsg`, `WorkerToHubMsg`
- hub → worker: `RegisteredMsg`, `TaskAssignedMsg`, `TaskRevokedMsg`, `HubToWorkerMsg`

Close codes:
- 4001 missing key
- 4003 bad key
- 4000 replaced by a newer connection from the same host
- 4009 agent id in use on another host

---

## Global Constraints

- **Ordering:** A1 Task 1 must land first, because this plan imports protocol types from `@cortex/shared-types`. After that lands, and after any edit to `conductor.ts`, run `pnpm --filter @cortex/shared-types build` once. Workspace packages resolve through `dist/`.
- **Ownership:**
  - A2 may edit only:
    - `apps/conductor-worker/**`
    - `apps/hub-mcp/src/worker-asset.ts` (+ test)
    - `apps/hub-mcp/src/ws-close.ts` (+ test)
    - the `serve(...)` call and the WebSocket-proxy close handler in `apps/hub-mcp/src/node.ts`
    - `infra/Dockerfile.hub-mcp`
    - `scripts/run-agent.sh` and `scripts/run-agent.ps1`
    - the first lines (deprecation notice) of `scripts/cortex-agent.sh` and `scripts/cortex-agent.ps1`
  - Do **not** touch `apps/hub-mcp/src/index.ts`. A1 edits it, and it is also the Cloudflare Workers entry, so `node:fs` cannot be imported there.
  - `pnpm-workspace.yaml` already lists `apps/*`; no change is needed.
- **Conventions:**
  - camelCase for functions and variables, PascalCase for types.
  - `import type` for type-only imports (eslint `consistent-type-imports`).
  - No `any`.
  - Unused parameters are prefixed with `_`.
- **Test command per task:** `pnpm --filter @cortex/conductor-worker exec vitest run <file>`. hub-mcp tasks use `pnpm --filter @cortex/hub-mcp exec vitest run <file>`.
- **Platform-sensitive code** takes `platform: NodeJS.Platform` and `env` as parameters, defaulting to `process.platform` and `process.env`, so Windows branches are unit-tested on any OS. Tests that spawn POSIX shell scripts use `it.skipIf(process.platform === 'win32')`.
- **Secrets:**
  - The API key never appears in logs, in progress messages, or in `worker.register.repo`.
  - The logger redacts the key and any `apiKey=` query value.
  - Origin URLs are stripped of userinfo before leaving the process.
  - Test fixtures contain no tokens, personal paths, or conversation ids.
- **Git safety:**
  - The worker never force-pushes.
  - It never uses `--no-verify`, so the repo's own hooks run (#54).
  - It never touches the user's checkout. All work happens in worktrees under `~/.cortex/worker/<agentId>/wt/<taskId>`.
- **Commits:** conventional messages (`feat(worker): …`, `test(worker): …`, `feat(hub-mcp): …`, `build(docker): …`, `chore(scripts): …`). Each commit step stages exactly that task's **Files** list (`git add <files>`) before `git commit`. Gates before each commit, per CLAUDE.md: `pnpm build && pnpm typecheck && pnpm lint`. Run them last, after the final edit, then commit.

## Review Focus

Five input and failure modes the spec does not spell out. Each one has a named test in its owning task.

1. **Auth failure through the hub-mcp proxy is an HTTP 401, not a close code.** `apps/hub-mcp/src/node.ts` checks the key before the upgrade. On a bad key it writes `HTTP/1.1 401` and destroys the socket. Today the proxy also closes the client with no code when dashboard-api closes upstream, so 4000/4009 never arrive.
   - A worker that reconnected on these would hammer the hub forever, or two instances would steal the agent id from each other.
   - Fixed by Task 9 (`treats an HTTP 401 handshake as bad-key and stops reconnecting`) and Task 14 (`forwardCloseCode keeps 4000-4999 and maps 1005/1006`).
2. **Reconnect while a task runs, or after it finished.** On re-register, the hub answers `task.resumed` for a task this process is still running. The answer may also come after the `task.complete` was sent on a socket that died.
   - Starting a second run, or declining as busy, would corrupt the branch.
   - Losing the completion would cost a failure count.
   - Fixed by Task 11:
     - `ignores task.resumed for the task already running`
     - `re-sends the stored outcome when the hub resumes a finished task`
     - `clears the unconfirmed outcome on task.revoked`
3. **Credentials embedded in the origin URL** (`https://x-access-token:ghp_…@github.com/o/r.git`). The URL must not reach `worker.register.repo`, the log, or the compare URL.
   - Fixed by Task 7 (`sanitizeRemoteUrl strips userinfo from https and keeps ssh`) and Task 3 (`redact masks the api key and apiKey= query values`).
4. **Rework on the same branch when a PR already exists.** After a rejected review, the hub sends the task again on the same branch. `gh pr create` then fails with "a pull request for branch … already exists".
   - Failing the task here would turn every rework into a failure.
   - Fixed by Task 7: `openPullRequest returns the existing PR url when gh reports one already exists`.
5. **The task branch is already checked out.** It may be checked out in the user's own checkout, or in a stale worktree left by a crashed run. `git worktree add` refuses both cases.
   - A stale worktree for the same task must be reused, which is the resume after a crash.
   - A branch the user has checked out must be declined, so another worker takes the task, and the user's checkout must not be touched.
   - Fixed by Task 7 (`prepareWorktree reuses an existing worktree for the same task` and `prepareWorktree throws BranchInUseError when the branch is checked out elsewhere`) and Task 11 (`declines with branch-in-use before accepting when the branch is checked out elsewhere`).

## Deliverables and done criteria

The plan is done when all of these hold:

| # | Deliverable | Proven by |
|---|---|---|
| D-1 | `@cortex/conductor-worker` builds one file, `dist/cortex-worker.mjs`, stamped with the hub's version | Task 1 step 4, Task 15 step 3 |
| D-2 | The worker finds the hub URL and key with no flags on a machine where any supported IDE is configured | Task 2 tests, Task 13 `doctor` |
| D-3 | It runs agy, Claude Code, Codex and Gemini headless with the right flags, and tells quota apart from other errors | Tasks 5–6 |
| D-4 | One task end to end: worktree → engine → tests → commit → push → PR or compare URL → `task.complete` (spec success criterion 1) | Task 10, Task 17 step 2 |
| D-5 | Quota mid-task pushes WIP and sends `task.quota_exhausted`, so the hub can move the task down its fallback chain (criterion 3) | Task 10, Task 17 step 4, Task 18 |
| D-6 | Rework on the same branch, with the existing PR reused (criterion 4) | Task 7, Task 18 |
| D-7 | No task runs twice or is lost across reconnects, revokes and restarts (criterion 2, worker side) | Tasks 9, 11, 17 |
| D-8 | `start`, `stop`, `status`, `logs`, `doctor` and `update` work, with state kept per agent id | Tasks 12–13 |
| D-9 | hub-mcp serves `worker.mjs` and `worker.version`, from the Docker image too, and forwards WebSocket close codes | Tasks 14–15 |
| D-10 | `run-agent.sh` and `run-agent.ps1` install and run the worker on macOS, Linux and Windows. `cortex-agent.sh/.ps1` print a deprecation notice | Task 16, Task 18 Windows checklist |
| D-11 | W1–W7 each fixed, with a test | Spec coverage table below |
| D-12 | `pnpm build && pnpm typecheck && pnpm lint` and both packages' test suites pass | Task 18 steps 4 and 6 |

## Rollout and rollback

- **Additive only:**
  - Nothing in A2 removes a route, a message type or a script.
  - `cortex-agent.sh/.ps1` keep working. The hub still sends their flat `taskId/title/description` copy (spec §9), and they only receive tasks with a null `executor`, because they register no engines.
  - Users move over by re-running the one-line installer.
- **Mixed versions:**
  - **New worker, old hub:**
    - The bootstrap gets a 404 on `/conductor/worker.mjs` and stops with "upgrade the hub".
    - A cached bundle against an old hub registers with `protocol: 2`, which an old hub ignores. `doctor` reports the version mismatch.
  - **Old worker, new hub:** spec §9.
- **Rollback:**
  - Reverting A2's commits removes the two hub-mcp routes and the bundle. Workers then fall back to their cached bundle, or users run `cortex-agent.sh` again.
  - The close-code forwarding in `node.ts` stands alone and can be reverted on its own.
  - No data migration is involved; the worker's only state is `~/.cortex/worker/<agentId>/`.
- **Residual risks**, with what the plan does about them:
  - claude, codex and gemini quota formats are unverified, so their fixtures are synthetic. Unknown output is classified as `error`, never `quota`. The cost is a failure count, not a silent hang. Re-record when one is seen.
  - On Windows, agy may install as a `.cmd` shim. `spawnTracked` refuses an unsafe argv rather than mangling the prompt, and the Task 18 checklist records which shim was found.
  - A fresh worktree lacks `node_modules`, so repo hooks and tests can fail. `context.setupCommand` / `CORTEX_SETUP_CMD` handles this, and a failed setup is reported as `failed` with its output.
  - A1 may not answer a stale `activeTaskId` with `task.revoked`. Then the worker keeps the unconfirmed outcome and re-sends it only on `task.resumed`. The worst case is a duplicate `task.complete`, which A1 must treat as idempotent; this is recorded in the PR for A1.

## File Map

```
apps/conductor-worker/
  package.json, tsconfig.json, turbo.json, build.mjs
  src/
    cli.ts                 entry: parseCli + command dispatch
    version.ts             WORKER_VERSION (build-time define)
    paths.ts               ~/.cortex/worker/<agentId>/… layout
    state.ts               state.json (activeTaskId, unconfirmed outcome, last registration)
    logger.ts              file logger, redaction, rotation
    config.ts              hub URL + key detection (flags, env, MCP configs)
    process.ts             resolveCommand, spawnTracked, killTree, runShell, lastLines
    engines/types.ts       EngineAdapter, Classification, RunInput, RunOutput
    engines/quota.ts       parseResetsIn, agyModelScope
    engines/agy.ts, claude.ts, codex.ts, gemini.ts
    engines/index.ts       createAdapters, describeEngines
    engines/__fixtures__/  recorded agy output (sanitised) + synthetic others
    git.ts                 worktree, commit, push, PR / compare URL, sanitizeRemoteUrl
    prompt.ts              buildPrompt
    progress.ts            createProgressThrottle
    hub-client.ts          HubClient (ws, backoff, close codes, reliable queue, ping)
    runner.ts              runTask — one task end to end
    worker.ts              Worker — protocol state machine around runTask
    commands/daemon.ts     start --daemon, stop, status, logs
    commands/doctor.ts     runDoctor
    commands/update.ts     updateBundle
    e2e/worker.e2e.test.ts fake hub + fake agy + bare origin, through the built bundle
    e2e/hub.e2e.test.ts    opt-in, against a running A1 hub
apps/hub-mcp/src/worker-asset.ts   serveWorkerAsset (Node only)
apps/hub-mcp/src/ws-close.ts       forwardCloseCode
apps/hub-mcp/src/node.ts           wire both
infra/Dockerfile.hub-mcp           build + ship the bundle
scripts/run-agent.sh, run-agent.ps1        ~30-line bootstraps
scripts/cortex-agent.sh, cortex-agent.ps1  deprecation notice only
```

---

### Task 1: Package scaffold, bundle and version stamp

**Files:**
- Create:
  - `apps/conductor-worker/package.json`
  - `apps/conductor-worker/tsconfig.json`
  - `apps/conductor-worker/turbo.json`
  - `apps/conductor-worker/build.mjs`
  - `apps/conductor-worker/src/version.ts`
  - `apps/conductor-worker/src/cli.ts` (stub: `--version`, `help`)
  - `apps/conductor-worker/src/cli.test.ts`

**Interfaces:**
- Consumes: `CONDUCTOR_PROTOCOL_VERSION` from `@cortex/shared-types` (A1 Task 1).
- Produces:
  - `export const WORKER_VERSION: string`. It is `__WORKER_VERSION__` when bundled, else `'0.0.0-dev'`.
  - `export function parseCli(argv: string[]): CliArgs | { error: string }`, stubbed now and extended in Task 12.
  - `export async function main(argv: string[]): Promise<number>`, which returns the exit code.
  - Build artifacts `dist/cortex-worker.mjs` and `dist/cortex-worker.version`.

**Package decisions:**
- **`package.json`:**
  - `"type": "module"`.
  - `"bin": {"cortex-worker": "dist/cortex-worker.mjs"}`.
  - `"engines": {"node": ">=20"}`.
  - Scripts:
    - `build: node build.mjs`
    - `typecheck: tsc --noEmit`
    - `lint: eslint src/`
    - `test: vitest run --passWithNoTests`
    - `clean: rm -rf dist`
  - Everything sits in `devDependencies`, because all of it is bundled:
    - `@cortex/shared-types: workspace:*`
    - `ws ^8.18.0`, `@types/ws ^8.18.1`
    - `smol-toml ^1.3.0`
    - `esbuild ^0.27.0`
    - `typescript ^5.7.0`, `vitest ^3.0.0`, `@types/node ^22.0.0`
  - This keeps the hub-mcp prod image free of them.
- **`tsconfig.json`:** extends `../../tsconfig.json`, with `"noEmit": true`, `"include": ["src"]`, `"types": ["node"]`.
- **`turbo.json`:** turbo 2.8 runs in strict env mode, so an undeclared `APP_VERSION` would be filtered out and a cached bundle would survive a `version.json` bump:
  ```json
  { "extends": ["//"], "tasks": { "build": {
      "inputs": ["src/**", "build.mjs", "package.json", "$TURBO_ROOT$/version.json"],
      "env": ["APP_VERSION"], "outputs": ["dist/**"] } } }
  ```
- **`build.mjs`:**
  - Version: `process.env.APP_VERSION || JSON.parse(readFileSync('../../version.json')).version`, the same rule dashboard-api uses for `hubVersion`.
  - esbuild settings: `entryPoints: ['src/cli.ts']`, `bundle`, `platform: 'node'`, `format: 'esm'`, `target: 'node20'`, `outfile: 'dist/cortex-worker.mjs'`, `define: { __WORKER_VERSION__: JSON.stringify(version) }`, `external: ['bufferutil', 'utf-8-validate']`.
  - The `banner.js` contains:
    - `#!/usr/bin/env node`
    - `import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);`
  - Why ESM needs the banner: `ws` is CommonJS and calls `require('events')` and similar. Without the banner, an ESM bundle throws "Dynamic require of … is not supported". The optional native add-ons stay external, and `ws` already wraps their `require` in try/catch.
  - Finally, write `dist/cortex-worker.version` (version + `\n`).

- [ ] **Step 1: Write the failing test** `src/cli.test.ts`:
  - `parseCli(['--version'])` returns `{ command: 'version' }`.
  - `parseCli([])` returns `{ command: 'help' }`.
  - `parseCli(['bogus'])` returns `{ error: /unknown command/ }`.
  - `WORKER_VERSION` is `'0.0.0-dev'` under vitest.
- [ ] **Step 2: Run** `pnpm install && pnpm --filter @cortex/conductor-worker exec vitest run src/cli.test.ts`. Expect FAIL: module not found.
- [ ] **Step 3: Implement**:
  - `version.ts`: `declare const __WORKER_VERSION__: string | undefined`, guarded by `typeof`.
  - `cli.ts`: `parseCli`, plus `main` printing `WORKER_VERSION` for `version`/`--version`. It ends with `if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main(process.argv.slice(2))`.
  - The package files listed above.
- [ ] **Step 4: Run** the test and expect PASS. Then:
  - `pnpm --filter @cortex/conductor-worker build && node apps/conductor-worker/dist/cortex-worker.mjs --version` prints `0.9.10`, the value in `version.json`.
  - `APP_VERSION=1.2.3 pnpm --filter @cortex/conductor-worker build --force && node apps/conductor-worker/dist/cortex-worker.mjs --version` prints `1.2.3`.
  - `cat apps/conductor-worker/dist/cortex-worker.version` matches.
  - `node -e "import('./apps/conductor-worker/dist/cortex-worker.mjs')"` raises no "Dynamic require" error.
- [ ] **Step 5: Commit** `git add apps/conductor-worker pnpm-lock.yaml && git commit -m "feat(worker): scaffold @cortex/conductor-worker with versioned single-file bundle"`

### Task 2: Configuration detection

**Files:**
- Create:
  - `apps/conductor-worker/src/config.ts`
  - `apps/conductor-worker/src/config.test.ts`
  - fixtures under `src/__fixtures__/config/`:
    - `claude.json`
    - `codex-remote.toml`
    - `codex-url.toml`
    - `agy-mcp-remote.json`
    - `cursor.json`
    - `windsurf-serverurl.json`

**Interfaces:**
- Consumes: `smol-toml` `parse`.
- Produces:
  ```ts
  export interface McpEntry { url: string; apiKey: string | null; source: string }
  export interface HubConfig { hubBase: string; mcpUrl: string; wsUrl: string; apiKey: string; source: { hub: string; key: string } }
  export interface DetectInput {
    flags: { hub?: string; apiKey?: string }
    env: NodeJS.ProcessEnv; homeDir: string; repoPath: string
  }
  export function hubBaseFromUrl(url: string): string          // trims trailing '/', then a trailing '/mcp'
  export function wsUrlFromHubBase(base: string): string       // http→ws, https→wss, + '/ws/conductor'
  export function entryFromServer(server: unknown, env: NodeJS.ProcessEnv, source: string): McpEntry | null
  export function readClaudeJson(file: string, repoPath: string, env: NodeJS.ProcessEnv): McpEntry | null
  export function readCodexToml(file: string, env: NodeJS.ProcessEnv): McpEntry | null
  export function readMcpJson(file: string, env: NodeJS.ProcessEnv, source: string): McpEntry | null
  export function detectHubConfig(input: DetectInput): HubConfig | { error: string }
  ```

**Rules:**
- **Server entry name:** `cortex-hub`, and in TOML both `[mcp_servers.cortex-hub]` and `[mcp_servers."cortex-hub"]`.
- **Remote form:** `url` (Claude Code, Codex), `serverUrl` (Windsurf, agy), or `httpUrl` (Gemini).
- **Remote form key:** `headers.Authorization` / `http_headers.Authorization` of the form `Bearer <tok>`. Codex may instead give `bearer_token_env_var`, read from `env`.
- **mcp-remote form:**
  - The URL is the first `args` item matching `^https?://`; the old script read `args[2]` only (W6).
  - The key comes from `env.HUB_API_KEY`, else from a `--header` value `Authorization: Bearer <tok>`.
  - `${VAR}` placeholders resolve from the entry's `env`, then from `process.env`.
- **File order:**
  1. `~/.claude.json`: `projects[<realpath repoPath>].mcpServers` first, then top-level `mcpServers`.
  2. `~/.codex/config.toml`.
  3. `~/.gemini/antigravity/mcp_config.json`.
  4. `~/.cursor/mcp.json`.
- **Precedence**, resolved field by field:
  - The hub URL comes from `flags.hub`, then `CORTEX_HUB_URL`, then the first config entry.
  - The key comes from `flags.apiKey`, then `CORTEX_API_KEY`, then a config entry **whose `hubBase` equals the chosen `hubBase`**. A key is never sent to a hub it was not configured for.
  - Missing URL or key returns `{ error }`, naming what to pass.
- **Unreadable or malformed JSON/TOML:** skip that file and continue. Never throw.

- [ ] **Step 1: Write failing tests** (`config.test.ts`; fixtures use placeholder keys like `ctx_test_key_1`):
  - `hubBaseFromUrl` strips `/mcp` and a trailing slash, and leaves `https://h.example` unchanged.
  - `wsUrlFromHubBase('https://h.example')` gives `wss://h.example/ws/conductor`, and `http://localhost:8318` gives `ws://localhost:8318/ws/conductor`.
  - `reads the Claude Code url+headers form` (top-level `{type:'http', url, headers:{Authorization:'Bearer k'}}`).
  - `prefers the per-project entry in ~/.claude.json for the repo path`.
  - `reads the mcp-remote form with the url at any args index and HUB_API_KEY from env` (`args: ['-y','mcp-remote','https://h/mcp','--header','Authorization: Bearer ${HUB_API_KEY}']`).
  - `reads Codex [mcp_servers.cortex-hub] with a [.env] sub-table` and `reads Codex url + http_headers` and `reads Codex bearer_token_env_var`.
  - `accepts serverUrl and httpUrl aliases`.
  - `flags beat env beat config` for both the URL and the key.
  - `does not use a config key for a different hub`: with `flags.hub = B` and a config key for A, the result is `{ error: /api key/ }`.
  - `skips malformed JSON and keeps looking`.
- [ ] **Step 2: Run** `pnpm --filter @cortex/conductor-worker exec vitest run src/config.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** the signatures above. Paths are built from `input.homeDir` and never from `os.homedir()` directly.
- [ ] **Step 4: Run** the same command. Expect PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(worker): detect hub url and key from flags, env and every MCP config form"`

### Task 3: Paths, state file and logger

**Files:**
- Create:
  - `src/paths.ts`, `src/state.ts`, `src/logger.ts`
  - `src/paths.test.ts`, `src/state.test.ts`, `src/logger.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface WorkerPaths { root: string; home: string; pidFile: string; logFile: string; stateFile: string; stopFile: string; worktrees: string }
  export function workerRoot(homeDir: string): string                  // <home>/.cortex/worker
  export function workerPaths(agentId: string, homeDir: string): WorkerPaths
  export function worktreePath(p: WorkerPaths, taskId: string): string  // <home>/wt/<taskId>
  export function sanitizeAgentId(raw: string): string                 // [a-z0-9._-], max 64
  export function defaultAgentId(hostname: string, repoPath: string): string // `${host}-${basename(repo)}`

  export interface WorkerState {
    activeTaskId: string | null
    unconfirmed: { taskId: string; msg: TaskCompleteMsg | TaskQuotaExhaustedMsg } | null
    lastRegistered: { projectId: string | null; hubVersion: string; at: string } | null
  }
  export function readState(file: string): WorkerState     // missing/corrupt → empty state
  export function writeState(file: string, s: WorkerState): void  // tmp + rename

  export interface Logger { info(m: string): void; warn(m: string): void; error(m: string): void; addSecret(s: string): void }
  export function redact(text: string, secrets: readonly string[]): string
  export function createLogger(opts: { file?: string; stdout?: boolean; maxBytes?: number; now?: () => Date }): Logger
  ```
- Logger behaviour:
  - Lines look like `<ISO> <LEVEL> <msg>`.
  - Logs rotate at `maxBytes` (default 5 MB) to `worker.log.1`, keeping one old file.
  - `redact` replaces each secret and every `apiKey=<value>` with `***`.

- [ ] **Step 1: Write failing tests:**
  - `workerPaths('a1', '/h').pidFile === '/h/.cortex/worker/a1/worker.pid'`. Uses `path.join`, so the test compares with `path.join` too.
  - `two agent ids never share a pid, log or state file`.
  - `sanitizeAgentId('My Box/../x')` gives `'my-box-..-x'` with no path separators.
  - `readState returns the empty state for a missing or corrupt file`.
  - `writeState is atomic`: no `.tmp` is left behind, and the state round-trips.
  - `redact masks the api key and apiKey= query values` (Review Focus 3).
  - `logger rotates at maxBytes and keeps one old file`.
- [ ] **Step 2: Run** `pnpm --filter @cortex/conductor-worker exec vitest run src/paths.test.ts src/state.test.ts src/logger.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** the signatures above.
- [ ] **Step 4: Run** the same command. Expect PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(worker): per-agent paths, atomic state file and redacting logger"`

### Task 4: Process utilities (cross-platform spawn and kill)

**Files:**
- Create: `src/process.ts`, `src/process.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function resolveCommand(name: string, platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv): string | null
  export interface Tracked { pid: number; stdout: Readable; stderr: Readable; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> }
  export function spawnTracked(cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv; stdin?: string; platform?: NodeJS.Platform }): Tracked
  export function killTree(pid: number, platform?: NodeJS.Platform, graceMs?: number): Promise<void>
  export function runShell(command: string, cwd: string, opts?: { signal?: AbortSignal; timeoutMs?: number; env?: NodeJS.ProcessEnv }): Promise<{ exitCode: number; output: string; timedOut: boolean }>
  export function lastLines(text: string, n: number): string
  export function needsShell(resolved: string, platform: NodeJS.Platform): boolean   // .cmd / .bat on win32
  ```
- Rules:
  - **Resolving commands:** `resolveCommand` walks `PATH` and, on win32, tries each `PATHEXT` extension.
  - **Spawning on POSIX:** `spawnTracked` spawns with `detached: true`, which makes the child a process-group leader. It never uses a shell.
  - **Spawning on win32:**
    - Uses `windowsHide: true`.
    - Uses `shell: true` only when `needsShell`. Node ≥ 20.12 refuses `.cmd` without a shell.
    - In shell mode every arg must match `/^[\w.:\/=*@-]+$/`, else it throws `UnsafeShellArgError`.
    - Multi-line prompts therefore have to go on stdin (Task 6).
  - **Killing:**
    - POSIX: `killTree` sends `process.kill(-pid, 'SIGTERM')`, then `SIGKILL` after `graceMs` (default 10 s).
    - win32: `taskkill /PID <pid> /T /F`.
    - An `ESRCH` error counts as success.

- [ ] **Step 1: Write failing tests:**
  - `resolveCommand finds node on PATH`.
  - `resolveCommand tries PATHEXT on win32`: a temp dir holds `tool.CMD`, with `platform: 'win32'` and `env: { PATH: dir, PATHEXT: '.EXE;.CMD' }`.
  - `needsShell is true for .cmd/.bat on win32 only`.
  - `spawnTracked rejects shell metacharacters when a shell is required`.
  - `spawnTracked passes stdin and captures stdout`, using `node -e "process.stdin.pipe(process.stdout)"`.
  - `killTree kills the child and its grandchild` (skip on win32): a node parent spawns a sleeping node grandchild and prints its pid. After `killTree`, `process.kill(grandPid, 0)` throws `ESRCH` within 5 s.
  - `runShell returns exit code and combined output`.
  - `runShell times out and reports timedOut`.
  - `lastLines keeps the last n lines`.
- [ ] **Step 2: Run** `pnpm --filter @cortex/conductor-worker exec vitest run src/process.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** the signatures above.
- [ ] **Step 4: Run** the same command. Expect PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(worker): cross-platform command resolution, process-tree kill and shell runner"`

### Task 5: Engine contract and the agy adapter (verified)

**Files:**
- Create:
  - `src/engines/types.ts`, `src/engines/quota.ts`, `src/engines/agy.ts`
  - `src/engines/quota.test.ts`, `src/engines/agy.test.ts`
  - `src/engines/__fixtures__/agy/` containing:
    - `success.jsonl`
    - `quota.stdout.json`
    - `quota.stream.jsonl`
    - `quota.stderr.txt`
    - `invalid-model.stderr.txt`
    - `models.txt`

**Fixture rules:**
- Sources:
  - `success.jsonl` comes from `scratchpad/agy-probe/argon.jsonl`.
  - `quota.stdout.json` and `quota.stderr.txt` come from `sonnet.json` / `sonnet.err`, which exited 3.
  - `invalid-model.stderr.txt` comes from `bad.err`, which exited 1.
- Sanitising:
  - `conversation_id` and `error_id` become `00000000-0000-0000-0000-000000000000`.
  - `init.cwd` becomes `/work`.
  - `init.tools` is cut to three names.
- `quota.stream.jsonl` is **derived**: the probe recorded quota with `--output-format json`. It wraps the same payload in the `{"event":"result","result":{…}}` envelope seen in `argon.jsonl`. The classifier accepts both shapes.
- `models.txt` lists the 13 ids from spec §2, one per line. The exact `agy models` layout is not recorded, so the parser takes any trimmed token matching `/^[a-z0-9][a-z0-9.-]*-(low|medium|high)$|^[a-z0-9][a-z0-9.-]*$/`, skips header lines, and the test also feeds a bulleted variant.
- **Never** use `agy mcp list` output; it prints secrets.

**Interfaces:**
- Consumes: `Executor` from `@cortex/shared-types`; `spawnTracked`, `killTree`, `resolveCommand` (Task 4).
- Produces:
  ```ts
  export type Classification =
    | { kind: 'ok' }
    | { kind: 'quota'; resetAt?: string; modelScope?: string; raw: string }
    | { kind: 'error'; message: string }
  export interface RunInput { prompt: string; cwd: string; model: string | null; effort: string | null; signal: AbortSignal; timeoutMs: number; onLine: (line: string) => void }
  export interface RunOutput { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; aborted: boolean }
  export interface EngineAdapter {
    readonly executor: Executor
    detect(): Promise<{ found: boolean; path?: string; version?: string }>
    models(): Promise<string[]>                               // may contain '*'
    defaultModel(): string | null
    buildArgs(i: { prompt: string; model: string | null; effort: string | null }, platform: NodeJS.Platform): { args: string[]; stdin?: string }
    run(input: RunInput): Promise<RunOutput>
    classify(exitCode: number | null, stdout: string, stderr: string, ctx?: { model: string | null; now?: Date }): Classification
    progressText(line: string): string | null                  // human text from one stdout line
    summary(stdout: string): string                            // final answer, ≤ 4 000 chars
  }
  export function parseResetsIn(text: string, now: Date): string | undefined   // 'Resets in 89h3m4s' → ISO
  export function agyModelScope(model: string | null): string | undefined      // 'claude-sonnet-5-5-low' → 'claude-sonnet-5-5-*'
  export function createAgyAdapter(opts?: { bin?: string; mode?: string; printTimeout?: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv }): EngineAdapter
  ```
- agy behaviour:
  - **Binary:** `opts.bin ?? env.CORTEX_AGY_BIN ?? resolveCommand('agy')`.
  - **Args:** `['-p', prompt, '--output-format', 'stream-json', '--mode', mode]`, then `--model m` if set, `--effort e` if set, and `--print-timeout t` if set. W2: the old script ran `antigravity -p --yolo`.
  - **Mode:** `opts.mode ?? env.CORTEX_AGY_MODE ?? (platform === 'win32' ? 'accept-edits' : 'auto')`.
  - **Classify:**
    - Exit 0 with a `result.status === 'SUCCESS'` gives `ok`.
    - It returns `quota` when any of these holds:
      - exit 3
      - `result.status === 'ERROR'` with `/quota/i` in the error
      - `AGY_ERROR` JSON with `status: 'RESOURCE_EXHAUSTED'` or `error_code: 429`
    - A quota result gets `resetAt` from `parseResetsIn`, `modelScope` from `agyModelScope(ctx.model)`, and `raw` from the first 2 000 chars of the stderr+error text.
    - Everything else is `error`, with the `result.error` or stderr first line.
  - **progressText:** a `step_update` with `text_delta` gives the trimmed delta; `init` gives `agy started (<model>)`; other events give null.
  - **summary:** `result.response`.

- [ ] **Step 1: Write failing tests:**
  - `quota.test.ts`:
    - `parseResetsIn('… Resets in 89h3m4s.', t0)` equals `t0 + 89h3m4s` (ISO).
    - It also handles `45m`, `3s` and `1h`, and returns `undefined` when there is no match.
    - `agyModelScope` returns `claude-sonnet-5-5-*` for `claude-sonnet-5-5-low`, `gemini-4-argon-*` for `gemini-4-argon-high`, and `undefined` for `null` and for `my-model`.
  - `agy.test.ts`:
    - `classifies the recorded success as ok`.
    - `classifies the recorded quota (json and stream-json) as quota with resetAt and modelScope`: given `now`, `resetAt` = now + 89h3m4s and `modelScope` = `claude-sonnet-5-5-*`.
    - `classifies an AGY_ERROR 429 on stderr with an unknown exit code as quota`.
    - `classifies the recorded invalid model (exit 1) as error, never quota`.
    - `classifies unknown output with exit 2 as error`.
    - `buildArgs uses --mode auto on darwin/linux and accept-edits on win32`.
    - `buildArgs omits --model/--effort when null`.
    - `CORTEX_AGY_MODE overrides the mode`.
    - `progressText extracts text_delta`.
    - `summary returns result.response`.
    - `models() parses models.txt including a bulleted variant`, using a fake bin that prints the fixture.
- [ ] **Step 2: Run** `pnpm --filter @cortex/conductor-worker exec vitest run src/engines/quota.test.ts src/engines/agy.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** the signatures above:
  - `run()` spawns with `spawnTracked`, splits stdout into lines for `onLine`, and kills the tree on `signal` abort or on `timeoutMs`.
  - `detect()` runs `agy --version`.
- [ ] **Step 4: Run** the same command. Expect PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(worker): engine adapter contract and agy adapter with recorded quota fixtures"`

### Task 6: claude, codex and gemini adapters, plus the engine registry

**Files:**
- Create:
  - `src/engines/claude.ts`, `src/engines/codex.ts`, `src/engines/gemini.ts`, `src/engines/index.ts`
  - `src/engines/claude.test.ts`, `src/engines/codex.test.ts`, `src/engines/gemini.test.ts`, `src/engines/index.test.ts`
  - `src/engines/__fixtures__/{claude,codex,gemini}/synthetic-*.txt`. These are clearly named synthetic, because §11 lists these quota formats as unverified.

**Interfaces:**
- Consumes: `EngineAdapter` (Task 5), `resolveCommand` (Task 4), `EngineInfo` and `Executor` from `@cortex/shared-types`.
- Produces:
  ```ts
  export function createClaudeAdapter(opts?: { bin?: string; models?: string[]; env?: NodeJS.ProcessEnv }): EngineAdapter
  export function createCodexAdapter(opts?: { bin?: string; models?: string[]; env?: NodeJS.ProcessEnv }): EngineAdapter
  export function createGeminiAdapter(opts?: { bin?: string; models?: string[]; env?: NodeJS.ProcessEnv }): EngineAdapter
  export function createAdapters(names: Executor[], env?: NodeJS.ProcessEnv): EngineAdapter[]
  export async function describeEngines(adapters: EngineAdapter[]): Promise<{ available: EngineAdapter[]; engines: EngineInfo[]; defaultExecutor: Executor | null }>
  ```
- **Prompt delivery:** these three CLIs install as npm `.cmd` shims on Windows. cmd.exe cannot pass a multi-line prompt and caps a command line at 8 191 chars. So all three take the prompt on **stdin**, on every OS, giving one code path. The spec shows the prompt as an argument, which is the deviation.

| Executor | args | stdin | quota (best effort) | resetAt |
|---|---|---|---|---|
| claude | `-p --output-format stream-json --verbose --permission-mode auto` + `--model m` (W3) | prompt | `/usage limit\|rate limit\|hit your limit/i` in a `result` event with `is_error` or on stderr | `\|(\d{10})` epoch → ISO, else undefined (hub defaults to now + 1 h) |
| codex | `exec --full-auto` + `-m m` + `-c model_reasoning_effort=<e>` when effort, then `-` | prompt | `/usage limit\|429\|rate limit/i` | undefined |
| gemini | `-y` + `-m m` + `-p "Carry out the task given on stdin."` | prompt | `/RESOURCE_EXHAUSTED\|\b429\b/` | `parseResetsIn` if present |

- **Shared rules:**
  - **Binary override:** `CORTEX_<EXECUTOR>_BIN`, for example `CORTEX_CLAUDE_BIN`.
  - **Models:** `models()` returns `opts.models ?? env.CORTEX_<EXECUTOR>_MODELS?.split(',') ?? ['*']`.
  - **Classification:** exit 0 gives `ok`. A matched quota gives `quota`, and anything else is `error`. Unknown output is never quota (§6.12).
- **`describeEngines`:**
  - Keeps the adapters whose `detect().found` is true, in the order of `names`.
  - `defaultExecutor` is the first available one.
  - `engines[i]` is `{ executor, models: await models(), defaultModel }`.
  - A `models()` failure yields `['*']`.

- [ ] **Step 1: Write failing tests:**
  - For each adapter:
    - `buildArgs puts the prompt on stdin, never in args`.
    - `buildArgs passes --model / -m only when set`.
    - `classifies the synthetic quota text as quota`.
    - `classifies unknown failure as error`.
    - `classifies exit 0 as ok`.
  - `claude progressText reads assistant text and tool_use names from stream-json`.
  - `claude summary reads the result event`.
  - `claude resetAt parses an epoch suffix`.
  - `codex -c model_reasoning_effort only when effort set`.
  - `index.test.ts`:
    - `describeEngines keeps detected adapters in requested order and picks the first as default`, using fake adapters.
    - `describeEngines reports ['*'] when models() throws`.
    - `createAdapters honours CORTEX_<X>_BIN`.
- [ ] **Step 2: Run** `pnpm --filter @cortex/conductor-worker exec vitest run src/engines`. Expect FAIL.
- [ ] **Step 3: Implement** the signatures and table above.
- [ ] **Step 4: Run** the same command. Expect PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(worker): claude, codex and gemini adapters with stdin prompts and engine registry"`

### Task 7: Git flow

**Files:**
- Create:
  - `src/git.ts`, `src/git.test.ts`
  - `src/test-utils/git-fixture.ts`, a helper reused by Tasks 10, 11 and 17:
    - it builds a temp bare `origin.git` with `main` holding `README.md`;
    - it clones it to `repo/`;
    - `cleanup()` removes both.

**Interfaces:**
- Consumes: `spawnTracked` / `runShell` (Task 4).
- Produces:
  ```ts
  export type GitRun = (args: string[], opts: { cwd: string; input?: string }) => Promise<{ code: number; stdout: string; stderr: string }>
  export type GhRun = (args: string[], opts: { cwd: string; input?: string }) => Promise<{ code: number; stdout: string; stderr: string }>
  export const git: GitRun                                   // spawns 'git', no shell
  export function createGh(bin?: string): GhRun              // CORTEX_GH_BIN ?? 'gh'; missing binary → code 127
  export function sanitizeRemoteUrl(url: string): string
  export async function originUrl(repo: string): Promise<string | null>
  export class BranchInUseError extends Error { constructor(public branch: string, public path: string) }
  export async function branchCheckedOutAt(repo: string, branch: string, ownDir: string): Promise<string | null>  // path from `git worktree list --porcelain`, ignoring ownDir
  export async function prepareWorktree(repo: string, dir: string, branch: string, baseBranch: string): Promise<{ from: 'branch' | 'base' | 'existing' }>
  export async function commitAll(dir: string, message: string, fallbackIdentity: { name: string; email: string }): Promise<string | null>
  export async function pushBranch(dir: string, branch: string): Promise<void>
  export function compareUrl(remote: string, baseBranch: string, branch: string): string | undefined
  export async function openPullRequest(dir: string, p: { branch: string; baseBranch: string; title: string; body: string; remote: string }, gh: GhRun): Promise<{ prUrl?: string; compareUrl?: string }>
  export async function removeWorktree(repo: string, dir: string): Promise<void>
  ```
- Rules (W7: nothing did git):
  - **prepareWorktree:**
    - Runs `git fetch origin --prune` and `git worktree prune`.
    - If `dir` is already a registered worktree on `branch`, it returns `existing`, keeping local changes. This is the resume after a crash.
    - Otherwise it runs `git worktree add -B <branch> <dir> origin/<branch>` when `refs/remotes/origin/<branch>` exists (`branch`), else from `origin/<baseBranch>` (`base`).
    - If the base is missing too, it throws `Error('base branch <b> not found on origin')`.
    - If git reports the branch is checked out at another path, it throws `BranchInUseError`.
  - **commitAll:**
    - Runs `git add -A`. A clean `git status --porcelain` returns `null`.
    - It commits with `-F -`, the message on stdin, so no shell quoting is involved. There is no `--no-verify`.
    - When `user.email` is unset it adds `-c user.name=… -c user.email=…`.
    - A failing hook throws with the hook output.
  - **pushBranch:** runs `git push -u origin <branch>`. A rejection throws with the stderr. It never force-pushes.
  - **compareUrl:**
    - GitHub https and ssh (`git@github.com:o/r(.git)`) give `https://github.com/o/r/compare/<base>...<branch>?expand=1`.
    - GitLab gives `https://<host>/<path>/-/merge_requests/new?merge_request[source_branch]=<branch>`.
    - Anything else gives `undefined`.
    - The URL is built from the sanitised remote.
  - **openPullRequest:**
    - If `gh auth status` exits 0, it runs `gh pr create --base --head --title --body-file -`.
    - On "already exists", it runs `gh pr view <branch> --json url -q .url`.
    - Otherwise it returns `{ compareUrl }`.
  - **removeWorktree:** runs `git worktree remove --force <dir>`. The branch stays.

- [ ] **Step 1: Write failing tests**, against the git fixture and real git:
  - `sanitizeRemoteUrl strips userinfo from https and keeps ssh` (Review Focus 3).
  - `prepareWorktree creates the branch from origin/<baseBranch> when the task branch is new`.
  - `prepareWorktree starts from origin/<branch> when it exists`: a commit pushed to the branch is present in the worktree.
  - `prepareWorktree reuses an existing worktree for the same task` (Review Focus 5): an uncommitted file survives and the result is `from: 'existing'`.
  - `prepareWorktree throws BranchInUseError when the branch is checked out elsewhere` (Review Focus 5): the fixture's `repo/` has the branch checked out.
  - `prepareWorktree fails clearly when the base branch is missing`.
  - `branchCheckedOutAt returns the user's checkout path and ignores the worker's own worktree`.
  - `commitAll returns null on a clean tree`.
  - `commitAll uses the fallback identity when none is configured`: `HOME` points at a temp dir with no gitconfig.
  - `commitAll runs the repo's pre-commit hook and surfaces its failure`.
  - `pushBranch never forces and reports a rejected push`: another clone pushes to the branch first.
  - `compareUrl handles github https, github ssh, gitlab, and unknown hosts`.
  - `openPullRequest uses gh when authenticated`: a fake `GhRun` records the args.
  - `openPullRequest returns the existing PR url when gh reports one already exists` (Review Focus 4).
  - `openPullRequest falls back to the compare URL when gh auth status fails`.
  - `removeWorktree keeps the branch`.
- [ ] **Step 2: Run** `pnpm --filter @cortex/conductor-worker exec vitest run src/git.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** the signatures above and `src/test-utils/git-fixture.ts`.
- [ ] **Step 4: Run** the same command. Expect PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(worker): git worktree, commit, push and PR flow"`

### Task 8: Prompt builder and progress throttle

**Files:**
- Create: `src/prompt.ts`, `src/progress.ts`, `src/prompt.test.ts`, `src/progress.test.ts`

**Interfaces:**
- Consumes: `AssignedTask` from `@cortex/shared-types`.
- Produces:
  ```ts
  export const PROMPT_LIMIT = 24_000   // under Windows' 32 767-char CreateProcess limit for agy's argv prompt
  export function buildPrompt(task: AssignedTask, opts?: { resumed?: boolean }): string
  export function createProgressThrottle(send: (message: string) => void, opts?: { intervalMs?: number; maxLen?: number; now?: () => number }): { push(line: string): void; stop(): void }
  ```
- **Prompt sections, in order:**
  1. `# <key>: <title>`.
  2. The description. A title-only task still yields a valid prompt; W1 dropped those.
  3. `## Files` when `files` is non-empty.
  4. `## Previous review feedback`, newest first, with `by` and the verdict.
  5. `## Handoff from the previous run` with the note, when there is a handoff.
  6. `## Resuming`, when `resumed`.
  7. `## Rules`, containing "Do not commit, push, or switch branches; the worker does that." and "Stay inside this working tree."
- **Over `PROMPT_LIMIT`:** the description is trimmed first, then the oldest reviews, and `[truncated]` is appended. Rules are never trimmed.
- **Throttle:**
  - The first line is sent at once.
  - After that, at most one message every `intervalMs` (default 5 000), and it is the **latest** line (trailing).
  - Lines are capped at `maxLen` (300) and empty lines are ignored.
  - `stop()` cancels the timer.

- [ ] **Step 1: Write failing tests:**
  - `includes title, description, files, reviews, handoff and rules`.
  - `works for a title-only task`.
  - `rules survive truncation and the result is ≤ PROMPT_LIMIT`.
  - `uses the id when key is null`.
  - With `vi.useFakeTimers()`:
    - `sends the first line immediately`.
    - `sends at most one line per 5 s and it is the latest`.
    - `ignores blank lines and caps length`.
    - `stop cancels the pending send`.
- [ ] **Step 2: Run** `pnpm --filter @cortex/conductor-worker exec vitest run src/prompt.test.ts src/progress.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** the signatures above.
- [ ] **Step 4: Run** the same command. Expect PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(worker): task prompt builder and 5-second progress throttle"`

### Task 9: Hub client

**Files:**
- Create: `src/hub-client.ts`, `src/hub-client.test.ts`, plus a local `ws` `WebSocketServer` on port 0 in the test.

**Interfaces:**
- Consumes: `ws`, `Logger` (Task 3), and these protocol types: `WorkerRegisterMsg`, `WorkerToHubMsg`, `HubToWorkerMsg`, `RegisteredMsg`, `TaskCompleteMsg`, `TaskQuotaExhaustedMsg`, `TaskDeclineMsg`, `TaskAcceptMsg`.
- Produces:
  ```ts
  export type FatalReason = 'missing-key' | 'bad-key' | 'replaced' | 'agent-in-use'
  export function classifyClose(code: number): FatalReason | null      // 4001, 4003, 4000, 4009
  export function backoffDelay(attempt: number, baseMs?: number, maxMs?: number, rand?: () => number): number  // 1 s · 2^n, cap 60 s, ±20 % jitter
  export function buildWsUrl(wsUrl: string, q: { apiKey: string; agentId: string; hostname: string }): string
  export interface HubClientOptions {
    wsUrl: string; apiKey: string; agentId: string; hostname: string
    register: () => WorkerRegisterMsg           // rebuilt on every connect (fresh activeTaskId)
    onRegistered: (m: RegisteredMsg) => void
    onMessage: (m: Exclude<HubToWorkerMsg, RegisteredMsg>) => void
    onFatal: (reason: FatalReason, detail: string) => void
    logger: Logger; pingMs?: number; backoff?: { baseMs: number; maxMs: number }
  }
  export class HubClient {
    constructor(opts: HubClientOptions)
    start(): void
    send(msg: WorkerToHubMsg): boolean          // drops when not registered (progress)
    sendReliable(msg: TaskAcceptMsg | TaskCompleteMsg | TaskQuotaExhaustedMsg | TaskDeclineMsg): void // queued until next 'registered'
    stop(): Promise<void>
    get registered(): boolean
  }
  ```
- Rules:
  - **Connecting:**
    - The key is sent both as the `?apiKey=` query and as `Authorization: Bearer`. The proxy forwards only the query string to dashboard-api, which checks it.
    - `handshakeTimeout` is 15 s.
    - On `open`, the client sends `register()`.
  - **On `registered`:** reset the backoff, flush the reliable queue in order, then call `onRegistered`.
  - **Bad input:** malformed JSON and unknown `type` values are logged and ignored.
  - **Fatal failures**, which stop reconnecting and call `onFatal`:
    - close codes 4001, 4003, 4000 and 4009;
    - an `unexpected-response` with HTTP 401 or 403 is `bad-key`.
  - **Anything else** reconnects with `backoffDelay`.
  - **Liveness:** a ping every `pingMs` (30 s). No pong within 2 × `pingMs` terminates the socket and reconnects.

- [ ] **Step 1: Write failing tests:**
  - `sends worker.register with protocol 2 on open`.
  - `the url carries apiKey, agentId and hostname, and the Authorization header is set`.
  - `reconnects with backoff after a 1006 close and re-sends a fresh register`.
  - `backoffDelay doubles, caps at 60 s and stays within ±20 %`.
  - `stops and reports agent-in-use on 4009`, and similarly `replaced on 4000`, `bad-key on 4003`, and `missing-key on 4001`.
  - `treats an HTTP 401 handshake as bad-key and stops reconnecting` (Review Focus 1): the server rejects in `verifyClient` with 401.
  - `queues reliable messages while disconnected and flushes them after registered, in order`.
  - `drops progress while disconnected`.
  - `ignores malformed JSON and unknown types`.
  - `terminates and reconnects when pongs stop`: fake timers, and a server with `autoPong` disabled.
- [ ] **Step 2: Run** `pnpm --filter @cortex/conductor-worker exec vitest run src/hub-client.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** the signatures above.
- [ ] **Step 4: Run** the same command. Expect PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(worker): hub client with backoff, close-code policy and reliable queue"`

### Task 10: Task runner (one task end to end)

**Files:**
- Create: `src/runner.ts`, `src/runner.test.ts`

**Interfaces:**
- Consumes:
  - `prepareWorktree`, `commitAll`, `pushBranch`, `openPullRequest`, `removeWorktree`, `BranchInUseError` (Task 7)
  - `buildPrompt`, `createProgressThrottle` (Task 8)
  - `runShell`, `lastLines` (Task 4)
  - `EngineAdapter` (Task 5)
  - `worktreePath` (Task 3)
- Produces:
  ```ts
  export interface RunnerDeps {
    repo: string; remote: string; paths: WorkerPaths
    adapter: EngineAdapter
    send: (m: TaskProgressMsg) => void
    sendReliable: (m: TaskAcceptMsg | TaskCompleteMsg | TaskQuotaExhaustedMsg | TaskDeclineMsg) => void
    gh: GhRun; logger: Logger; env: NodeJS.ProcessEnv
    engineTimeoutMs: number; identity: { name: string; email: string }; now?: () => Date
  }
  export type RunOutcome =
    | { kind: 'completed' | 'failed'; msg: TaskCompleteMsg }
    | { kind: 'quota'; msg: TaskQuotaExhaustedMsg }
    | { kind: 'declined'; reason: string }
    | { kind: 'aborted'; reason: 'revoked' | 'stopping' }
  export async function runTask(task: AssignedTask, deps: RunnerDeps, signal: AbortSignal, opts?: { resumed?: boolean }): Promise<RunOutcome>
  export function commitTitle(task: AssignedTask): string    // `${key ?? id.slice(0, 8)}: ${first line of title}`
  ```
- **Sequence:** the worker accepts first (Task 11). `runTask` then:
  1. Prepares the worktree. A `BranchInUseError` returns `declined` with `branch-in-use: <path>`.
  2. Runs the optional setup command (`context.setupCommand ?? env.CORTEX_SETUP_CMD`). Fresh worktrees have no installed dependencies, which repo hooks and tests may need. A setup failure becomes `failed`.
  3. Runs the engine with `buildPrompt`, routing `onLine → progressText → throttle`.
  4. Classifies the result:
     - **quota:**
       - commit `WIP <key ?? id.slice(0, 8)>: quota handoff` if the tree is dirty;
       - push;
       - build the `TaskQuotaExhaustedMsg` with `executor`, `model: route.model ?? adapter.defaultModel() ?? 'default'`, `modelScope`, `resetAt`, `raw`, and `handoff {branch, commit|null, note}`;
       - remove the worktree.
     - **error / timeout:** `failed` with the error. Partial work is still committed as WIP and pushed, so it is not lost.
     - **ok:** continue.
  5. If a test command is set (`task.testCommand ?? env.CORTEX_TEST_CMD`), run it and keep `lastLines(output, 200)`. A non-zero exit becomes `failed`, with the error "tests failed (exit N)". Branch, commit and PR are still reported (decision: never complete red work).
  6. Commit as `commitTitle`. With no changes, the task fails with "engine made no changes", unless `context.allowEmpty === true`.
  7. Push, then `openPullRequest`. The body holds the summary, the task id, and the test tail in a fenced block.
  8. Return `completed` with `result {summary, prUrl?, branch, commit, testOutput?}`, and remove the worktree.
- **On abort:**
  - With `signal.reason` of `revoked` or `stopping`: kill the engine tree, commit `WIP …: <reason>` if dirty, push, remove the worktree, and return `aborted`. Nothing else is sent.
  - An abort that arrives during steps 6–7 lets git finish, then returns `aborted`.

- [ ] **Step 1: Write failing tests.** Use the git fixture, a fake `EngineAdapter` whose `run` writes or omits a file, and a fake `GhRun`:
  - `completes: commits '<key>: <title>', pushes, returns prUrl and test tail`.
  - `fails with 'engine made no changes' on a clean tree`.
  - `completes on a clean tree when context.allowEmpty is true`.
  - `fails when tests exit non-zero but still pushes and reports branch, commit and testOutput`.
  - `keeps only the last 200 test lines`.
  - `quota: pushes 'WIP <key>: quota handoff' and returns the handoff with commit sha`.
  - `quota on a clean tree returns handoff.commit null`.
  - `engine error returns failed with the classifier message`.
  - `engine timeout returns failed and kills the engine`.
  - `revoke aborts: engine killed, WIP pushed, no completion message`.
  - `declines with branch-in-use when the branch is checked out elsewhere`.
  - `runs the setup command before the engine and fails the task when it fails`.
  - `removes the worktree after every outcome, but keeps the branch`.
  - `progress is throttled`: fake timers, an engine emitting 50 lines in 1 s, and one `task.progress`.
- [ ] **Step 2: Run** `pnpm --filter @cortex/conductor-worker exec vitest run src/runner.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** `runTask` and `commitTitle`.
- [ ] **Step 4: Run** the same command. Expect PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(worker): task runner — worktree, engine, tests, commit, push, PR, quota handoff"`

### Task 11: Worker state machine

**Files:**
- Create: `src/worker.ts`, `src/worker.test.ts`

**Interfaces:**
- Consumes:
  - `runTask`, `RunOutcome` (Task 10)
  - `HubClient` (Task 9)
  - `readState` / `writeState` (Task 3)
  - `describeEngines` (Task 6)
  - `sanitizeRemoteUrl`, `branchCheckedOutAt` (Task 7)
  - `WORKER_VERSION`
- Produces:
  ```ts
  export interface WorkerDeps {
    agentId: string; hostname: string; repo: string; remote: string; capabilities: string[]
    adapters: EngineAdapter[]; engines: EngineInfo[]; defaultExecutor: Executor | null
    paths: WorkerPaths; logger: Logger
    send: (m: WorkerToHubMsg) => boolean; sendReliable: HubClient['sendReliable']
    run?: typeof runTask      // injectable for tests
  }
  export class Worker {
    constructor(deps: WorkerDeps)
    registerPayload(): WorkerRegisterMsg
    onRegistered(m: RegisteredMsg): void
    handle(m: TaskAssignedMsg | TaskRevokedMsg): void
    get busy(): boolean
    stop(): Promise<void>     // graceful: abort('stopping'), await outcome, keep activeTaskId
    idle(): Promise<void>     // resolves when no task is running (tests)
  }
  ```
- Rules:
  - **`registerPayload`:**
    - Builds `{type: 'worker.register', protocol: CONDUCTOR_PROTOCOL_VERSION, version: WORKER_VERSION, hostname, os: process.platform, repo: sanitizeRemoteUrl(remote), capabilities, engines, defaultExecutor}`.
    - Adds `activeTaskId` when a task is running, else `state.unconfirmed?.taskId`, else `state.activeTaskId`.
  - **`onRegistered`:**
    - Writes `lastRegistered` to state.
    - Warns once when `hubVersion !== WORKER_VERSION`: "hub is vX, worker is vY — run `cortex-worker update`".
    - Warns when `projectId === null`: "this repo's origin maps to no hub project".
  - **`task.assigned`:**
    - If a task is running, a different id gets `task.decline {reason: 'busy'}` (D2, W4). The same id is ignored and logged.
    - If `route.executor` is set and not among the available adapters, the task is declined with `executor <x> not available on <host>`.
    - If `branchCheckedOutAt(repo, branch, worktreePath(...))` returns a path, the task is declined with `branch-in-use: <path>` **before** accepting. Spec §6.5 does not say whether a decline after `task.accept` is valid, so the runner's own `BranchInUseError` path (a race) is only the fallback.
    - Otherwise, in order:
      1. Clear `unconfirmed` (the hub has moved on).
      2. `sendReliable(task.accept)`.
      3. `send(status.update busy)`.
      4. Persist `activeTaskId`.
      5. Run.
  - **`task.resumed`:**
    - For the task already running: ignore.
    - For `unconfirmed.taskId`: re-send the stored outcome message.
    - Otherwise, the same as `task.assigned` with `resumed: true`.
  - **`task.revoked`:**
    - For the running task: `abort('revoked')`.
    - For `unconfirmed` or `activeTaskId` in state: clear it.
    - Anything else is logged.
  - **Outcome handling:**
    - `completed`, `failed` and `quota`: `sendReliable(msg)`, store `unconfirmed = {taskId, msg}`, clear `activeTaskId`, then `send(status.update idle)` (W5: status was never sent).
    - `declined`: send the decline and clear state.
    - `aborted('stopping')`: keep `activeTaskId`, so the next start re-registers with it and gets `task.resumed` or `task.revoked`.
    - `aborted('revoked')`: clear state.
  - **Interface assumption on A1:** a register whose `activeTaskId` is no longer assigned to this worker is answered with `task.revoked` and changes no task state (§6.8).

- [ ] **Step 1: Write failing tests.** Use a fake `run` with a controllable promise, a fake send, and a temp state file:
  - `register payload carries protocol, version, sanitised repo, engines and activeTaskId`.
  - `declines a second task as busy while one runs` (W4).
  - `ignores a duplicate task.assigned for the running task`.
  - `declines when the route's executor is not available`.
  - `declines with branch-in-use before accepting when the branch is checked out elsewhere` (Review Focus 5): no `task.accept` is sent.
  - `forwards a runner 'declined' outcome as task.decline and clears state` (the race fallback).
  - `sends accept, busy, then complete and idle in order` (W5).
  - `ignores task.resumed for the task already running` (Review Focus 2).
  - `re-sends the stored outcome when the hub resumes a finished task` (Review Focus 2).
  - `clears the unconfirmed outcome on task.revoked` (Review Focus 2).
  - `aborts the running task on task.revoked and sends no completion`.
  - `stop keeps activeTaskId so the next start re-registers with it`.
  - `warns once on hub version mismatch and on a null projectId`.
- [ ] **Step 2: Run** `pnpm --filter @cortex/conductor-worker exec vitest run src/worker.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** `Worker`.
- [ ] **Step 4: Run** the same command. Expect PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(worker): one-task worker state machine with resume, revoke and busy decline"`

### Task 12: CLI commands — start, daemon, stop, status, logs, update, hub-url

**Files:**
- Modify: `src/cli.ts`, `src/cli.test.ts`
- Create:
  - `src/commands/daemon.ts`, `src/commands/update.ts`
  - `src/commands/daemon.test.ts`, `src/commands/update.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  ```ts
  export interface CliArgs {
    command: 'start' | 'stop' | 'status' | 'logs' | 'doctor' | 'update' | 'hub-url' | 'version' | 'help'
    daemon: boolean; follow: boolean; probe: boolean
    agentId?: string; repo?: string; engines?: Executor[]; capabilities?: string[]
    hub?: string; apiKey?: string; engineTimeoutMin?: number
  }
  export function parseCli(argv: string[]): CliArgs | { error: string }
  export async function startForeground(args: CliArgs): Promise<number>
  export function startDaemon(args: CliArgs, paths: WorkerPaths, scriptPath: string, argv: string[]): { pid: number } | { error: string }
  export function readPid(paths: WorkerPaths): number | null
  export function isAlive(pid: number): boolean
  export async function stopWorker(paths: WorkerPaths, opts?: { graceMs?: number; platform?: NodeJS.Platform }): Promise<'stopped' | 'killed' | 'not-running'>
  export function statusText(paths: WorkerPaths, state: WorkerState): string
  export async function printLogs(paths: WorkerPaths, opts: { follow: boolean; lines?: number; out?: NodeJS.WritableStream; signal?: AbortSignal }): Promise<void>
  export async function updateBundle(hubBase: string, target: string, current: string, fetchImpl?: typeof fetch): Promise<{ updated: boolean; version: string }>
  ```
- Rules:
  - **`parseCli`:**
    - Uses `node:util` `parseArgs` with `--daemon/-d`, `--follow/-f`, `--agent-id`, `--repo`, `--engines` (comma list validated against `EXECUTORS`), `--capabilities`, `--hub`, `--api-key`, `--engine-timeout` (minutes, default 90) and `--probe`.
    - The default for `--engines` is all four, in the order `agy,claude,codex,gemini`.
  - **`startForeground`:**
    1. Resolve the repo (`--repo`, default cwd) and its `originUrl`. A missing origin exits 1.
    2. Resolve the agent id: `--agent-id`, then `CORTEX_AGENT_ID`, then `defaultAgentId`.
    3. Run `detectHubConfig`.
    4. Refuse if the pid file points at a live process ("already running (pid N)").
    5. Write the pid file.
    6. Run `describeEngines`. With no engines, exit 1, naming the install commands.
    7. Wire `HubClient` and `Worker`.
    8. Poll for `stopFile` every 2 s, and also handle SIGINT/SIGTERM. Either one calls `worker.stop()`, then `client.stop()`, removes the pid and stop files, and exits 0.
    9. `onFatal` exits 2 with a fix hint:
       - `bad-key`: check the key.
       - `agent-in-use`: pass `--agent-id`.
       - `replaced`: another instance on this host took over.
  - **`startDaemon`:**
    - Spawns `process.execPath [scriptPath, 'start', ...argv without --daemon]` with `detached: true`, `windowsHide: true`, and `stdio: ['ignore', logFd, logFd]`, then calls `unref()`.
    - It waits until the pid file appears (5 s), then prints the pid and the log path.
  - **`stopWorker`:**
    - Writes `stopFile`, which is a graceful stop on every OS; Windows has no SIGTERM for detached processes.
    - It waits `graceMs` (default 90 s, enough for a WIP push), then calls `killTree`.
  - **`status`:** prints running/stopped, the pid, the agent id, `activeTaskId`, and `lastRegistered`.
  - **`logs`:** prints the last 200 lines. `-f` follows by polling the file size every 500 ms, until the signal fires or Ctrl-C.
  - **`update`:**
    - GETs `<hub>/conductor/worker.version`. If it equals the current version, nothing changes.
    - Otherwise it GETs `worker.mjs` into `<target>.tmp` and checks the file starts with `#!/usr/bin/env node`.
    - It renames the file over `target`, which is `process.argv[1]`.
    - It prints "restart the worker to use vX".
  - **`hub-url`:** prints the detected `hubBase`, or exits 1. The bootstraps use it.

- [ ] **Step 1: Write failing tests:**
  - `cli.test.ts`:
    - `parses start --daemon --agent-id a --engines claude,agy --capabilities x,y`.
    - `rejects an unknown engine`.
    - `defaults engines to agy,claude,codex,gemini`.
  - `daemon.test.ts`:
    - `startDaemon writes a pid and the child survives the parent`, spawning a tiny node script that writes the pid file and sleeps.
    - `start refuses when the pid file points at a live process`.
    - `stopWorker uses the stop file and returns 'stopped' when the process exits in time`.
    - `stopWorker kills the tree after graceMs and returns 'killed'`.
    - `stopWorker returns 'not-running' for a stale pid file`.
    - `printLogs prints the last 200 lines and follows appended lines`.
  - `update.test.ts`, with a local `http` server:
    - `no-op when versions match`.
    - `replaces the bundle atomically when newer`.
    - `refuses a body that is not the bundle`, for example an HTML error page.
- [ ] **Step 2: Run** `pnpm --filter @cortex/conductor-worker exec vitest run src/cli.test.ts src/commands/daemon.test.ts src/commands/update.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** the signatures above.
- [ ] **Step 4: Run** the same command. Expect PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(worker): start/stop/status/logs/update commands with per-agent daemon state"`

### Task 13: Doctor

**Files:**
- Create: `src/commands/doctor.ts`, `src/commands/doctor.test.ts`
- Modify: `src/cli.ts` (wire `doctor`)

**Interfaces:**
- Produces:
  ```ts
  export interface Check { name: string; ok: boolean; required: boolean; detail: string; fix?: string }
  export interface DoctorContext {
    nodeVersion: string; repo: string; homeDir: string; env: NodeJS.ProcessEnv
    flags: { hub?: string; apiKey?: string; agentId?: string }; engines: Executor[]; probe: boolean
    fetchImpl?: typeof fetch; gh?: GhRun; adapters?: EngineAdapter[]; wsConnect?: (url: string, key: string) => Promise<'open' | 401 | string>
  }
  export async function runDoctor(ctx: DoctorContext): Promise<Check[]>
  export function formatChecks(checks: Check[]): string     // '✓ name — detail' / '✗ name — detail\n    fix: …'
  ```
- **Checks, in order** (required ones are marked):
  1. Node ≥ 20 (required).
  2. `git --version` (required).
  3. `gh auth status`. It is optional: without it, the worker reports compare URLs.
  4. Each requested engine:
     - found and version;
     - with `--probe`, a 1-token run of `"Reply with OK"`, classified by the adapter. This catches logged-out engines and quota.
     - At least one engine found is required.
  5. Hub config detected, with its source (required).
  6. `GET <hub>/health` returns 200 (required).
  7. `GET <hub>/conductor/worker.version` compared with `WORKER_VERSION`. A mismatch gives the fix `cortex-worker update`.
  8. WebSocket handshake: `open` means the key is valid and the handshake works; `401` means the key was rejected (required). The socket is closed with 1000 **without registering**, so doctor never becomes dispatchable.
  9. The repo has `origin`; the sanitised URL is shown (required).
  10. Project mapping: `projectId` from `state.lastRegistered`. Before the first `start` it shows "unknown until first start".
  11. Engine MCP configs (warning, not required): for each requested engine whose MCP config has a cortex-hub entry (agy `~/.gemini/antigravity/mcp_config.json`, Codex, Claude Code), compare its `hubBaseFromUrl` with the worker's `hubBase`. A mismatch warns "agy's MCP points at <other hub> — tasks it runs will report to that hub", with the fix of editing that file. Found on the author's machine: agy still pointed at an old hub URL. Show URLs only; keys go through `redact` (`agy mcp list` prints them in plain text, so doctor never shells out to it).
- `doctor` exits 1 if any required check fails.

- [ ] **Step 1: Write failing tests**, with everything injected:
  - `reports every check in order`.
  - `marks a missing engine with its install command`.
  - `reports a 401 handshake as an invalid key`.
  - `never sends worker.register`: a local ws server records messages and expects none.
  - `warns when an engine's MCP config points at another hub`: agy config with `https://old.example/mcp`, worker hub `https://h.example` → a warning naming agy and `https://old.example`, exit code unaffected, no key in the output.
  - `version mismatch suggests update`.
  - `exit code is 1 when a required check fails and 0 when only gh fails`.
  - `does not run a probe unless --probe`.
- [ ] **Step 2: Run** `pnpm --filter @cortex/conductor-worker exec vitest run src/commands/doctor.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** `runDoctor` and `formatChecks`, and wire them into `cli.ts`.
- [ ] **Step 4: Run** the same command. Expect PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(worker): doctor command"`

### Task 14: hub-mcp serves the bundle and forwards close codes

**Files:**
- Create:
  - `apps/hub-mcp/src/worker-asset.ts`, `apps/hub-mcp/src/worker-asset.test.ts`
  - `apps/hub-mcp/src/ws-close.ts`, `apps/hub-mcp/src/ws-close.test.ts`
- Modify: `apps/hub-mcp/src/node.ts`. Only the `serve({ fetch })` argument and the proxy's `upstream.on('close')` handler change.

**Interfaces:**
- Produces:
  ```ts
  export interface WorkerAssetOptions { bundlePath: string }   // version file = bundle path with .mjs → .version
  export function defaultBundlePath(env: NodeJS.ProcessEnv, moduleUrl: string): string
    // env.CONDUCTOR_WORKER_PATH ?? resolve(dirname(fileURLToPath(moduleUrl)), '../../conductor-worker/dist/cortex-worker.mjs')
  export async function serveWorkerAsset(req: Request, opts: WorkerAssetOptions): Promise<Response | null>
  export function forwardCloseCode(code: number): number   // 1000/1001/1008/1011/3000-4999 kept; 1005→1000; 1006 and others→1011
  ```
- **Routes and responses:**
  - **`GET /conductor/worker.mjs`:**
    - 200 with `Content-Type: text/javascript; charset=utf-8` and `Cache-Control: no-cache`.
    - The body is the file.
  - **`GET /conductor/worker.version`:** 200 `text/plain`, the trimmed version file.
  - **Missing file:** 404 `text/plain`, "worker bundle not built".
  - **Other paths:** `null`.
  - **Auth:** none; the code is public (§6.12).
- **Why `node.ts` and not `index.ts`:** `index.ts` is also the Cloudflare Workers entry (`wrangler.toml` → `src/index.ts`) and cannot read files. That is why the contract's "routes in `index.ts`" moves here.
- **`node.ts` changes:**
  - `fetch: async (req, env) => (await serveWorkerAsset(req, assetOpts)) ?? app.fetch(req, env)`
  - `upstream.on('close', (code, reason) => clientWs.close(forwardCloseCode(code), reason))`. Today the client is closed with no code, so the contract's 4000/4009 never reach a worker.

- [ ] **Step 1: Write failing tests:**
  - `serves the bundle with text/javascript`.
  - `serves the version as text/plain`.
  - `returns 404 when the bundle is missing`.
  - `returns null for other paths`.
  - `defaultBundlePath honours CONDUCTOR_WORKER_PATH`.
  - `forwardCloseCode keeps 4000-4999 and maps 1005/1006` (Review Focus 1).
- [ ] **Step 2: Run** `pnpm --filter @cortex/hub-mcp exec vitest run src/worker-asset.test.ts src/ws-close.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** both modules and wire them into `node.ts`.
- [ ] **Step 4: Run** the same command. Expect PASS. Then do a manual check:
  - `pnpm --filter @cortex/conductor-worker build && pnpm --filter @cortex/hub-mcp build && PORT=18317 node apps/hub-mcp/dist/node.js &`
  - `curl -s localhost:18317/conductor/worker.version` prints `0.9.10`.
  - `curl -sI localhost:18317/conductor/worker.mjs | grep -i content-type` shows `text/javascript`.
  - Stop the server.
- [ ] **Step 5: Commit** `git commit -m "feat(hub-mcp): serve the conductor worker bundle and forward WebSocket close codes"`

### Task 15: Dockerfile builds and ships the bundle

**Files:**
- Modify: `infra/Dockerfile.hub-mcp`

**Changes:**
- **deps stage:** `COPY apps/conductor-worker/package.json ./apps/conductor-worker/`.
- **builder stage:**
  - `ARG APP_VERSION=`, empty by default like `Dockerfile.dashboard-api`, so a local build reads `version.json`.
  - `rm -rf … apps/conductor-worker/dist`.
  - `npx turbo build --force --filter=@cortex/hub-mcp --filter=@cortex/conductor-worker`.
  - Turbo passes `APP_VERSION` through because Task 1 declared it in `env`.
- **runner stage:**
  - `COPY --from=builder /app/apps/conductor-worker/dist/cortex-worker.mjs /app/apps/conductor-worker/dist/cortex-worker.version ./apps/conductor-worker/dist/`
  - `ENV CONDUCTOR_WORKER_PATH=/app/apps/conductor-worker/dist/cortex-worker.mjs`
- prod-deps is unchanged. The bundle needs no `node_modules`.

- [ ] **Step 1: Write the failing check:**
  - `docker build -f infra/Dockerfile.hub-mcp --build-arg APP_VERSION=9.9.9 -t cortex-hub-mcp:a2 . && docker run --rm -d --name hubmcp-a2 -p 18318:8317 cortex-hub-mcp:a2 && sleep 3 && curl -fs localhost:18318/conductor/worker.version`
  - Expect FAIL: 404, because the bundle is not in the image yet.
- [ ] **Step 2: Apply** the Dockerfile changes.
- [ ] **Step 3: Re-run.** Expect `9.9.9`. Then:
  - `curl -fs localhost:18318/conductor/worker.mjs | head -1` prints `#!/usr/bin/env node`.
  - `docker rm -f hubmcp-a2`.
  - Build once without `--build-arg` and expect the `version.json` value.
- [ ] **Step 4: Commit** `git commit -m "build(docker): build and serve the conductor worker from the hub-mcp image"`

### Task 16: Bootstraps and deprecation notices

**Files:**
- Modify:
  - `scripts/run-agent.sh` (rewrite, ~30 lines)
  - `scripts/run-agent.ps1` (rewrite, ~30 lines)
  - `scripts/cortex-agent.sh` and `scripts/cortex-agent.ps1` (notice only)

**Bootstrap behaviour**, the same on both OSes:
1. Fail fast without `git`, or without `node` ≥ 20, each with an install hint.
2. Find the hub:
   1. `--hub <url>` or `--hub=<url>` in the arguments.
   2. `CORTEX_HUB_URL`.
   3. A cached `~/.cortex/worker/cortex-worker.mjs` that runs `hub-url`. This uses the worker's own config detection; the spec's order only works once a bundle exists.
   4. Otherwise exit 1: "pass --hub https://<your-mcp-host>".
3. Strip a trailing `/` and `/mcp`.
4. Download `<hub>/conductor/worker.mjs` with `node`'s `fetch` (no curl dependency) to `cortex-worker.mjs.tmp`, then rename it.
   - A 404 means "this hub does not serve the worker yet — upgrade the hub".
   - A network failure with a cached bundle warns and continues.
5. `exec node "$W" "$@"`, or `& node $W @args; exit $LASTEXITCODE` in PowerShell.
- `CORTEX_WORKER_HOME` overrides `~/.cortex/worker`, for tests.

**Deprecation notice:**
- `cortex-agent.sh` gets a notice right after `set -euo pipefail`, printed to stderr: "cortex-agent.sh is deprecated; use run-agent.sh (TypeScript worker): curl -fsSL …/scripts/run-agent.sh | bash -s -- start --hub <url>". The script keeps working.
- `cortex-agent.ps1` gets a `Write-Warning` after `param(...)`.

- [ ] **Step 1: Write the failing check.** With hub-mcp running on 18317 (Task 14) and `T=$(mktemp -d)`:
  - `CORTEX_WORKER_HOME=$T bash scripts/run-agent.sh --hub http://localhost:18317 --version` expects `0.9.10`. Today it fails, because the old script downloads `cortex-agent.sh` from GitHub.
  - `env -u CORTEX_HUB_URL CORTEX_WORKER_HOME=$(mktemp -d) bash scripts/run-agent.sh --version` expects exit 1 with "pass --hub".
- [ ] **Step 2: Rewrite** both bootstraps and add both notices.
- [ ] **Step 3: Re-run** the checks and expect them to pass. Then:
  - `bash -n scripts/run-agent.sh scripts/cortex-agent.sh`.
  - `wc -l scripts/run-agent.sh scripts/run-agent.ps1` shows about 30 lines each.
  - `bash scripts/cortex-agent.sh help 2>&1 | head -1` shows the notice.
  - If `pwsh` is available: `pwsh -NoProfile -File scripts/run-agent.ps1 --hub http://localhost:18317 --version`. Otherwise this check moves to Task 18's Windows checklist.
- [ ] **Step 4: Commit** `git commit -m "chore(scripts): run-agent bootstraps download the worker from the hub; deprecate cortex-agent"`

### Task 17: Worker end-to-end test (fake hub, fake agy, bare origin, built bundle)

**Files:**
- Create:
  - `apps/conductor-worker/src/e2e/worker.e2e.test.ts`
  - `apps/conductor-worker/src/e2e/fake-agy.mjs`:
    - it replays the Task 5 fixtures;
    - `--model claude-sonnet-*` edits a file, then exits 3 with the quota stderr;
    - `--model slow` writes its pid and sleeps;
    - any other model appends to `README.md` and prints `success.jsonl`.
  - `apps/conductor-worker/src/e2e/fake-gh.mjs`:
    - `auth status` exits 0;
    - `pr create` prints `https://github.com/acme/demo/pull/1`.

**Setup:**
- `describe.skipIf(process.platform === 'win32')`.
- `beforeAll` fails with "run `pnpm --filter @cortex/conductor-worker build` first" if `dist/cortex-worker.mjs` is missing.
- Use the git fixture.
- Start a `WebSocketServer` on port 0.
- Spawn `node dist/cortex-worker.mjs start --hub http://127.0.0.1:<port> --api-key k --agent-id e2e-1 --repo <repo> --engines agy` with this env:
  - `HOME` and `USERPROFILE` set to a temp dir;
  - `CORTEX_AGY_BIN`;
  - `CORTEX_GH_BIN`;
  - `CORTEX_TEST_CMD="node -e \"console.log('tests ok')\""`.

**Scenario** (the fake hub drives it and asserts on received messages):
1. `worker.register`: `protocol === 2`, `engines[0].executor === 'agy'`, `engines[0].models` contains `gemini-4-argon-low`, the repo has no userinfo. The hub replies `registered`.
2. `task.assigned` T1, route `agy/gemini-4-argon-low`. Expect `task.accept`, at least one `task.progress`, then `task.complete` with `status: 'completed'`, `prUrl === 'https://github.com/acme/demo/pull/1'`, and `testOutput` containing `tests ok`. `git --git-dir origin.git log -1 --format=%s <branch>` equals `T1: <title>`.
3. While T3 (`slow`) runs, `task.assigned` T2 gets `task.decline {reason: 'busy'}`. Then `task.revoked` T3: no `task.complete` for T3, the fake agy pid is dead within 15 s, and the origin branch head is `WIP T3: revoked` (or there is no new commit when the tree was clean).
4. `task.assigned` T4, route `agy/claude-sonnet-5-5-low`. Expect `task.quota_exhausted` with `executor: 'agy'`, `modelScope: 'claude-sonnet-5-5-*'`, `resetAt` about now + 89 h, `handoff.commit` non-null, and the origin head `WIP T4: quota handoff`. The fake hub re-assigns T4 at attempt 2 with route `agy/gemini-4-argon-low` and a handoff. Expect `completed` on the same branch, with the WIP commit as the parent.
5. Close the server socket with code 1006. The worker reconnects and re-registers.
6. `cortex-worker stop --agent-id e2e-1` with the same env: the process exits 0 within 10 s.

- [ ] **Step 1: Write the test** above, with fixtures loaded from `src/engines/__fixtures__/agy/`.
- [ ] **Step 2: Run** `pnpm --filter @cortex/conductor-worker build && pnpm --filter @cortex/conductor-worker exec vitest run src/e2e/worker.e2e.test.ts`. Expect PASS. Any failure here is a bug in Tasks 9–12; fix it there, not in the test.
- [ ] **Step 3: Commit** `git commit -m "test(worker): end-to-end run through the built bundle with fake hub, agy and gh"`

### Task 18: Full-stack end-to-end (opt-in) and final gates

**Files:**
- Create: `apps/conductor-worker/src/e2e/hub.e2e.test.ts`

**Interfaces:**
- Consumes A1's REST API: `POST /api/conductor/tree`, `GET /api/conductor/:id/tree`, `POST /api/conductor/:id/review`. Also the hub-mcp WebSocket proxy, Task 17's fakes, and the built bundle.

**Setup:**
- `describe.skipIf(!process.env.CORTEX_E2E_API_URL || !process.env.CORTEX_E2E_HUB_URL || !process.env.CORTEX_E2E_API_KEY)`.
- It needs a running A1 hub (`docker compose -f infra/docker-compose.yml up` or `pnpm dev`) and a project whose repo is the fixture's origin. The test creates both through the API where A1 allows, else it documents the one manual step in the test header.

**Scenario:**
1. Create a tree of three tasks:
   - A: `reviewRequired: true`.
   - B: `dependsOn: ['A']`, `executor: 'agy'`, `model: 'claude-sonnet-5-5-low'`, `fallback: [{executor: 'agy', model: 'gemini-4-argon-low', effort: null}]`.
   - C: `dependsOn: ['B']`.
2. Start one worker.
3. Assert, in order:
   - A is dispatched first and reaches `review` with `result.prUrl`.
   - Approving A through `POST /:id/review` makes B dispatch.
   - B's fake quota exit moves it to the fallback: `current_route.model === 'gemini-4-argon-low'`, it completes, and the hub has a quota row for `claude-sonnet-5-5-*`.
   - C runs last.
   - `assigned_at` timestamps are ordered A < B < C.

- [ ] **Step 1: Write the test** above.
- [ ] **Step 2: Run without env:** `pnpm --filter @cortex/conductor-worker exec vitest run src/e2e/hub.e2e.test.ts`. Expect it to be skipped.
- [ ] **Step 3: With A1 merged and a local hub up**, run it with the three env vars and expect PASS. Record the result in the PR description.
- [ ] **Step 4: Run all tests:**
  - `pnpm --filter @cortex/conductor-worker test`
  - `pnpm --filter @cortex/hub-mcp test`
  - Expect PASS.
- [ ] **Step 5: Windows check** (manual, on a Windows machine with Node 20+ and git; success criterion 1):
  1. `powershell -ExecutionPolicy Bypass -File scripts\run-agent.ps1 doctor --hub <hub>`: all required checks pass.
  2. `… start --daemon --engines agy` (or claude), then `status`.
  3. Create one task from the lead. A PR or compare URL arrives, and the task reaches `review`.
  4. `stop` returns within 90 s and no `agy`/`node` child remains (`tasklist`).
  5. Note in the PR whether `agy` resolved to `.exe` or `.cmd`. A `.cmd` with a multi-line argv prompt fails loudly in `spawnTracked` (Task 4); if seen, switch agy to a stdin prompt.
- [ ] **Step 6: Run the quality gates** last, after the final edit: `pnpm build && pnpm typecheck && pnpm lint`. Expect all three green.
- [ ] **Step 7: Commit** `git commit -m "test(worker): opt-in full-stack conductor e2e"`

---

## Spec coverage

| Spec item | Task |
|---|---|
| §6.12 package, esbuild single file, Node ≥ 20, version stamp | 1 |
| §6.12 configuration detection (all formats; `/mcp` → `/ws/conductor`) / W6 | 2 |
| §6.12 state and logs per agent id; W1 global PID file | 3, 12 |
| §6.12 revoke kills the process tree (Windows `taskkill /T /F`) | 4, 10 |
| §6.12 engine adapters, `classify`, quota → `modelScope`/`resetAt`; W2, W3 | 5, 6 |
| §6.12 git flow, PR or compare URL, branch kept; W7 | 7, 10 |
| §6.12 prompt, rules; progress ≤ 1 line / 5 s | 8 |
| §6.5 register (protocol, activeTaskId), registered (version warn), close codes | 9, 11, 14 |
| §6.12 one task at a time, `decline busy`; W4 | 11 |
| §6.12 test command, last 200 lines; `allowEmpty`; `task.complete`; W5 | 10, 11 |
| §6.12 quota WIP push + `task.quota_exhausted`; revoke WIP push | 10, 11 |
| §6.12 commands `start/stop/status/logs/doctor/update` | 12, 13 |
| §6.12 hub-mcp routes, Dockerfile | 14, 15 |
| §6.12 bootstraps, deprecation notices; W1 | 16 |
| §10 worker tests (fixtures, temp repo with bare origin, local ws server) | 2–13 |
| §10 end to end | 17 (CI-safe), 18 (full stack, opt-in) |
| §11 unknown output is `error`; Windows `auto` mode; agy start-up time | 5, 6, 13 |
