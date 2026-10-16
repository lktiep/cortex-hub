# Conductor C — Setup docs and URLs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person can set up a lead machine and any number of macOS, Linux or Windows worker
machines from one guide. Every place that turns an MCP config into a hub URL produces the right
WebSocket URL. Every Claude Code snippet we print or write is the native `type: "http"` form. The
lead's orchestrator prompt matches the new plan, route, review and gate tools.

**Architecture:** Three pieces. (1) A vscode-free module `apps/cortex-extension/src/mcp-config.ts`
holds the parsing and URL rules, so vitest can test them. It mirrors the resolver order that
`scripts/install.sh` already uses for the hooks, so hooks, extension and worker share one rule.
(2) The installer and onboarding scripts and the dashboard change snippet strings only, plus one
pure helper, `apps/dashboard-web/src/lib/worker-bootstrap.ts`, which builds the copyable worker
command from `EXTERNAL_MCP_URL`. (3) Docs: a new `docs/conductor/setup.md`, a rewritten
`scripts/orchestrator-prompt.md`, an updated `docs/conductor.md` and README links.

**Tech Stack:** TypeScript strict, vitest `^3` (as in `apps/hub-mcp` and `apps/dashboard-api`),
esbuild (extension bundle), Next.js 15 (dashboard), bash, PowerShell, Python 3 heredocs (installers),
Markdown.

**Spec:** `docs/superpowers/specs/2026-10-16-conductor-production-ready-design.md`. This plan
covers §8. It also uses §2 W6, the §2 Antigravity CLI facts, D2, D7, D8, §6.5 close codes, §6.9
tools and §6.12 worker commands. Shared names come from the cross-plan contract (A1 produces them).

---

## Global Constraints

- **Depends on A1 and A2 being merged.** The docs and the prompt describe merged behaviour: tool
  names, worker flags and the bootstrap. Task 0 records the real names and flags. If one differs
  from this plan, use the merged name and note the difference in the PR body.
- **Files C owns** (contract): `docs/**`, `scripts/orchestrator-prompt.md`,
  `apps/cortex-extension/src/config.ts` and its test, the MCP snippet strings in
  `scripts/install.sh`, `scripts/onboard.sh` and the dashboard-web Settings and Home pages, and
  README links.
- **Extensions to the contract** (no other plan owns these files; say so in the PR):
  - `apps/cortex-extension/src/{mcp-config.ts,mcp-config.test.ts,ws-client.ts,hub-api.ts}` and
    `apps/cortex-extension/package.json`.
  - The Claude Code writers in `scripts/install.ps1` and `scripts/onboard.ps1`.
  - In dashboard-web, which B owns: `src/lib/worker-bootstrap.ts`, its test, and one "Run a
    worker" block on the Settings page. Rebase onto B before touching those pages.
- **The dashboard pages sit on the user's pending fix.** `resolveMcpEndpoint` in
  `apps/dashboard-web/src/lib/config.ts` and the snippets in `src/app/page.tsx` and
  `src/app/settings/page.tsx` are uncommitted work on `docs/conductor-production-ready-spec`.
  Rebase onto it once it merges. Do not rewrite `resolveMcpEndpoint`; consume `mcpEndpoint.url`.
- **No secrets or real hosts** in docs, UI, tests or the prompt. Use these placeholders:
  `https://<your-mcp-host>`, `<lead-api-key>`, `<worker-api-key>`. The only domains allowed are
  `localhost`, `example.com` and the vendor and GitHub domains listed in Task 9.
- **Test fixture keys are shorter than 12 characters** (`k1`, `test-key`), so the Bearer secret
  scan in Task 9 stays meaningful.
- **Commit gate:** the repo hooks refuse `git commit` unless `pnpm build && pnpm typecheck &&
  pnpm lint` passed after the last write.
  - Each "Commit" step therefore runs the three gates first (full build, never `--filter`).
  - It then sends `git diff --staged -U0 | grep -E '^(diff |--- |\+\+\+ |@@ )'` to
    `cortex_detect_changes`.
  - Never `--no-verify`.
  - Unit tests may use `pnpm --filter <pkg> test`.
- **Adding vitest changes `pnpm-lock.yaml`.** On a rebase conflict, take the other side and rerun
  `pnpm install`. Never hand-merge the lockfile.

## Review Focus

1. The WebSocket URL ends in `/ws/conductor` exactly once on every path: setting, env, MCP URL
   with or without a path prefix, and fallback. Tested in Task 2 (`toConductorWsUrl`) and Task 3
   (`conductorConnectUrl`).
2. The API key and the hub URL come from the **same** MCP entry. Both forms parse: `{url, headers}`
   and `mcp-remote` args with `${VAR}` expansion. Tested in Task 2 (`detectHub`, same-entry and
   expansion cases).
3. Every Claude Code writer and snippet emits `type: "http"` + `url` + `headers`. Non-Claude
   writers keep the form that works today. Checked in Task 4 (rg counts, `bash -n`,
   `scripts/test-hooks.sh`) and Task 5 (snippet rg).
4. No real key or hub hostname reaches docs, UI or tests, and the bootstrap's `--hub` is the
   `EXTERNAL_MCP_URL` base without `/mcp`. Covered by the Task 5 test (`workerBootstrap`) and the
   Task 9 secret and host scan.
5. The prompt names only tools and fields the hub registers, and states that user gates close only
   from the dashboard (D8). Checked by the Task 7 contract check against `apps/hub-mcp/src/tools`.

---

## Task 0: Preconditions and recorded facts

**Files:** none (the PR body records the facts).

- [ ] `git log --oneline origin/master | head -30`: confirm that A1 (tree, review and route tools),
      A2 (`apps/conductor-worker`, new `run-agent.*`) and the user's dashboard URL fix are merged.
      Rebase onto `origin/master`.
