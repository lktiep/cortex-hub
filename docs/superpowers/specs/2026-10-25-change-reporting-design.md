# Telling agents what others are changing — design note

> Status: **draft for review** · 2026-10-25 · branch `docs/change-reporting-design`
> A short design note, not a full spec. It asks for two decisions (§7) before any code is written.
> Related: `2026-10-25-identity-roles-org-bound-keys-design.md`.

## 1. Goal

An agent that is about to edit code should hear, without asking, that someone else is working on or has
changed the same area. Outside Conductor (which has leases and file locks) nothing does that today. This
note says why, and proposes a way to build it that fits the deployment model: developer machines can
reach the **MCP endpoint** with an API key, and cannot reach the dashboard API, which sits behind an
identity-aware proxy.

## 2. Current state (verified 2026-10-25, v1.4.1)

| # | Where | What happens |
|---|---|---|
| S1 | `lefthook.yml:36-49`, `scripts/install.sh:3163`, `scripts/onboard.sh:606` | A `post-push` block posts to `/api/webhooks/local-push`. **Git has no `post-push` hook.** In a scratch repo with `pre-push`, `post-push` and `post-commit` scripts, one commit and one push ran `post-commit` and `pre-push` and never `post-push`. lefthook installs a `.git/hooks/post-push` stub that git never calls. |
| S2 | `webhooks.ts` | There is no `/local-push` route. The real route is `POST /api/webhooks/push`. |
| S3 | `webhooks.ts:12-17` | `/push` accepts only tokens listed in the `MCP_API_KEYS` environment variable, not keys issued from the dashboard. |
| S4 | `lefthook.yml:45-48` | The hook sends no `Authorization` header, discards every failure (`curl` output to `/dev/null`, then `true`), and it builds JSON by pasting the commit message into a string, so a quote in a message breaks it. |
| S5 | `lib/project-guard.ts:6` | `/api/webhooks` is in the guard's bypass list, so nothing checks that the project is enabled. |
| S6 | `hub-mcp/src/tools/changes.ts:103` | `fetchUnseenChanges` is called only by the `cortex_changes` tool. Nothing puts changes into other responses, so an agent sees them only if it remembers to call the tool. |
| S7 | `dashboard-api/src/routes/stats.ts:832-836` | The hints engine appends one or two lines to every MCP tool response. Its own comment calls it the only steering channel that reaches every client, and warns that a hint that fires on every call gets skipped. |
| S8 | `dashboard-api/src/routes/quality.ts:449`, `stats.ts:454-481` | `session_handoffs` already holds, per session: project, **branch**, hostname, IDE, role and `last_activity` (touched on each tool call). |
| S9 | `docs/architecture/agent-quality-strategy.md:265-281` | cortex adds its hook to `lefthook.yml`, or to `lefthook-local.yml` when the repo owns its hooks, and to nothing for husky, pre-commit or a hooks directory. |

So the `change_events` table is empty in practice, and fixing the URL, the auth and the JSON would still
produce no event, because nothing triggers the hook.

## 3. Three signals

| Signal | Source | Tells an agent | Needs |
|---|---|---|---|
| **Presence** | `session_handoffs` (S8) | "2 other agents are active on this repo: branch `feat/x`, claude-code on host-a, 3 min ago" | Nothing new. No git hook, no new write path. |
| **Git events** | `post-commit` and `pre-push` hooks reporting to the hub | "branch `feat/x` changed `routes/intel.ts`, `lib/diff-symbols.ts`" | A report tool, a hook, a permission, trust rules (§4). |
| **Edit events** | An agent hook after each edit reporting the touched file | "an agent edited `routes/intel.ts` 1 min ago" | Same as git events, plus an agent-side hook per IDE. |

Presence has no file detail, and isolated worktrees are the common case, so conflicts appear at merge
time rather than on a shared file. It still answers the first question ("is anyone else here?") for free.
Git events give files. Edit events give the earliest warning and the most noise.

**Proposal:** ship presence first, then git events, and decide on edit events later with real data.

## 4. Git events: how to build them

### 4.1 Trigger

Report from **`post-commit`** (kind `committed`, works in worktrees, fires for commits that are never
pushed) and **`pre-push`** (kind `pushed`). `pre-push` receives the remote name and URL as arguments and
`<local ref> <local sha> <remote ref> <remote sha>` lines on stdin (verified in the scratch repo), which is
enough to list the changed files per ref. It runs before the push completes, so the report may describe a
push that then fails; the event carries the kind, and a consumer can treat `pushed` as "probably".
The hook runs in the background with a short timeout and must never block or fail a git operation.

