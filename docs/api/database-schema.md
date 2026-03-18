# Database Schema Reference

> SQLite (Dashboard API) and Supabase table definitions.

---

## SQLite — Dashboard API Local Storage

### `query_logs`

Records every tool call routed through the Hub MCP Server.

```sql
CREATE TABLE query_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id    TEXT NOT NULL,
    tool        TEXT NOT NULL,
    params      TEXT,                -- JSON string
    latency_ms  INTEGER,
    status      TEXT DEFAULT 'ok',   -- ok, error, policy_blocked
    error       TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_query_logs_agent ON query_logs(agent_id);
CREATE INDEX idx_query_logs_tool ON query_logs(tool);
CREATE INDEX idx_query_logs_created ON query_logs(created_at);
```

---

## Supabase — Shared Persistent Storage

### `knowledge_items`

Shared knowledge base with vector search support.

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE knowledge_items (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project             TEXT,                      -- NULL = cross-project
    domain              TEXT NOT NULL,              -- 'cloudflare', 'dotnet', 'supabase'
    title               TEXT NOT NULL,
    content             TEXT NOT NULL,
    embedding           vector(1536),              -- OpenAI ada-002 or Gemini
    source_agent        TEXT NOT NULL,              -- 'antigravity', 'goclaw'
    source_conversation TEXT,
    confidence          FLOAT DEFAULT 0.8,
    approved            BOOLEAN DEFAULT false,
    created_at          TIMESTAMPTZ DEFAULT now(),
    updated_at          TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX knowledge_embedding_idx ON knowledge_items
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE INDEX idx_knowledge_project ON knowledge_items(project);
CREATE INDEX idx_knowledge_domain ON knowledge_items(domain);
CREATE INDEX idx_knowledge_approved ON knowledge_items(approved);
```

### `quality_reports`

Quality gate results for trend tracking.

```sql
CREATE TABLE quality_reports (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id    TEXT NOT NULL,
    project     TEXT NOT NULL,
    session_id  TEXT,
    score       INTEGER CHECK (score BETWEEN 0 AND 100),
    grade       CHAR(1) CHECK (grade IN ('A','B','C','D','F')),
    breakdown   JSONB,                -- {"build": 25, "regression": 20, "standards": 15, "trace": 10}
    created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_quality_project ON quality_reports(project);
CREATE INDEX idx_quality_agent ON quality_reports(agent_id);
CREATE INDEX idx_quality_created ON quality_reports(created_at);
```

### `session_handoffs`

Cross-agent session continuity.

```sql
CREATE TABLE session_handoffs (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    from_agent   TEXT NOT NULL,
    to_agent     TEXT,                     -- NULL = any agent
    project      TEXT NOT NULL,
    task_summary TEXT NOT NULL,
    context      JSONB NOT NULL,           -- files changed, decisions made, blockers
    priority     INTEGER DEFAULT 5,
    status       TEXT DEFAULT 'pending'
                 CHECK (status IN ('pending', 'claimed', 'done', 'expired')),
    claimed_by   TEXT,
    created_at   TIMESTAMPTZ DEFAULT now(),
    expires_at   TIMESTAMPTZ DEFAULT (now() + INTERVAL '7 days')
);

CREATE INDEX idx_handoff_status ON session_handoffs(status);
CREATE INDEX idx_handoff_project ON session_handoffs(project);
```