- [ ] Record the MCP tool names:
      `rg -o "'cortex_[a-z_]+'" apps/hub-mcp/src/tools | sort -u`. Expect
      `cortex_task_tree_create`, `cortex_agents`, `cortex_task_review`, `cortex_task_route` and
      `cortex_task_cancel` next to the existing tools.
- [ ] Record the worker CLI:
      `rg -n "'(start|stop|status|logs|doctor|update)'|--(daemon|agent-id|repo|engines|capabilities|hub)" apps/conductor-worker/src/cli.ts`.
      Also `sed -n 1,40p scripts/run-agent.sh scripts/run-agent.ps1`.
      - Confirm that the bootstraps pass arguments through verbatim (`"$@"` / `@args`) and accept
        `--hub`.
      - Confirm where the bundle lands (`~/.cortex/worker/cortex-worker.mjs`) and whether a
        `cortex-worker` shim is put on PATH.
      - The docs use the shim name only if it exists. Otherwise they use
        `node ~/.cortex/worker/cortex-worker.mjs <cmd>`.
- [ ] Find what fills `{{AGENTS_LIST}}`:
      `rg -n "AGENTS_LIST|orchestrator-prompt" apps scripts -g '!scripts/cortex-agent.*'`.
      - If nothing outside the deprecated `cortex-agent.sh` fills it, Task 7 drops the
        placeholder.
      - The `tpl.replace('{{AGENTS_LIST}}', …)` at `scripts/cortex-agent.sh:452` then becomes a
        harmless no-op.

## Task 1: vitest harness for the extension

**Files:** modify `apps/cortex-extension/package.json` and `pnpm-lock.yaml`.

**Interfaces:**
- `"scripts": { "test": "vitest run" }`
- `devDependencies.vitest: "^3.0.0"`

No `vitest.config` is needed: the node environment is the default, and the tests import nothing
from `vscode`.

- [ ] Add the script and the devDependency, then run `pnpm install`.
- [ ] Add a `src/mcp-config.test.ts` stub (`it.todo('detectHub')`).
      Run `pnpm --filter cortex-agent test` and expect it to pass with 1 todo.
- [ ] Confirm that `pnpm --filter cortex-agent build` still bundles only `src/extension.ts`.
      `tsc --noEmit` and `eslint src/` must accept the test file: imports use the `.js` suffix,
      as in `hub-api.ts`, and there is no `any`.
- [ ] Commit (gates first): `test(extension): add vitest harness`.

## Task 2: Pure MCP-config detection (`mcp-config.ts`), test-first

**Files:** create `apps/cortex-extension/src/mcp-config.ts`; fill in
`apps/cortex-extension/src/mcp-config.test.ts`.

**Interfaces** (no `vscode` import; all I/O injected):
```ts
export const DEFAULT_HUB_WS_URL = 'ws://localhost:8318/ws/conductor'
export type ReadText = (path: string) => string | undefined          // undefined = missing/unreadable
export interface McpEntry { [k: string]: unknown }
export interface HubDetection { mcpUrl: string; wsUrl: string; apiKey: string | null; source: string }

export function toConductorWsUrl(raw: string): string | undefined
export function mcpSources(home: string, workspace?: string): Array<{ path: string; project?: string }>
export function findCortexEntry(doc: unknown, project?: string): McpEntry | undefined
export function entryEndpoint(entry: McpEntry, env?: Record<string, string | undefined>): { url?: string; apiKey?: string }
export function detectHub(read: ReadText, home: string, workspace?: string, env?: Record<string, string | undefined>): HubDetection | undefined
```

**Decisions:**
- **`toConductorWsUrl`:**
  - Parse with `new URL`. Accept only `http`, `https`, `ws` and `wss`; map `http→ws` and
    `https→wss`.
  - Drop the query and hash, and strip trailing `/`.
  - If the path ends in `/ws/conductor`, keep it. If it ends in `/mcp`, replace that with
    `/ws/conductor`. Otherwise append `/ws/conductor`. A path prefix survives
    (`/hub/mcp` → `/hub/ws/conductor`).
- **`mcpSources`** uses the order of `scripts/install.sh`'s resolver (~line 1211):
  1. `<ws>/.mcp.json`
  2. `~/.claude.json` `projects[<ws>]`
  3. `~/.claude.json` top level
  4. `~/.claude/claude_mcp_config.json`
  5. `<ws>/.gemini/settings.json`
  6. `~/.gemini/settings.json`
  7. `~/.gemini/antigravity/mcp_config.json`
  8. `~/.cursor/mcp.json`
  9. `~/.codeium/windsurf/mcp_config.json`
  10. `<ws>/.vscode/mcp.json`

  Sources that need `<ws>` are skipped when there is no workspace. Codex's TOML is out of scope;
  see the report.
- **`findCortexEntry`** reads `mcpServers` and `servers`, or `projects[project].mcpServers` when a
  project is given. It returns the `cortex-hub` key, else the first key that contains `cortex`
  (case-insensitive).
- **`entryEndpoint`:**
  - URL: the first of `url`, `httpUrl`, `serverUrl` and `serverURL`; else the first `args` item
    that starts with `http`.
  - Auth: `headers.Authorization`, then `headers.authorization`; else the `args` item after
    `--header` that starts with `authorization:` (case-insensitive), taken after the first `:`.
  - Expand `${VAR}` from `entry.env` first, then from `env`.
  - Strip `Bearer `. Fall back to `entry.env.HUB_API_KEY`, `CORTEX_HUB_API_KEY` and
    `CORTEX_API_KEY`.
