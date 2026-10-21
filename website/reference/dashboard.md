# Dashboard

The dashboard is a Next.js app (`apps/dashboard-web`) served by the `cortex-api` container on port
4000. It shows what the hub knows and is where people, not agents, make decisions: API keys, LLM
providers, user gates.

::: warning
The dashboard has no login. Anyone who can open it can create keys and approve gates. Keep it on a
private network or behind an access proxy, and set `API_AUTH=required`. See
[Self-host](../guide/self-host#put-it-on-the-internet).
:::

## Pages

| Page | Path | What is on it |
|---|---|---|
| Dashboard | `/` | System overview: savings from cortex tools, intelligence, quick connect, recent activity, system resources |
| Organizations | `/orgs` | Organizations and their projects. Add a repo (GitHub, GitLab, Bitbucket, Azure or local), with an optional token for private repos. Cross-repo search stays inside one organization |
| Project | `/projects?id=…` | One project: indexing progress, branches, re-index, re-run memory embedding, scan the repo's docs into knowledge, move it to another organization, delete it |
| Knowledge | `/knowledge` | The knowledge base by project: documents, chunks, search hits, and the files each note is shown for |
| API Keys | `/keys` | Create, edit and revoke the keys agents and workers use. A new key is shown once |
| LLM Providers | `/providers` | Providers (API key or OAuth) and the routing of the chat and embedding models, with fallbacks |
| Usage | `/usage` | Token use and requests over time, and the savings of cortex tools over 7 days |
| Quality | `/quality` | Quality reports, scored on four dimensions |
| Conductor | `/conductor` | Plans as trees, live agent cards, task details, **Needs you**, user gates, **Delete pipeline** |
| Sessions | `/sessions` | Agent sessions and handoffs, with their details |
| Settings | `/settings` | Endpoints and remote access, MCP config to copy, how to run a worker, LLM switches, hub configuration, notification preferences, Docker services, environment |
| Setup | `/setup` | The first-run wizard: welcome, provider sign-in, model selection |

## What agents see of it

Everything on the dashboard comes from the same API the MCP tools use. An agent's
`cortex_quality_report` shows on **Quality**, its session on **Sessions**, its knowledge on
**Knowledge**, its Conductor tasks on **Conductor**. Only people approve
[user gates](../conductor/review#gates); MCP calls are refused.
