# Identity, roles and organization-bound API keys — design

> Status: **draft for review** · 2026-10-25 · branch `docs/identity-roles-spec`
> Spec only. Nothing here is implemented; the phases in §7 are separate pull requests.

## 1. Goal

Today the hub knows *which key* is calling, but not *which person* it acts for, and not *which
organizations* it may touch. The organization comes from each call's parameters. This spec closes that
gap and gives people roles, without building a login system.

It is written for this deployment model:

- The **dashboard and API** are deployed behind an identity-aware proxy (Cloudflare Access) and are not
  meant to be reachable directly. Human identity is the proxy's signed assertion (the email in the JWT).
- The **MCP endpoint is public by design**, so agents on any machine can use it. An API key is its only
  control.
- **Agents keep using API keys.** A key acts on behalf of the person it belongs to.

### Success criteria

1. A key can read or write only the organizations it was bound to, however its calls are phrased
   (`org`, `projectId`, `repo`, a memory `userId`, a task id).
2. Every key belongs to a person and acts with that person's role in each organization, capped by the
   key's own tool list.
3. A human reaches the dashboard API through the proxy and gets the role mapped to their email. No
   password, session or user table of credentials is added.
4. Removing a person from an organization, or revoking a key, stops data access at the API at once.
5. An existing install keeps working after the upgrade. Binding is introduced in warn mode first.

### Non-goals

A login or password system; SSO beyond what the proxy provides; per-file or per-branch ACLs; billing;
syncing groups from the identity provider (see §8, question 6).

## 2. Current state (verified 2026-10-25, v1.4.1)

