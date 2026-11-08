# Security Policy

## Supported versions

Cortex Hub releases continuously from `master`. Security fixes go into the latest release only; update
to the newest image tag (`:latest`, or `:stable` for tagged releases) to receive them.

## Reporting a vulnerability

**Please do not open a public issue, pull request or discussion for a security problem.**

Report it privately through GitHub: open the repository's **Security** tab and choose
**Report a vulnerability**. Include:

- what you found and which component it affects (`hub-mcp`, `dashboard-api`, `dashboard-web`,
  `conductor-worker`, an install script, or the Docker stack),
- the version or commit,
- steps to reproduce, and the impact you expect,
- whether it is already public.

You can expect an acknowledgement, and we will keep you updated until it is fixed. Please give us a
reasonable chance to release a fix before you disclose it.

## What is in scope

- Authentication and authorization on the MCP gateway (`hub-mcp`) and the Dashboard API.
- Exposure of stored data: memories, knowledge, code indexes, API keys, and project git credentials.
- The install scripts and the `infra/docker-compose.yml` stack, including ports they publish.
- The Conductor worker and the hooks and templates the installers write into a user's project.

Findings that need an already-compromised host, or a deployment that deliberately turns protections
off (for example `API_AUTH=off` on a public address), are out of scope, but we are glad to hear about
unsafe defaults.

## Deployment model, and how it sets severity

Cortex Hub is designed to run as two surfaces with different exposure. We rate a report by which one
it affects.

| Surface | Intended exposure | Protected by |
|---|---|---|
| **MCP endpoint** (`hub-mcp`, `/mcp`) | Internet-facing, so agents on any machine can use it | API keys only |
| **Dashboard and API** (`dashboard-web`, `dashboard-api`, `/api`) | Never reachable directly | An identity-aware proxy in front of it, such as Cloudflare Access |

**The MCP endpoint is high severity.** An API key is its only control, so anything that gets past the
key check, or that lets a valid key reach data it should not (another organization's memories,
knowledge, code index or projects, or a tool its key does not allow), is a high-severity issue.

**The Dashboard and API must sit behind an identity-aware proxy and must not be exposed directly.**
A weakness there matters mainly when it works without passing the proxy. One that needs a user who
has already been admitted by the proxy is rated lower.

To deploy it that way:

- Publish the API ports on loopback only (`API_BIND=127.0.0.1`) when the tunnel or reverse proxy runs
  on the same host.
- Set `API_AUTH=required`, with `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` for Cloudflare Access. The
  proxy is the front door; this setting is defense in depth if it is ever bypassed or misconfigured.
- Keep the MCP endpoint reachable by agents, and give each agent its own key (see below).

## Hardening a deployment

Cortex Hub stores your code index, agent memory and git credentials, so treat the host as sensitive.

| Setting | Why |
|---|---|
| `API_AUTH=required` | The Dashboard API answers anyone when this is `off` (the compose default). `required` accepts only loopback, the MCP gateway, API keys and, with `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` set, browsers that came through Cloudflare Access. |
| `INTERNAL_API_SECRET` | The shared secret the MCP gateway sends to the API. Set it to a long random value on both services when `API_AUTH=required`. |
| `MCP_API_KEYS` / dashboard-issued keys | Give each agent its own key with only the tool permissions it needs, and revoke keys you no longer use. Keys are stored hashed. |
| `API_BIND=127.0.0.1` | Publish the API only on loopback when a tunnel or reverse proxy on the same host is the entry point. The default publishes on every interface. |
| Don't publish Qdrant, GitNexus or Ollama | They have no per-user authentication. The compose file binds Qdrant and GitNexus to loopback and does not publish Ollama or the LLM proxy; keep it that way. |
| Protect the data volumes | Git tokens saved for a project are kept in the API's SQLite database, so anyone who can read the `cortex-api-data` volume can read them. Use a token with the least scope that works (read-only repo access) and keep volume backups private. |
| Review Watchtower | The optional Watchtower service mounts the Docker socket and pulls new images automatically. Remove it, or pin image tags, if you do not want automatic updates with that level of access. |
| Put TLS in front | Terminate TLS at a tunnel or reverse proxy. Do not expose the plain HTTP ports directly to the internet. |

## Disclosure

Once a fix is released we credit reporters in the release notes unless they ask us not to.
