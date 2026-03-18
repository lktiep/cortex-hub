# Hub MCP API Reference

> Complete reference for all tools exposed by the Cortex Hub MCP Server.

---

## Authentication

All requests require a valid API key in the `Authorization` header:

```
Authorization: Bearer <API_KEY>
```

Keys are issued per-agent and configured as Cloudflare Worker secrets. Invalid or missing keys return `401 Unauthorized`.

---

## Tool Groups

### `code.*` — Code Intelligence (via GitNexus)

#### `code.query`

Search the code knowledge graph for execution flows related to a concept.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `repo` | string | ✓ | Repository name |
| `query` | string | ✓ | Natural language or keyword search |
| `goal` | string | — | What you want to find (improves ranking) |
| `limit` | number | — | Max processes to return (default: 5) |

```json
{
  "tool": "code.query",
  "params": {
    "repo": "keothom",
    "query": "auction bidding logic",
    "goal": "understand how bids are placed"
  }
}
```

#### `code.context`

360-degree view of a single code symbol — callers, callees, imports, process participation.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `repo` | string | ✓ | Repository name |
| `name` | string | ✓ | Symbol name (function, class, method) |
| `include_content` | boolean | — | Include full source code (default: false) |

#### `code.impact`

Analyze the blast radius of changing a code symbol.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `repo` | string | ✓ | Repository name |
| `target` | string | ✓ | Symbol name to analyze |
| `direction` | string | ✓ | `upstream` (what depends on this) or `downstream` |
| `maxDepth` | number | — | Max traversal depth (default: 3) |

**Response includes:**
- Risk level: `LOW` / `MEDIUM` / `HIGH` / `CRITICAL`
- Affected symbols grouped by depth
- Affected execution flows
- Affected modules

#### `code.detect_changes`

Analyze uncommitted git changes and find affected execution flows.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `repo` | string | ✓ | Repository name |
| `scope` | string | — | `unstaged`, `staged`, `all`, or `compare` |

#### `code.cypher`

Execute raw Cypher queries against the code knowledge graph.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `repo` | string | ✓ | Repository name |
| `query` | string | ✓ | Cypher query string |

---

### `memory.*` — Agent Memory (via mem0)

#### `memory.add`

Store a memory for the calling agent.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `content` | string | ✓ | Memory content |
| `metadata` | object | — | Additional metadata tags |

#### `memory.search`

Search agent memories by semantic similarity.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | ✓ | Search query |
| `limit` | number | — | Max results (default: 10) |
| `agent_id` | string | — | Filter by agent (default: calling agent) |

#### `memory.list`

List recent memories for the calling agent.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `limit` | number | — | Max results (default: 20) |

---

### `knowledge.*` — Knowledge Base (via Qdrant)

#### `knowledge.search`

Semantic search across the shared knowledge base.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | ✓ | Search query |
| `project` | string | — | Filter by project |
| `domain` | string | — | Filter by domain (e.g., `cloudflare`, `supabase`) |
| `limit` | number | — | Max results (default: 10) |

#### `knowledge.get`

Retrieve a specific knowledge item by ID.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | ✓ | Knowledge item UUID |

#### `knowledge.contribute`

Submit a new knowledge item (requires approval by default).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `title` | string | ✓ | Item title |
| `content` | string | ✓ | Item content (markdown) |
| `project` | string | — | Associated project |
| `domain` | string | ✓ | Knowledge domain |
| `confidence` | number | — | Self-assessed confidence (0-1, default: 0.8) |

---

### `quality.*` — Quality Gates

#### `quality.report`

Submit a quality gate result after a work session.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project` | string | ✓ | Project name |
| `score` | number | ✓ | Quality score (0-100) |
| `grade` | string | ✓ | Letter grade: A, B, C, D, F |
| `breakdown` | object | — | Score breakdown by category |

**Grade thresholds:**

| Grade | Score | Description |
|---|---|---|
| A | 90-100 | Excellent — all gates passed |
| B | 75-89 | Good — minor issues |
| C | 60-74 | Acceptable — needs improvement |
| D | 40-59 | Poor — significant issues |
| F | 0-39 | Failing — blocked |

#### `quality.trends`

Get quality score trend for a project.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project` | string | ✓ | Project name |
| `days` | number | — | Lookback period (default: 30) |

---

### `session.*` — Session Handoff

#### `session.handoff`

Create a session handoff for another agent to pick up.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project` | string | ✓ | Project name |
| `task_summary` | string | ✓ | What was being worked on |
| `context` | object | ✓ | Files changed, decisions made, blockers |
| `to_agent` | string | — | Target agent (null = any) |
| `priority` | number | — | 1-10, default: 5 |

#### `session.pickup`

Claim the oldest pending handoff.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project` | string | — | Filter by project |

#### `session.complete`

Mark a handoff as completed.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | ✓ | Handoff UUID |

---

## Rate Limits

| Tier | Requests/min | Burst |
|---|---|---|
| Default | 60 | 10 |
| Premium | 300 | 50 |

Rate limit headers are included in every response:

```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 45
X-RateLimit-Reset: 1710700000
```

---

## Error Codes

| Code | Meaning |
|---|---|
| `400` | Invalid request parameters |
| `401` | Missing or invalid API key |
| `403` | Policy violation (e.g., quality gate block) |
| `404` | Resource not found |
| `429` | Rate limit exceeded |
| `500` | Internal server error |
| `502` | Backend service unavailable |