| # | Where | What happens |
|---|---|---|
| C1 | `apps/dashboard-api/src/routes/keys.ts:131-163` | `POST /api/keys/verify` answers `agentId` (the key's **name**), `scope`, `permissions`. No person, no organization. |
| C2 | `apps/dashboard-api/src/db/schema.sql:7-17` | `api_keys` has `name` (not unique), `scope`, `permissions`, and a `project_id` that `routes/keys.ts` never reads or writes. |
| C3 | `apps/hub-mcp/src/api-call.ts:23-27` | hub-mcp forwards the key's name as `X-API-Key-Owner`. About 80 places in 13 dashboard-api files read that name as the caller's identity (`session_handoffs.api_key_name`, conductor owners, `tasks.ts:147`, `stats.ts` heartbeats). Two keys with one name are one caller. |
| C4 | `apps/dashboard-api/src/routes/intel.ts:152-179` | `resolveOrgScope` takes an explicit `orgId` from the call, else the project the call names, else the organization of the key's latest session, else the only organization with code. Nothing compares the result with what the key may use. |
| C5 | `apps/dashboard-api/src/lib/session-project.ts:15-33` | The session of a key *name* decides the default project and organization for intel, knowledge recall and memory. |
| C6 | `apps/dashboard-api/src/routes/mem9-proxy.ts:110-115,133` | A memory scope is `project-<id>` straight from the client-supplied `userId`. Any other id falls into a shared bucket. |
| C7 | `apps/dashboard-api/src/lib/project-guard.ts:6,19-61` | Checks that the named project exists and is enabled, not that the caller may use it. `/api/keys`, `/api/settings`, `/api/webhooks` and others bypass it. |
| C8 | `apps/dashboard-api/src/lib/project-match.ts:36-43` | `findProjectByRepo` falls back to `slug LIKE %name%` across all organizations. |
| C9 | `apps/dashboard-api/src/lib/api-auth.ts:153-186` | The Access JWT is verified (`accessVerifier`, line 98) and its email is returned as a string, then the middleware calls `next()`. The identity is dropped. A valid API key as `Bearer` is accepted for **every** `/api` route, including `/api/keys`. |
| C10 | `apps/hub-mcp/src/middleware/auth.ts:14,99-105` | hub-mcp caches a verified key for 2 minutes. |
| C11 | `packages/shared-types/src/mcp-tools.ts:68-71` | A key's tool list only grants the tools it names. It says nothing about organizations. |

Consequence: a key issued for one organization can ask for another's code, memory or knowledge by naming
it, and the API will answer. The proxy does not help, because the MCP endpoint is the path agents use.

## 3. Model

### 3.1 People and identities

```
people(id, display_name, status 'active'|'disabled', instance_admin 0|1, created_at)
person_identities(person_id, kind 'access-email'|'access-service', subject, UNIQUE(kind, subject))
```

- A human's `subject` is the lower-cased `email` claim of the Access JWT.
- An Access **service token** carries `common_name`, not an email (`api-auth.ts:121`). It maps to a
  person only if an admin adds an `access-service` identity for it; otherwise it is refused wherever a
  role is required.
- A person is created by an admin, or on first sight of an email the bootstrap rule allows (§5.4).
- `status = 'disabled'` stops the person and all their keys.

### 3.2 Organizations and roles

```
org_members(org_id, person_id, role 'owner'|'admin'|'member'|'viewer', UNIQUE(org_id, person_id))
```

| Action in an organization | viewer | member | admin | owner |
|---|:-:|:-:|:-:|:-:|
| Search code, memory, knowledge; read tasks and sessions | ✓ | ✓ | ✓ | ✓ |
| Store memory and knowledge; run sessions; create and update tasks | | ✓ | ✓ | ✓ |
| Register, edit, move, index and delete projects; manage git accounts | | | ✓ | ✓ |
| Manage members and roles of the organization | | | ✓ | ✓ |
| Delete the organization; assign owners | | | | ✓ |

`people.instance_admin` covers what belongs to no organization: creating organizations, managing
people and identities, settings, and viewing every key. The default organization `org-default`
(`session-project.ts:7`) is an ordinary organization with ordinary members.

### 3.3 Keys

```
api_keys   + person_id        -- the person the key acts for
           + kind             -- 'agent' | 'service'
           + max_role         -- optional cap, default 'member'
api_key_orgs(key_id, org_id)  -- the organizations the key may touch
```

- A key's **organizations** are the intersection of `api_key_orgs` with the person's memberships.
- Its **role** in an organization is `min(person's role, max_role)`. The default cap `member` means a
  leaked agent key cannot manage members or projects even when its owner is an admin. Raising the cap is
  an explicit act by that person (§8, question 1).
- Its **tools** are still the key's tool list (C11). Tools and organizations are independent limits;
  a call needs both.
- A `service` key (CI, a Conductor worker) is owned by a *responsible person*, not exempt from the model.
- `api_keys.project_id` (C2) is dropped, or reused as an optional narrowing *within* the key's
  organizations. This spec recommends reusing it, so one key can be pinned to one repository.
- The key's **id** (`key_...`), not its name, is the identity from here on (§4.2).

## 4. Enforcement

### 4.1 One resolver for "may this key do this"

A single function in `apps/dashboard-api/src/lib/` takes a key id and returns its effective grant:
`{ keyId, personId, orgs: Map<orgId, role>, tools, projectId? }`, read from SQLite on every request. It
is the only place that decides. Everything below calls it; none of it re-implements the rule.

### 4.2 The channel from hub-mcp

hub-mcp keeps authenticating the key (C10) and filtering the tool list. For data access it forwards the
**key id** as `X-Cortex-Key-Id` over the existing internal channel (`X-Internal-Secret`), instead of the
name. dashboard-api trusts the id only as "which key", and re-reads the grant from the database. Result:

- revoking a key, or removing a person from an organization, takes effect at the API on the next request;
  hub-mcp's 2-minute cache (C10) now only delays *tool-list* changes, and the existing invalidation call
  (`keys.ts:9-31`) still clears it;
- a forged name no longer selects a session or an organization.

`X-API-Key-Owner` stays during migration so the ~80 call sites keep working, and moves to the key id
there (§6).

### 4.3 Organization resolution

`resolveOrgScope` (C4) keeps its order but ends with a check against `grant.orgs`:

1. An explicit `orgId` outside `grant.orgs` is refused (403).
2. A named project or repo outside `grant.orgs` is answered as **not found**, not 403, so existence does
   not leak.
3. A session's organization (C5) is used only if it is in `grant.orgs`; the session lookup is keyed by key
   id.
4. Several organizations and nothing to choose between them is refused, as today
   (`intel.ts:176-178`), naming the candidate organizations of the **key**, not of the instance.

After this, `org` in a tool call selects among the key's organizations. It never grants one.

### 4.4 Where the check goes

| Surface | Change |
|---|---|
| `projectGuard` (C7) | Also requires the project to be in `grant.orgs`, for the key path. The bypass list is replaced by an explicit per-route role requirement. |
| `intel.ts`, `knowledge.ts`, `quality.ts`, `tasks.ts`, conductor routes | Take the grant from the request context instead of reading the header. |
| Memory (C6) | A `project-<id>` scope must be in `grant.orgs`. Other ids are rewritten to a per-person scope (§8, question 2). |
| `findProjectByRepo` (C8) | Takes the key's organizations and matches only inside them; the `LIKE` fallback never crosses an organization. |
| Webhooks and new ingestion tools | A report names a repo; it is accepted only for a project in `grant.orgs`, with the key's id recorded as the source. |

### 4.5 Human requests

`apiAuth` stops discarding the proxy identity (C9). `accessVerifier` returns the claims instead of a
string, and the middleware stores `principal = { kind: 'human', personId, email }` on the request context
after mapping the identity (§3.1). A route states what it needs:
`requireRole('admin', { org })` or `requireInstanceAdmin()`. Routes with no requirement keep today's
behaviour for a request that passed the proxy.

A `Bearer` API key on `/api` (C9) is authorized as the key's grant, with `max_role` applied. In
particular, a default key (`member` cap) can no longer create or delete keys through `/api/keys`.

## 5. Behaviour at the edges

1. **Solo installs (`API_AUTH=off`).** There is no proxy and no email. A synthetic local person is
   instance admin and owner of every organization; every key binds to it and to all organizations. This
   is exactly today's behaviour, and the dashboard says so.
2. **Several organizations, no hint.** Refused with the key's own candidate list (4.3.4).
3. **A key with no organization in common with its person** (person removed from the org): the call is
   refused with a message naming the missing membership, not "invalid key".
4. **Bootstrap.** With `API_AUTH=required` and no people yet, the email in `CORTEX_BOOTSTRAP_ADMIN` that
   arrives with a valid Access assertion becomes instance admin and owner of `org-default`. Without that
   variable the first request creates nothing and the log says what to set. The first Access identity is
   deliberately **not** auto-promoted: anyone who can pass the proxy would become admin.
5. **Disabled person.** Their human requests and all their keys fail with a distinct error.

## 6. Migration

`API_KEY_BINDING` controls how unbound keys (`person_id IS NULL`) behave:

| Mode | An unbound key |
|---|---|
| `off` | Works as today. |
| `warn` (**default** for the first release) | Works as today, with a startup warning, a dashboard badge and one hint line per session telling the owner how to bind it. |
| `required` | Refused at verify with a message that says how to bind it. |

Steps:

1. Add the tables and columns; create the local person on solo installs; backfill nothing else.
2. An admin binds each key in the dashboard (choose a person and organizations). A one-click
   "bind all existing keys to me and all organizations" serves solo installs.
3. Add a key-id column beside each place that stores the key's name today (`session_handoffs.api_key_name`
   and the conductor task owners; `query_logs` stores `agent_id`, which is the same name). Backfill by
   name **only where the name is unique**; ambiguous rows keep the name and are matched by it as before.
   This is the part most likely to need care. Files that read the name as identity (a search, not a
   proof of completeness): `session-project.ts`, `intel.ts`, `quality.ts`, `tasks.ts`, `conductor/*`,
   `routes/conductor.ts`, `ws/conductor.ts`, `services/file-notes.ts`, `mem9-proxy.ts`, `knowledge.ts`,
   `stats.ts`.