### 4.2 Transport

Developer machines reach the hub through the MCP endpoint with the agent's key. Add an MCP tool, for
example `cortex_report_change`, that takes `repo`, `branch`, `kind`, `commitSha`, `commitMessage` and
`files`. The reporting agent is the authenticated key, **never a parameter** (today `cortex_changes` takes
`agentId` as an argument, `changes.ts:93`, which any caller can set to anyone).

The hook should reuse what the repo's agent hooks already do. `.claude/hooks/recall-notes.sh:44-90` finds
the hub URL and key from `CORTEX_MCP_URL`/`HUB_MCP_URL` and `HUB_API_KEY`, else from each IDE's MCP
config, sends `tools/call`, and reads a JSON or SSE reply. No new environment variables. A git hook runs
outside any agent, so the helper has to ship with the installer; where it lives is question 2 in §7.

### 4.3 Credentials

The remote URL can carry a token (`https://user:token@host/o/r.git`), and `pre-push` is handed that URL.
The hook strips userinfo before sending, and the server strips it again before matching or storing, so a
careless client cannot leak one. `lib/git-credentials.ts` already parses repo URLs (`parseRepoUrl`).

### 4.4 Trust rules

A report is text that the hub later shows to **other agents**. Until keys are bound to organizations (see
the identity spec), any valid key could name another organization's repository and plant lines in its
agents' context. So the first version:

1. Accepts a report only for a project in the **organization of the key's own active session**
   (`projectOfActiveSession`, `lib/session-project.ts:15`), and says plainly that this is a stopgap.
2. Matches the repo by **exact normalized URL** only. `findProjectByRepo` has a `slug LIKE %name%`
   fallback across all organizations (`lib/project-match.ts:36`) that must not be used here.
3. Checks that the project exists and is enabled, since the guard does not run on this path (S5).
4. Caps lengths and file counts, and removes control characters and newlines from the commit message and
   paths.
5. Shows reported text to agents as quoted data with the reporter's name, never as an instruction.
6. Records the **key id**, so events can be attributed, and expired, when keys are bound.

When the identity spec lands, step 1 becomes "a project in the key's organizations".

### 4.5 Permissions

A key's tool list only grants the tools it names (`packages/shared-types/src/mcp-tools.ts:68-71`). The
new tool needs an entry in `MCP_TOOL_PERMISSIONS` (hub-mcp's tests require it), and keys that hold
`cortex.changes` today need a migration like `key-permissions-migration.ts`, or the hook reports nothing
for them. A refusal must print one visible line, not be swallowed as it is now.

### 4.6 Coverage

The hook only exists where the installer wrote lefthook configuration (S9). Repos on husky or other hook
managers get no reports. The note should say so in the docs rather than imply coverage.

## 5. Showing it to the agent

- **Session start and hints (S7).** One line, once per new event or new peer, never repeated on every
  call: "2 other agents active here: …" or "branch `feat/x` changed `routes/intel.ts` 12 min ago".
- **Before an edit.** `recall-notes.sh` already runs before edits and shows per-file notes. Recent
  changes to the same file belong in that same surface.
- **`cortex_changes`** stays as the explicit query, but needs `agentId` from the key, not a parameter
  (§4.2), and should read the same data.

## 6. Presence slice, in detail

Reads only `session_handoffs`:

- Other **active** sessions in the **same project** (and so the same organization), excluding the
  caller's own session.
- Only sessions with recent `last_activity`. The expiry job marks sessions idle after hours
  (`services/session-expiry.ts`), far too long for "is someone here"; use a short window such as 30
  minutes, in one constant.
- At most three lines, each: branch, IDE, host, minutes since last activity. If the caller's branch
  equals another session's branch, say so first.
- Appears in the `cortex_session_start` answer, and in the hints at most once per new peer.
- No sessions, no line.

## 7. Decisions needed

1. **Order.** Presence first, then git events (proposed), or git events first?
2. **Where does the git-hook helper live?** Options: a small Node file the installer copies next to the
   hooks (proposed, reuses the discovery code), or a `curl` one-liner that needs a new URL and key
   variable.
3. **Triggers.** `post-commit` plus `pre-push` (proposed), or only `pre-push`?
4. **Edit events.** In scope later, or never?
5. **Interim trust.** Is "the organization of the key's active session" acceptable as the stopgap in §4.4
   until keys are bound, or should reporting wait for the identity work?