- **`detectHub`:**
  - The first source whose entry yields a URL that `toConductorWsUrl` accepts wins. The key is
    taken from that same entry and may be `null`.
  - If the entry's `env.CORTEX_HUB_WS_URL` is set, it overrides the derived `wsUrl`.
  - `source` is the file path, plus `#projects` for a per-project hit.
  - Invalid JSON and missing files are skipped silently.

- [ ] Write the failing tests:

| Test | Input | Expected |
|---|---|---|
| ws: https MCP | `https://mcp.example.com/mcp` | `wss://mcp.example.com/ws/conductor` |
| ws: local | `http://localhost:8318/mcp` | `ws://localhost:8318/ws/conductor` |
| ws: prefix + slash | `https://example.com/hub/mcp/` | `wss://example.com/hub/ws/conductor` |
| ws: bare base | `wss://mcp.example.com` | `wss://mcp.example.com/ws/conductor` |
| ws: idempotent | `ws://localhost:8318/ws/conductor` | unchanged |
| ws: query/hash dropped | `https://mcp.example.com/mcp?x=1#y` | `wss://mcp.example.com/ws/conductor` |
| ws: rejects | `not a url`, `ftp://x/mcp` | `undefined` |
| fallback | `DEFAULT_HUB_WS_URL` | ends with `/ws/conductor` |
| entry: http form | `{type:'http',url,headers:{Authorization:'Bearer k1'}}` | `{url, apiKey:'k1'}` |
| entry: lower-case header | `headers:{authorization:'Bearer k1'}` | `apiKey:'k1'` |
| entry: mcp-remote + AUTH_HEADER | args `['-y','mcp-remote',U,'--header','Authorization:${AUTH_HEADER}']`, env `{AUTH_HEADER:'Bearer k2'}` | `{url:U, apiKey:'k2'}` |
| entry: mcp-remote literal | `'Authorization: Bearer k3'` | `apiKey:'k3'` |
| entry: env-var key in header | `'Authorization: Bearer ${HUB_API_KEY}'`, env `{HUB_API_KEY:'k4'}` | `apiKey:'k4'` |
| entry: windsurf / gemini | `{serverUrl:U}` / `{httpUrl:U}` | `url:U` |
| entry: no auth, env key | args URL, env `{HUB_API_KEY:'k5'}` | `apiKey:'k5'` |
| detect: per-project beats top level | `~/.claude.json` with `projects['/w'].mcpServers` (URL A) and top-level (URL B), workspace `/w` | `mcpUrl` A, `source` ends `#projects` |
| detect: `.mcp.json` beats `~/.claude.json` | both present | the `.mcp.json` URL |
| detect: same entry | claude URL A, no key; agy URL B, key kB | A with `apiKey: null` (never kB) |
| detect: key name | `{'cortex-dev':…, 'cortex-hub':…}` | the `cortex-hub` entry; with only `Cortex-X`, that entry |
| detect: VS Code `servers` | `<ws>/.vscode/mcp.json` `{servers:{'cortex-hub':{type:'http',url}}}` | found |
| detect: robustness | one file invalid JSON, one missing, a later one valid | the later one |
| detect: nothing | no files | `undefined` |
| detect: env override | entry `env.CORTEX_HUB_WS_URL='wss://x.example.com/ws/conductor'` | that `wsUrl` |

- [ ] Run `pnpm --filter cortex-agent test` and watch the tests fail.
- [ ] Implement `mcp-config.ts` and get the tests to pass. Paths go through `node:path` `join`;
      nothing touches `fs`.
- [ ] Commit (gates first): `fix(extension): detect the hub from url/headers MCP configs`.

## Task 3: Wire the extension to the module

**Files:** modify `apps/cortex-extension/src/config.ts`, `src/ws-client.ts` (line 50),
`src/hub-api.ts` (the comment at lines 5-6) and `package.json` (`cortexHub.hubUrl`); add cases to
`src/mcp-config.test.ts`.

**Interfaces:**
```ts
// mcp-config.ts (added)
export function conductorConnectUrl(wsUrl: string, p: { apiKey: string; agentId: string; capabilities: string[]; ide: string; platform: string; hostname: string }): string
```

**Decisions:**
- **`config.ts`** keeps `getConfig()` and `CortexConfig` unchanged and deletes `readMcpEnvVar`,
  `readMcpBearerFromArgs` and `readMcpArgsUrl`.
  - `resolveHubUrl` order:
    1. Setting `hubUrl`, through `toConductorWsUrl`.
    2. `CORTEX_HUB_WS_URL`, then `CORTEX_HUB_URL`, each through `toConductorWsUrl`.
    3. `detectHub(...).wsUrl`.
    4. `DEFAULT_HUB_WS_URL`.
  - `resolveApiKey` order:
    1. Setting `apiKey`.
    2. `CORTEX_HUB_API_KEY`, `HUB_API_KEY`, `CORTEX_API_KEY`.
    3. `detectHub(...).apiKey`.
    4. `''`.
  - Detection runs once per `getConfig()`, with the reader
    `p => { try { return readFileSync(p, 'utf-8') } catch { return undefined } }`, `home` from
    the existing `homedir()` helper, and
    `workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath`.
  - Log the detection `source` (never the key) through the existing `log(...)` at
    `extension.ts:762`; add `hubSource` to the logged line only.
- **`ws-client.ts:50`** no longer appends `/ws/conductor`; it uses `conductorConnectUrl`.
  - That removes today's double path: the MCP-derived URL already ended in `/ws/conductor`.
  - `searchParams.set` URL-encodes `apiKey`, which the code does not do today.
- **`hub-api.ts`:** `getApiBaseUrl` already strips `/ws/conductor`. Update only the comment to
  "hubUrl is the full conductor WebSocket URL".