4. The default flips to `required` two minor releases after binding ships, announced in the release notes.
5. Keys with an explicit tool list keep it. New tools reach them only when someone adds the permission;
   migrations like `key-permissions-migration.ts` can grant them where the old list implied them.

## 7. Implementation phases

Each is its own PR, with tests that run the same checks against two organizations.

| Phase | Change | Behaviour change |
|---|---|---|
| 1 | Schema, `people`, `org_members`, the resolver, `principal` on the request context. | None. |
| 2 | `keys/verify` and the key API return and accept person and organizations; dashboard UI to bind. | None in `warn`. |
| 3 | `X-Cortex-Key-Id`; `resolveOrgScope`, `projectGuard`, `findProjectByRepo` enforce `grant.orgs`. | Cross-organization access is refused for bound keys. |
| 4 | Role requirements on dashboard routes; the `/api/keys` rule; memory and knowledge scopes. | Humans and keys are limited by role. |
| 5 | Default `API_KEY_BINDING=required`. | Unbound keys stop working. |

The cross-organization matrix test is the acceptance test of phase 3: for every route that takes `org`,
`projectId`, `repo`, a memory `userId` or a task id, a key bound to organization A must get nothing from
organization B, however the call is phrased.

## 8. Open questions for the maintainer

1. **Cap on key roles.** Is `member` the right default `max_role`, so a leaked agent key cannot manage
   members, projects or keys? Or should a key simply inherit its person's role, as first described?
2. **Shared memory bucket.** Memory with no project goes to one shared bucket (C6). Should it become a
   per-person scope, which orphans memories already in the shared bucket, or stay shared inside a
   single-organization install?
3. **Service keys.** Are CI and Conductor-worker keys owned by a responsible person (proposed), or do you
   want a separate service principal?
4. **`viewer`.** Is a read-only role needed on day one, or can it wait?
5. **Bootstrap.** Is `CORTEX_BOOTSTRAP_ADMIN` acceptable, or is there a preferred first-run step?
6. **Groups.** Should a later phase map identity-provider groups (from the Access token) to roles, or is
   per-email membership enough?
7. **`api_keys.project_id`.** Reuse it as a narrowing inside the key's organizations (proposed), or drop
   it?
