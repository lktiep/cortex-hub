# Entity Relationship Diagram — Cortex Hub

> This ERD covers the **SQLite application database** only. Qdrant has its own schema managed by its service.

```mermaid
erDiagram
    ADMIN_USER {
        text id PK "UUID"
        text github_id UK "GitHub user ID"
        text username "GitHub username"
        text display_name "Full name"
        text avatar_url "GitHub avatar"
        text email "Contact email"
        text created_at "ISO 8601"
        text updated_at "ISO 8601"
    }

    API_KEY {
        text id PK "UUID"
        text admin_id FK "→ admin_user.id"
        text key_hash UK "SHA-256 hash of key"
        text key_prefix "First 8 chars for display"
        text name "Human-readable name"
        text agent_name "Target agent name"
        text permissions "JSON array of allowed tools"
        integer rate_limit "Requests per hour"
        integer is_active "0=revoked, 1=active"
        text created_at "ISO 8601"
        text last_used_at "ISO 8601 or NULL"
        text revoked_at "ISO 8601 or NULL"
    }

    TOOL_LOG {
        text id PK "UUID"
        text api_key_id FK "→ api_key.id"
        text agent_name "Agent identifier"
        text tool_name "e.g. code.search"
        text tool_category "code|memory|knowledge|quality|session"
        integer latency_ms "Response time"
        integer status_code "HTTP status"
        integer request_size "Bytes"
        integer response_size "Bytes"
        text error_message "NULL if success"
        text created_at "ISO 8601"
    }

    QUALITY_REPORT {
        text id PK "UUID"
        text project_name "Project identifier"
        text agent_name "Agent that submitted"
        text session_id "Session reference"
        integer score_build "0-25"
        integer score_regression "0-25"
        integer score_standards "0-25"
        integer score_traceability "0-25"
        integer score_total "0-100"
        text grade "A|B|C|D|F"
        text details "JSON — detailed breakdown"
        text created_at "ISO 8601"
    }

    SESSION_HANDOFF {
        text id PK "UUID"
        text project_name "Project identifier"
        text from_agent "Originating agent"
        text to_agent "Target agent (NULL=open)"
        text priority "critical|high|normal|low"
        text status "pending|claimed|completed|expired"
        text context "JSON — files changed, decisions, blockers"
        text summary "Human-readable summary"
        text claimed_by "Agent that claimed"
        text created_at "ISO 8601"
        text claimed_at "ISO 8601 or NULL"
        text completed_at "ISO 8601 or NULL"
        text expires_at "ISO 8601 (created_at + 7 days)"
    }

    INDEXED_REPO {
        text id PK "UUID"
        text admin_id FK "→ admin_user.id"
        text github_url "Repository URL"
        text repo_name "owner/repo"
        integer is_private "0=public, 1=private"
        text clone_path "Local clone path on server"
        text status "pending|indexing|indexed|error"
        text last_indexed_at "ISO 8601 or NULL"
        integer symbol_count "GitNexus symbols"
        text error_message "NULL if ok"
        text created_at "ISO 8601"
        text updated_at "ISO 8601"
    }

    KNOWLEDGE_ITEM {
        text id PK "UUID"
        text title "Knowledge item title"
        text content "Full content markdown"
        text domain "e.g. typescript, docker, cloudflare"
        text project_name "Source project or NULL"
        text contributed_by "Agent name"
        text status "pending|approved|rejected"
        text reviewed_by "Admin who reviewed"
        text qdrant_point_id "Qdrant vector ID"
        text created_at "ISO 8601"
        text reviewed_at "ISO 8601 or NULL"
    }

    ADMIN_USER ||--o{ API_KEY : "creates"
    ADMIN_USER ||--o{ INDEXED_REPO : "imports"
    API_KEY ||--o{ TOOL_LOG : "generates"
    QUALITY_REPORT }o--|| SESSION_HANDOFF : "may reference"
```

## Indexes

```sql
-- Performance-critical queries
CREATE INDEX idx_tool_log_created ON tool_log(created_at DESC);
CREATE INDEX idx_tool_log_agent ON tool_log(agent_name, created_at DESC);
CREATE INDEX idx_tool_log_tool ON tool_log(tool_name, created_at DESC);
CREATE INDEX idx_tool_log_key ON tool_log(api_key_id);
CREATE INDEX idx_api_key_hash ON api_key(key_hash);
CREATE INDEX idx_api_key_active ON api_key(is_active);
CREATE INDEX idx_quality_project ON quality_report(project_name, created_at DESC);
CREATE INDEX idx_handoff_status ON session_handoff(status, priority);
CREATE INDEX idx_repo_status ON indexed_repo(status);
CREATE INDEX idx_knowledge_status ON knowledge_item(status);
```

## Notes

- All IDs are UUIDs v4 (not auto-increment) — compatible with distributed systems
- All timestamps are ISO 8601 strings stored as TEXT
- Soft deletes not needed in v1 — hard delete with revoked_at/expired status instead
- WAL mode enabled for concurrent read/write performance
- Total tables: 7 (lean schema for v1)