- **`package.json`:** set the `cortexHub.hubUrl` default to `""`.
  - Today VS Code returns the contributed `ws://localhost:8318`, so detection never runs.
  - Its `markdownDescription` lists the real order: setting → `CORTEX_HUB_WS_URL` /
    `CORTEX_HUB_URL` → MCP configs (Claude Code, `.mcp.json`, Gemini, Antigravity, Cursor,
    Windsurf, VS Code) → `ws://localhost:8318/ws/conductor`.
  - Update the `apiKey` description the same way.

- [ ] Write failing tests for `conductorConnectUrl`:
      - `wss://h.example.com/ws/conductor` yields path `/ws/conductor` exactly once
        (`new URL(out).pathname === '/ws/conductor'`).
      - `apiKey 'a+b/c='` round-trips through `searchParams.get('apiKey')`.
      - `capabilities` decodes to the same JSON array.
      - The query has exactly the 6 keys: `apiKey`, `agentId`, `capabilities`, `ide`, `platform`,
        `hostname`.
- [ ] Implement, then change `config.ts`, `ws-client.ts`, `hub-api.ts` and `package.json`.
- [ ] Check the default:
      `node -e "const p=require('./apps/cortex-extension/package.json');process.exit(p.contributes.configuration.properties['cortexHub.hubUrl'].default===''?0:1)"`
      exits 0.
- [ ] Check that no old reader is left:
      `rg -n "readMcpArgsUrl|readMcpBearerFromArgs|readMcpEnvVar|/ws/conductor\?" apps/cortex-extension/src`
      matches nothing.
- [ ] Run `pnpm --filter cortex-agent test` (green) and `pnpm --filter cortex-agent build`.
- [ ] Manual check, recorded in the PR:
      - Install the built VSIX, or run the Extension Development Host, on a machine whose
        `~/.claude.json` has the `type: "http"` entry and no `cortexHub.hubUrl` setting.
      - The output channel shows `hubUrl=wss://…/ws/conductor` and a source path, and the agent
        appears in `/conductor`.
- [ ] Commit (gates first): `fix(extension): connect to /ws/conductor exactly once`.

## Task 4: Installer and onboarding snippets

**Files:** modify only the cortex-hub entry literals in these writers:
- `scripts/install.sh`: the Claude block at ~line 299.
- `scripts/onboard.sh`: the `tool_key = claude` branch at ~line 318.
- `scripts/install.ps1`: `Set-McpConfig`'s `$mcpEntry` at ~line 157, for the Claude call only.
- `scripts/onboard.ps1`: the Python `entry` at ~line 234.

**Decisions:**
- **Claude Code** gets `{'type': 'http', 'url': MCP_URL, 'headers': {'Authorization': 'Bearer ' + KEY}}`
  in all four scripts, which is the form Claude Code writes itself.
  - In `install.ps1`, add a `[string]$Kind` parameter to `Set-McpConfig`. The Claude call passes
    `http` and builds the entry above; the other calls keep `mcp-remote`.
- **Cursor, Windsurf, Antigravity and Codex** keep `npx mcp-remote <url> --header …`. That form
  works today for agy, Cursor and Codex on the maintainer's machine, and changing it is outside §8.
  Their URL is still `${MCP_URL}` / `$McpUrl`, the hub chosen at install time, which satisfies
  "the agy snippet uses the current hub".
- **`onboard.ps1`** writes `serverURL`, which no client reads. Fix it per tool:
  - Claude: the `type: http` form.
  - `vscode`: `{type:'http', url, headers}`, replacing `type:'sse'`.
  - Everything else: the `mcp-remote` form used by `onboard.sh`.
- The VS Code `servers` stdio entry in `install.sh` (~line 393) is unchanged.

- [ ] List every writer:
      `rg -n "\['cortex-hub'\] = |target\['cortex-hub'\]|\\\$mcpEntry = |\[mcp_servers\.cortex-hub\]" scripts/install.sh scripts/onboard.sh scripts/install.ps1 scripts/onboard.ps1`.
      Mark each one Claude or other in the PR body.
- [ ] Edit the entries.
- [ ] Static checks:
      - `bash -n scripts/install.sh scripts/onboard.sh`.
      - `pwsh -NoProfile -Command '$null=[ScriptBlock]::Create((Get-Content -Raw scripts/install.ps1)); $null=[ScriptBlock]::Create((Get-Content -Raw scripts/onboard.ps1))'`,
        if `pwsh` exists; otherwise note "not run" in the PR.
- [ ] Count checks:
      - `rg -c "'type': 'http'" scripts/install.sh scripts/onboard.sh` gives at least 1 per file.
      - `rg -c "type\s*=\s*.http.|'type': 'http'" scripts/install.ps1 scripts/onboard.ps1` gives
        at least 1 per file.
      - `rg -n "serverURL" scripts` matches nothing.
- [ ] Review the Claude blocks:
      `rg -n -B2 -A8 "~/.claude.json'\)$|tool_key\" = \"claude\"" scripts/install.sh scripts/onboard.sh`.
      No `mcp-remote` may appear inside them.
- [ ] Run `bash scripts/test-hooks.sh` and expect it green. The hooks' resolver already reads
      `{url, headers}`, so it must still find the hub.
- [ ] Commit (gates first): `fix(install): write the Claude Code MCP entry as type http`.

## Task 5: Dashboard snippet and worker bootstrap

**Files:**
- Create `apps/dashboard-web/src/lib/worker-bootstrap.ts` and `worker-bootstrap.test.ts`.
- Modify `apps/dashboard-web/src/app/settings/page.tsx` (the MCP Agent Config `<pre>`, plus a new
  "Run a worker" block after it) and `src/app/page.tsx` (the Quick Connect `<pre>`).
- If dashboard-web has no vitest by then, also modify `apps/dashboard-web/package.json`.

**Interfaces:**
```ts
export const RUN_AGENT_RAW = 'https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts'
export interface WorkerBootstrap { hubBase: string | null; unix: string; windows: string }
export function workerBootstrap(mcpUrl: string | null): WorkerBootstrap
```

**Decisions:**
- **`hubBase`** is `mcpUrl` with trailing `/` and one trailing `/mcp` removed. If `mcpUrl` is
  null, `hubBase` is null and the commands use `https://<your-mcp-host>`.
  - The worker downloads `<hub>/conductor/worker.mjs` (§6.12), which is why `/mcp` is dropped.
- **`unix`:**
  `curl -fsSL ${RUN_AGENT_RAW}/run-agent.sh | CORTEX_API_KEY=<worker-api-key> bash -s -- start --daemon --hub ${hub}`
- **`windows`:**
  `$env:CORTEX_API_KEY="<worker-api-key>"; iwr -useb ${RUN_AGENT_RAW}/run-agent.ps1 -OutFile $env:TEMP\run-agent.ps1; & $env:TEMP\run-agent.ps1 start --daemon --hub ${hub}`
  - The flags are whatever Task 0 recorded.
- **The key is never filled in.** The block's hint says to create a separate worker key (D7) in
  Settings → API Keys and links to `docs/conductor/setup.md`.
- **Snippets:** both `<pre>` blocks gain `"type": "http",` before `"url"`. The hint text names
  Claude Code (`~/.claude.json` or `.mcp.json`) and points other clients to the setup guide.
- **The "Run a worker" block** reuses `styles.codeCard`, `styles.codeHint` and `styles.codeBlock`
  (no CSS change).
  - It shows two `<pre>` blocks: macOS / Linux and Windows.
  - Each has a Copy button: `navigator.clipboard.writeText(cmd)` and a 2 s "Copied" state.
  - When `mcpEndpoint.source === 'unconfigured'`, it shows the existing `EXTERNAL_MCP_URL` hint.
- **vitest for dashboard-web:** if B has not added it, add `"test": "vitest run"` and
  `vitest: ^3.0.0`. The helper has no `@/` imports, so no config is needed. Tell B in the PR.

- [ ] Write failing tests for `workerBootstrap`:
      - `https://mcp.example.com/mcp`: `hubBase` is `https://mcp.example.com`, `unix` contains
        `--hub https://mcp.example.com` and does not contain `/mcp `.
      - `http://192.168.1.5:8318/mcp`: `--hub http://192.168.1.5:8318`.
      - `https://example.com/hub/mcp/`: `hubBase` is `https://example.com/hub`.
      - `null`: `hubBase` is null, and both commands contain `https://<your-mcp-host>`.
      - Both commands contain `<worker-api-key>`, `run-agent.`, `start --daemon --hub`, and no
        `Bearer`.
- [ ] Implement, then make the page edits.
- [ ] Snippet checks:
      - `rg -U -n '"cortex-hub": \{\n\s*"url"' apps/dashboard-web/src` matches nothing (`url` now
        follows `type`).
      - `rg -n "mcp-remote" apps/dashboard-web/src` matches nothing.
- [ ] Run `pnpm --filter @cortex/dashboard-web test`, then
      `pnpm --filter @cortex/dashboard-web build`.
- [ ] Manual check with `infra` compose up, twice: once with `EXTERNAL_MCP_URL=https://mcp.example.com`,
      once unset on `localhost`.
      - Settings shows `--hub https://mcp.example.com`, then `--hub http://localhost:8318`.
      - Copy works.
- [ ] Commit (gates first): `feat(dashboard): worker bootstrap command and type http MCP snippet`.

## Task 6: `docs/conductor/setup.md` (new)

**Files:** create `docs/conductor/setup.md`.

**Decisions:**
- One page with per-OS tabs written as `#### macOS`, `#### Linux` and `#### Windows`
  sub-headings.
- Every install command is checked against the vendor's page on the day of writing. A
  "Sources" list at the end gives the URL and date. This plan does not invent the Windows agy
  installer line; copy it from the Antigravity CLI docs.

**Sections and the facts each must state:**

1. **Roles.**
   - One lead: a Claude Code session that plans with the lead key.
   - Any number of worker machines. Each runs one or more workers, one task each (D2); a second
     worker on the same machine uses its own `--agent-id`.
   - The hub dispatches; nobody pushes tasks by hand.
2. **API keys (D7).**
   - Create `lead` and `worker-<host>` keys in Dashboard → Settings → API Keys.
   - Why: lead notices are addressed by key name, and a shared key lets an engine's tool calls
     consume them.
   - On a machine that is both lead and worker, the engines read the same MCP config as the lead.
     State this limitation and that the dashboard still shows everything.
3. **Prerequisites per OS.**
   - Node ≥ 20, checked with `node --version`.
   - `git`.
   - `gh`, logged in with `gh auth login`. Without `gh`, the worker reports a compare URL instead
     of opening a PR.
4. **Engines.** Install, log in and verify each one:
   - **claude:** log in once by running `claude`.
   - **codex:** `codex login`.
   - **gemini:** log in once by running `gemini`.
   - **agy:** `curl -fsSL https://antigravity.google/cli/install.sh | bash`, or the PowerShell
     installer on Windows; then run `agy` once interactively to log in; verify with `agy models`.
   - agy notes:
     - Windows has no `--mode auto`, so the worker uses `accept-edits`.
     - Start-up takes about 2 minutes because of agy's MCP servers; trim its MCP list to speed it
       up.
     - Quota is per model family.
5. **Point each engine at the hub.**
   - **Claude Code:** `claude mcp add --transport http --scope user cortex-hub https://<your-mcp-host>/mcp --header "Authorization: Bearer <worker-api-key>"`,
     plus the equivalent JSON snippet with `"type": "http"`.
   - **agy:** a `~/.gemini/antigravity/mcp_config.json` snippet in the `mcp-remote` form.
   - **Codex:** a `~/.codex/config.toml` snippet.
   - **Warning box:**
     - `agy mcp list` prints MCP secrets in plain text, so never paste its output.
     - Check the URL with a redacting one-liner:
       `node -e "const c=require(require('os').homedir()+'/.gemini/antigravity/mcp_config.json');const s=(c.mcpServers||{})['cortex-hub']||{};console.log(s.url||s.serverUrl||(s.args||[]).find(a=>/^https?:/.test(a))||'no cortex-hub entry')"`.
     - If it is not the current hub, edit the file or rerun `scripts/onboard.sh`.
   - Note that the worker detects the hub and key from these files in §6.12's order, so a worker
     key here is enough.
6. **Install a worker.**
   - The two bootstrap commands, as in Task 5, with placeholders.
   - "or copy them from Dashboard → Settings → Run a worker, which fills in your hub from
     `EXTERNAL_MCP_URL`".
   - The flags `--agent-id`, `--repo`, `--engines claude,agy` and `--capabilities`.
   - State and logs live in `~/.cortex/worker/<agentId>/`.
7. **Check it:** `doctor`, under the name Task 0 recorded.
   - What it checks: Node, git, `gh auth status`, each engine found and logged in, hub reachable,
     key valid, WebSocket handshake, `origin` mapped to a hub project.
   - The fix for each common failure.
8. **Run as a daemon:** `start --daemon`, `status`, `logs -f`, `stop`, `update`.
   - The daemon does not survive a reboot. Starting it on boot is not covered (see the spec gap).
9. **Lead setup.**
   - In the lead machine's Claude Code session, using the lead key, say "Read
     `scripts/orchestrator-prompt.md` and act as the conductor lead".
   - User gates are approved in `/conductor` on the dashboard (D8).
10. **Troubleshooting.**
    - Close codes:
      - 4001: missing key.
      - 4003: bad key.
      - 4000: replaced by a newer connection from the same host.
      - 4009: agent id in use on another host.
    - Wait reasons: `capacity`, `no_worker`, `lock`.
    - The extension shows `/ws/conductor/ws/conductor`: update the extension.
11. **Security.**
    - MCP configs hold keys in plain text.
    - The dashboard API has no user login. Keep it behind access control, because D8 guards
      against agents, not people.

- [ ] Write the page.
- [ ] Check that every snippet in it either has `"type": "http"` (Claude Code) or is labelled agy,
      Codex or Cursor:
      `rg -n -A3 '"cortex-hub": \{' docs/conductor/setup.md`.
- [ ] Commit (gates first): `docs(conductor): per-machine setup guide`.

## Task 7: Rewrite `scripts/orchestrator-prompt.md`

**Files:** rewrite `scripts/orchestrator-prompt.md`.

**Decisions:**
- **No `{{AGENTS_LIST}}`** (per Task 0). The prompt tells the lead to call `cortex_agents`, because
  live data beats a snapshot.
- **No polling loop.** The lead acts on `📋 Conductor:` lines in tool results, and calls
  `cortex_task_list` only when it has nothing else to do.
- **Approve a task only once its PR is merged**, or when its dependents don't need the code. The
  reason: a dependent starts from `origin/<baseBranch>` unless it shares the branch.
  - The lead merges with `gh pr merge --squash` when tests pass and the review is clean, unless
    the user asked to merge.
- **Abandoning or rewriting a task:** there is no edit-description tool (A1 adds `cortex_task_cancel`).
  1. Create a replacement with `cortex_task_tree_create({parentId, tasks:[…]})`.
  2. Repoint the dependents with `cortex_task_route({dependsOn})`.
  3. Cancel the old task with `cortex_task_cancel({taskId, reason})`.

**Sections and the content each must state:**

1. **Role.**
   - You plan and route; workers execute; the hub dispatches in dependency and priority order.
   - Never assign by hand.
2. **Look first:** `cortex_agents` shows each worker's engines and models (`*` means any), its
   capabilities, idle or busy, current task, quota-until per model, and the MCP sessions.
3. **Plan in one call:** `cortex_task_tree_create`. List the fields as a table:
   - `key` (short, unique), `title`, and `description`, which must be self-contained (goal,
     acceptance criteria, files, test command), since agents share no memory.
   - `kind` (`work`, `gate`, `group`), `parentKey`, and `dependsOn` (keys or ids; cycles are
     refused and the cycle is named).
   - `requiredCapabilities`, and `priority` (critical, high, medium or low).
   - `executor`, `model`, `effort`, `fallback`, `pinnedAgent`.
   - `files`, `branch`, `reviewRequired` (default true), `approver`.
   - `context.testCommand`, `context.allowEmpty`, `context.estimate`.
4. **Routing.**
   - Pick only executor and model pairs that `cortex_agents` lists.
   - Leave `executor` null when any engine will do.
   - Order `fallback` from first choice to last: to try another agy model before leaving agy, list
     it first. `null` means the project default (Opus); `[]` means no fallback.
   - Use `pinnedAgent` only for machine-bound work, such as a Windows build or local assets.
5. **Files and locks.**
   - Set `files` on every work task. A directory prefix ends in `/`; no globs.
   - Overlapping paths run one at a time. Tasks without `files` never lock, so they can collide.
6. **Branches and PRs.**
   - The default branch is `cx/{key}-{slug}`.
   - The worker makes the worktree, commits `<key>: <title>`, pushes, and opens the PR or reports
     a compare URL.
   - Descriptions must not tell engines to commit, push or switch branches.
   - Share a `branch` to stack work; otherwise merge before approving (see Decisions).
7. **Review.** On "ready for review":
   1. Call `cortex_task_status` (PR URL, test output, logs).
   2. Run `gh pr diff`.
   3. Call `cortex_task_review(taskId, 'approve')` or `('reject', feedback)`. Feedback must be
      concrete: file, problem, expected result.
   - A rejected task reruns on the same branch with the feedback. Two rejections or two failures
     escalate it.
   - Never create review or "Revision:" subtasks.
8. **Gates.**
   - `kind: 'gate'` with `approver: 'user'` is for art, mockups and plan sign-off. Only the user
     closes it, from the dashboard; MCP calls are refused (D8), so don't try.
   - `approver: 'lead'` gates you close with `cortex_task_review`.
   - Hang downstream work on the gate, not on the task it checks.
9. **Notifications.**
   - Kinds: `review_ready`, `escalated`, `capacity`, `gate_ready`, `no_worker`.
   - Use the lead key, not a worker key.
10. **Escalations and waits.**
    - **escalated:** read the logs and reviews, then call `cortex_task_route` with a new
      executor, model, effort, fallback, pin or files and `clearEscalation: true`; or replace the
      task (see Decisions).
    - **capacity:** wait, or reroute to a model with quota.
    - **no_worker:** reroute, unpin, or ask the user to start a worker with that engine.
    - **lock:** do nothing.
    - Dependents of a cancelled task: `cortex_task_route({dependsOn})`.
11. **Reporting.**
    - After creating the plan, give a summary.
    - On each notice, give progress (`done/total`) and a "Needs you" list (user gates,
      escalations, no-worker tasks).
    - Never put secrets in descriptions.

- [ ] Write the prompt. Target 120 lines or fewer.
- [ ] Contract check: the prompt names only registered tools. This prints nothing:
      `for t in $(rg -o "cortex_[a-z_]+" scripts/orchestrator-prompt.md | sort -u); do rg -q "'$t'" apps/hub-mcp/src/tools || echo "MISSING $t"; done`.
- [ ] Field check against the tree tool schema. This prints nothing:
      `for f in key title kind parentKey dependsOn requiredCapabilities priority executor model effort fallback files branch pinnedAgent reviewRequired approver; do rg -q "\b$f\b" $(rg -l "cortex_task_tree_create" apps/hub-mcp/src/tools) || echo "MISSING $f"; done`.
- [ ] Stale-content check. This matches nothing:
      `rg -n "AGENTS_LIST|assignTo|Poll task status|create a review subtask|Revision:" scripts/orchestrator-prompt.md`.
- [ ] Required-content check. Each of these appears at least once:
      `rg -c "cortex_task_tree_create|cortex_agents|cortex_task_review|cortex_task_route|cx/\{key\}-\{slug\}|approver: 'user'|files" scripts/orchestrator-prompt.md`.
- [ ] Commit (gates first): `docs(conductor): rewrite orchestrator prompt for plan trees`.

## Task 8: `docs/conductor.md`, README and the old design doc

**Files:** modify `docs/conductor.md`, `README.md` (lines ~370-390, ~428, ~468, ~490) and
`docs/architecture/conductor-design.md` (top banner only).

**Decisions:**
- **Status table.** Three columns: Capability, State, Evidence.
  - Evidence is the test file or the doc that proves the row. A row with no passing test cannot
    be ✅.
  - Rows:
    - Plan trees and cycle check.
    - Dispatcher (dependencies, priority, file locks).
    - Per-task routing and fallback.
    - Quota record, wait reason and lead notice.
    - Leases and offline reclaim.
    - Review approve/reject on the same branch.
    - Escalation after two failures or rejections.
    - User and lead gates.
    - The 📋 lead notifications.
    - The TypeScript worker on macOS, Linux and Windows (worktree → PR).
    - Engines: agy ✅, since its quota output was verified; claude, codex and gemini 🔄, since
      their quota patterns are best effort.
    - The dashboard plan view (B).
    - Extension URL detection.
    - The setup guide.
  - Planned: per-task cost; autostart on boot; semantic capability matching; editing a task's description over MCP.
- **Banner** replaces "Experimental": "Production-ready for the rows marked ✅ below; 🔄 and 📋 rows
  are not."
- **Quick Tour.**
  - Step 1 is the bootstrap with `--hub https://<your-mcp-host>`, linking setup.md.
  - Step 2 is a three-task `cortex_task_tree_create` example with `files`, `dependsOn` and one
    user gate.
  - Step 3 is the dashboard.
- **MCP Tools table:** add `cortex_task_tree_create`, `cortex_agents`, `cortex_task_review`,
  `cortex_task_route` and `cortex_task_cancel`.
- **Known Limitations:**
  - Unverified quota patterns.
  - Locks are only as good as `files`.
  - agy start-up takes about 2 minutes.
  - A shared key splits notifications.
  - User gates are dashboard-only, and the dashboard has no login.
  - No MCP tool edits a task's description; replace the task instead.
- **README:**
  - The "Run Agent" block uses the new bootstrap commands. `launch` and `--preset` are gone.
  - Link `docs/conductor/setup.md` next to the conductor link at ~line 428 and in the docs table
    at ~line 490.
  - The tree comment at ~line 468 reads "Worker bootstrap (downloads cortex-worker.mjs from your
    hub)".
- **`docs/architecture/conductor-design.md`:** add one line at the top saying the worker,
  dispatch and review parts are superseded by the 2026-10-16 spec, with a link.

- [ ] Make the edits.
- [ ] Link check. This prints nothing:
      `rg -o "\]\(([^)#]+\.md)" -r '$1' docs/conductor.md docs/conductor/setup.md README.md | while IFS=: read f p; do d=$(dirname "$f"); [ -e "$d/$p" ] || echo "BROKEN $f -> $p"; done`.
- [ ] Commit (gates first): `docs(conductor): status, quick tour and setup links`.

## Task 9: Repo-wide checks and final gates

**Files:** none (fix any hit in the file that owns it).

- [ ] **WebSocket URLs.** Every one has `/ws/conductor`. This prints nothing:
      `rg -n --pcre2 -e "wss?://[A-Za-z0-9<\[{\$][^\s\"'\`)]*" README.md docs apps/cortex-extension/src apps/cortex-extension/package.json apps/dashboard-web/src scripts/orchestrator-prompt.md -g '!docs/superpowers/**' | rg -v "/ws/conductor"`.
- [ ] **Stale worker invocations.** This prints nothing:
      `rg -n -e "antigravity -p|--yolo|--preset|bash -s -- launch" README.md docs scripts apps/cortex-extension apps/dashboard-web/src -g '!docs/superpowers/**' -g '!scripts/cortex-agent.*' -g '!**/node_modules/**' -g '!**/dist/**'`.
      The deprecated `cortex-agent.*` belong to A2.
- [ ] **Claude Code snippets.** None lack `type`. This prints nothing:
      `rg -U -n -e '"cortex-hub": \{\n\s*"url"' README.md docs apps/dashboard-web/src -g '!docs/superpowers/**'`.
      The Task 4 counts still hold.
- [ ] **Secrets.**
      - No literal Bearer token. This prints nothing:
        `rg -n --pcre2 -e 'Bearer (?!<|\$|\{)[A-Za-z0-9._~+/=-]{12,}' README.md docs apps/cortex-extension/src apps/dashboard-web/src scripts/orchestrator-prompt.md -g '!docs/superpowers/**'`.
      - Not the maintainer's hub host. The host is computed at run time and never printed; this
        prints nothing:
        `H=$(node -e "try{const c=require(require('os').homedir()+'/.claude.json');const s=(c.mcpServers||{})['cortex-hub']||{};const u=s.url||(s.args||[]).find(a=>/^https?:/.test(a));const h=u&&new URL(u).hostname;if(h&&h!=='localhost')process.stdout.write(h)}catch{}"); [ -z "$H" ] || rg -l -F "$H" README.md docs apps scripts -g '!**/node_modules/**' -g '!**/dist/**'`.
- [ ] **Domains.** Only allowed domains appear in the new docs:
      `rg -o --no-filename -e "https?://[^\s)\"'\`>]+" docs/conductor/setup.md docs/conductor.md scripts/orchestrator-prompt.md | sort -u | rg -v "^https?://(<your-mcp-host>|localhost|127\.0\.0\.1|([a-z0-9-]+\.)?example\.com|raw\.githubusercontent\.com/lktiep/|github\.com/|cli\.github\.com|antigravity\.google|claude\.ai|docs\.anthropic\.com|code\.claude\.com|nodejs\.org|git-scm\.com|developers\.openai\.com|ai\.google\.dev)"`
      prints nothing. The vendor domains are trimmed to the ones the Sources list actually uses.
- [ ] **Unit tests:** `pnpm --filter cortex-agent test`, `pnpm --filter @cortex/dashboard-web test`
      and `bash scripts/test-hooks.sh` all pass.
- [ ] **Docs checklist,** ticked in the PR body:
      - setup.md has all 11 sections.
      - The per-OS prerequisites are there.
      - Install and login for the 4 engines are there.
      - D7 keys.
      - The `agy mcp list` warning and the redacting check.
      - The bootstrap commands.
      - `doctor`.
      - The daemon commands.
      - The close codes.
      - conductor.md has the evidence column.
      - The README links resolve.
- [ ] **Gates last:** `pnpm build && pnpm typecheck && pnpm lint`. All green; paste the tail of
      each into the PR.
- [ ] Commit any fixes (gates first), push the branch, run
      `cortex_code_reindex(repo: "cortex-hub", branch: <branch>)`, and open the PR. The PR body
      lists the contract extensions, the Task 0 facts, the Task 4 writer list and manual checks
      that were not run.

---

## Self-review

- **Spec §8 coverage:**
  - setup.md is Task 6.
  - The extension's `resolveHubUrl`/`readMcpArgsUrl` reading `url`/`headers` and adding
    `/ws/conductor` are Tasks 2-3.
  - The agy snippet on the current hub and the Claude snippet with `"type": "http"` are Tasks 4,
    5 and 6.
  - The dashboard bootstrap from `EXTERNAL_MCP_URL` is Task 5.
  - The orchestrator prompt is Task 7, and conductor.md and its links are Task 8.
- **W6** is fixed in Tasks 2-3, including the double `/ws/conductor` that the spec does not list.
- **D7** is covered in setup.md §2 and the prompt §9; **D8** in setup.md §9, the prompt §8 and the
  Known Limitations.
- **Each Review Focus line has its check in the owning task:** 1 → Tasks 2 and 3; 2 → Task 2;
  3 → Tasks 4 and 5; 4 → Tasks 5 and 9; 5 → Task 7.
- **No placeholders left to the implementer** except one: the Windows agy installer line. It must
  be copied from the vendor docs, and Task 6 says where.
- **Logging:** `extension.ts:762` already logs only the key's last 8 characters. Task 3 adds
  `hubSource` to that line and does not widen what is logged.
- **Names are consistent:** `toConductorWsUrl`, `detectHub`, `conductorConnectUrl`,
  `DEFAULT_HUB_WS_URL`, `workerBootstrap` and `RUN_AGENT_RAW` are each used under one name
  throughout.
