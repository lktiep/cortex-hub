# Database Schema Reference

> All 25 tables are in **SQLite** (better-sqlite3, WAL mode). There is no Supabase.
> Vector data lives in **Qdrant** (3 collections). See bottom of this document.

---

## Core

### `setup_status`

Single-row table tracking whether initial setup wizard has been completed.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | INTEGER | 1 | PK, always 1 |
| completed | BOOLEAN | 0 | |
| completed_at | TEXT | NULL | ISO 8601 |

### `api_keys`

API keys used by agents and external callers to authenticate against the Hub MCP Server.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | TEXT | | PK (prefix + short random) |
| name | TEXT | | NOT NULL, human-readable label |
| key_hash | TEXT | | NOT NULL, SHA-256 hash of actual key |
| scope | TEXT | | NOT NULL, e.g. "all", "knowledge", "hub" |
| permissions | TEXT | NULL | JSON string of permissions |
| project_id | TEXT | NULL | Optional scope to a project |
| created_at | TEXT | datetime('now') | |
| expires_at | TEXT | NULL | |
| last_used_at | TEXT | NULL | |

### `query_logs`

Records every tool call routed through the Hub MCP Server.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | INTEGER | AUTOINCREMENT | PK |
| agent_id | TEXT | | NOT NULL |
| tool | TEXT | | NOT NULL, e.g. "cortex_code_search" |
| params | TEXT | NULL | JSON string |
| latency_ms | INTEGER | NULL | Response time in ms |
| status | TEXT | "ok" | "ok", "error", "policy_blocked" |
| error | TEXT | NULL | Error message if failed |
| project_id | TEXT | NULL | |
| created_at | TEXT | datetime('now') | |

**Indexes:** `idx_query_logs_agent(agent_id)`, `idx_query_logs_tool(tool)`, `idx_query_logs_created(created_at)`

### `hub_config`

Key-value configuration store for Hub settings.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| key | TEXT | | PK |
| value | TEXT | | NOT NULL |
| updated_at | TEXT | datetime('now') | |

**Default rows:** `hub_name = "Cortex Hub"`, `hub_description = "Self-hosted MCP Intelligence Platform"`

---

## Organizations and Projects

### `organizations`

Top-level organizational units. A default "Personal" org is created on first run.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | TEXT | | PK |
| name | TEXT | | NOT NULL |
| slug | TEXT | | UNIQUE NOT NULL |
| description | TEXT | NULL | |
| created_at | TEXT | datetime('now') | |
| updated_at | TEXT | datetime('now') | |

### `projects`

Git repositories registered for indexing and tracking.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | TEXT | | PK |
| org_id | TEXT | | NOT NULL, FK -> organizations(id) |
| name | TEXT | | NOT NULL |
| slug | TEXT | | NOT NULL, UNIQUE(org_id, slug) |
| description | TEXT | NULL | |
| git_repo_url | TEXT | NULL | |
| git_provider | TEXT | NULL | "github", "gitlab", "bitbucket", "azure", "local" |
| git_username | TEXT | NULL | Added via migration |
| git_token | TEXT | NULL | Added via migration |
| indexed_at | TEXT | NULL | Last successful index time |
| indexed_symbols | INTEGER | 0 | Symbol count from last index |
| created_at | TEXT | datetime('now') | |
| updated_at | TEXT | datetime('now') | |

### `index_jobs`

Tracks code indexing jobs (GitNexus) for each project.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | TEXT | | PK |
| project_id | TEXT | | NOT NULL, FK -> projects(id) ON DELETE CASCADE |
| branch | TEXT | "main" | |
| status | TEXT | "pending" | "pending", "cloning", "analyzing", "ingesting", "done", "error" |
| progress | INTEGER | 0 | 0-100 |
| total_files | INTEGER | 0 | |
| symbols_found | INTEGER | 0 | |
| log | TEXT | NULL | stdout/stderr from GitNexus |
| error | TEXT | NULL | |
| started_at | TEXT | NULL | |
| completed_at | TEXT | NULL | |
| created_at | TEXT | datetime('now') | |

---

## Sessions

### `session_handoffs`

Active and historical agent sessions. Also used for cross-agent handoff.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | TEXT | | PK |
| from_agent | TEXT | | NOT NULL |
| to_agent | TEXT | NULL | NULL = open for any agent |
| project | TEXT | | NOT NULL |
| task_summary | TEXT | | NOT NULL |
| context | TEXT | | NOT NULL, JSON (files changed, decisions, blockers) |
| priority | INTEGER | 5 | |
| status | TEXT | "pending" | "pending", "active", "claimed", "completed", "expired" |
| claimed_by | TEXT | NULL | |
| project_id | TEXT | NULL | Soft FK to projects |
| hostname | TEXT | NULL | Agent machine hostname (migration) |
| os | TEXT | NULL | Agent OS (migration) |
| ide | TEXT | NULL | Agent IDE (migration) |
| branch | TEXT | NULL | Git branch (migration) |
| capabilities | TEXT | "[]" | JSON array (migration) |
| role | TEXT | NULL | Agent role (migration) |
| last_activity | TEXT | datetime('now') | Updated on each tool call (migration) |
| api_key_name | TEXT | NULL | API key owner name (migration) |
| created_at | TEXT | datetime('now') | |
| expires_at | TEXT | NULL | |

---

## Conductor (Multi-Agent Orchestration)

### `conductor_tasks`

Tasks assigned to and executed by agents, with dependency tracking and status workflow.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | TEXT | | PK |
| title | TEXT | | NOT NULL |
| description | TEXT | "" | NOT NULL |
| project_id | TEXT | NULL | |
| parent_task_id | TEXT | NULL | Self-referencing FK for subtasks |
| created_by_agent | TEXT | NULL | |
| assigned_to_agent | TEXT | NULL | |
| assigned_session_id | TEXT | NULL | |
| status | TEXT | "pending" | CHECK constraint, see below |
| priority | INTEGER | 5 | |
| required_capabilities | TEXT | "[]" | JSON array |
| depends_on | TEXT | "[]" | JSON array of task IDs |
| notify_on_complete | TEXT | "[]" | JSON array of agent IDs |
| notified_agents | TEXT | "[]" | JSON array |
| context | TEXT | "{}" | JSON, arbitrary task context |
| result | TEXT | NULL | |
| completed_by | TEXT | NULL | |
| created_at | TEXT | datetime('now') | |
| assigned_at | TEXT | NULL | |
| accepted_at | TEXT | NULL | |
| completed_at | TEXT | NULL | |

**Status values:** `pending`, `blocked`, `assigned`, `accepted`, `in_progress`, `analyzing`, `strategy_review`, `synthesis`, `discussion`, `review`, `approved`, `rejected`, `completed`, `failed`, `cancelled`

**Indexes:**
- `idx_conductor_tasks_assigned(assigned_to_agent, status)`
- `idx_conductor_tasks_status(status)`
- `idx_conductor_tasks_parent(parent_task_id)`

### `conductor_task_logs`

Audit log for task lifecycle events.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | INTEGER | AUTOINCREMENT | PK |
| task_id | TEXT | | NOT NULL |
| agent_id | TEXT | NULL | |
| action | TEXT | | NOT NULL |
| message | TEXT | NULL | |
| created_at | TEXT | datetime('now') | |

**Indexes:** `idx_conductor_task_logs_task(task_id)`

### `conductor_comments`

Discussion comments on tasks and findings, supporting structured agreement/disagreement.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | INTEGER | AUTOINCREMENT | PK |
| task_id | TEXT | | NOT NULL |
| finding_id | TEXT | NULL | |
| agent_id | TEXT | NULL | |
| comment | TEXT | | NOT NULL |
| comment_type | TEXT | "comment" | "comment", "agree", "disagree", "amendment" |
| created_at | TEXT | datetime('now') | |

**Indexes:** `idx_conductor_comments_task(task_id)`

---

## Knowledge Base

### `knowledge_documents`

Metadata for knowledge documents. Content is stored as chunks (see `knowledge_chunks`). Vectors are in Qdrant "knowledge" collection.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | TEXT | | PK |
| title | TEXT | | NOT NULL |
| source | TEXT | "manual" | "manual", "agent", "import", "auto-docs" |
| source_agent_id | TEXT | NULL | |
| project_id | TEXT | NULL | |
| tags | TEXT | "[]" | JSON array of strings |
| status | TEXT | "active" | "active", "archived" |
| hit_count | INTEGER | 0 | Incremented on search match |
| chunk_count | INTEGER | 0 | |
| content_preview | TEXT | NULL | First ~500 chars |
| selection_count | INTEGER | 0 | Times selected in search results (migration) |
| applied_count | INTEGER | 0 | Times applied by agent (migration) |
| completion_count | INTEGER | 0 | Times task completed with this doc (migration) |
| fallback_count | INTEGER | 0 | Times triggered fallback (migration) |
| origin | TEXT | "manual" | "manual", "fixed", "derived", "captured" (migration) |
| generation | INTEGER | 0 | Lineage generation number (migration) |
| source_task_id | TEXT | NULL | Task that generated this doc (migration) |
| created_by_agent | TEXT | NULL | (migration) |
| category | TEXT | "general" | (migration) |
| hall_type | TEXT | "general" | "fact", "event", "discovery", "preference", "advice", "general" (migration) |
| valid_from | TEXT | NULL | Temporal validity start (migration) |
| invalidated_at | TEXT | NULL | When this doc was invalidated (migration) |
| superseded_by | TEXT | NULL | ID of replacement doc (migration) |
| created_at | TEXT | datetime('now') | |
| updated_at | TEXT | datetime('now') | |

**Indexes:**
- `idx_knowledge_docs_project(project_id)`
- `idx_knowledge_hall_type(hall_type)`
- `idx_knowledge_valid_from(valid_from)`
- `idx_knowledge_invalidated_at(invalidated_at)`

### `knowledge_chunks`

Individual text chunks of knowledge documents. Each chunk's `id` doubles as its Qdrant point ID in the "knowledge" collection.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | TEXT | | PK (also the Qdrant point ID) |
| document_id | TEXT | | NOT NULL, FK -> knowledge_documents(id) ON DELETE CASCADE |
| chunk_index | INTEGER | | NOT NULL |
| content | TEXT | | NOT NULL |
| char_count | INTEGER | 0 | |
| created_at | TEXT | datetime('now') | |

**Indexes:** `idx_knowledge_chunks_doc(document_id)`

### `knowledge_lineage`

Version DAG tracking how knowledge documents evolve (derive from or fix others).

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | INTEGER | AUTOINCREMENT | PK |
| parent_id | TEXT | | NOT NULL, FK -> knowledge_documents(id) ON DELETE CASCADE |
| child_id | TEXT | | NOT NULL, FK -> knowledge_documents(id) ON DELETE CASCADE |
| relationship | TEXT | "derived" | "derived", "fixed" |
| change_summary | TEXT | NULL | |
| created_at | TEXT | datetime('now') | |

**Constraints:** UNIQUE(parent_id, child_id)

**Indexes:** `idx_knowledge_lineage_parent(parent_id)`, `idx_knowledge_lineage_child(child_id)`

### `knowledge_usage_log`

Tracks how knowledge documents are used by agents (quality feedback loop).

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | INTEGER | AUTOINCREMENT | PK |
| document_id | TEXT | | NOT NULL |
| task_id | TEXT | NULL | |
| session_id | TEXT | NULL | |
| agent_id | TEXT | NULL | |
| action | TEXT | | NOT NULL, "suggested", "applied", "completed", "fallback" |
| token_count | INTEGER | 0 | |
| created_at | TEXT | datetime('now') | |

**Indexes:** `idx_knowledge_usage_doc(document_id)`, `idx_knowledge_usage_task(task_id)`

### `recipe_capture_log`

Diagnostics table tracking automatic recipe capture attempts (from completed tasks and sessions).

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | INTEGER | AUTOINCREMENT | PK |
| source | TEXT | | NOT NULL, "task" or "session" |
| source_id | TEXT | NULL | Task or session ID |
| agent_id | TEXT | NULL | |
| project_id | TEXT | NULL | |
| status | TEXT | | NOT NULL, "attempt", "captured", "derived", "skipped", "error" |
| title | TEXT | NULL | |
| doc_id | TEXT | NULL | Created knowledge_documents.id |
| error_message | TEXT | NULL | |
| created_at | TEXT | datetime('now') | |

**Indexes:** `idx_recipe_capture_log_status(status)`

---

## LLM and Providers

### `provider_accounts`

LLM provider configurations (OpenAI-compatible, Gemini, Anthropic, etc.).

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | TEXT | | PK |
| name | TEXT | | NOT NULL, e.g. "OpenAI (Personal)" |
| type | TEXT | | NOT NULL, "openai_compat", "gemini", "anthropic" |
| auth_type | TEXT | "api_key" | "oauth", "api_key" |
| api_base | TEXT | | NOT NULL, e.g. "http://llm-proxy:8317/v1" |
| api_key | TEXT | NULL | Stored for runtime use |
| status | TEXT | "enabled" | "enabled", "disabled", "error" |
| capabilities | TEXT | '["chat"]' | JSON array: "chat", "embedding", "code" |
| models | TEXT | "[]" | JSON array of model IDs |
| created_at | TEXT | datetime('now') | |
| updated_at | TEXT | datetime('now') | |

### `model_routing`

Fallback chains per purpose. Each row maps a purpose to an ordered array of provider+model slots.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| purpose | TEXT | | PK, "chat", "embedding", or "code" |
| chain | TEXT | "[]" | JSON: `[{"accountId":"...","model":"gpt-4o"},...]` |
| updated_at | TEXT | datetime('now') | |

### `usage_logs`

Token usage tracking per agent and model.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | INTEGER | AUTOINCREMENT | PK |
| agent_id | TEXT | | NOT NULL |
| model | TEXT | | NOT NULL |
| prompt_tokens | INTEGER | 0 | |
| completion_tokens | INTEGER | 0 | |
| total_tokens | INTEGER | 0 | |
| project_id | TEXT | NULL | |
| request_type | TEXT | "chat" | "chat", "embedding", "tool" |
| created_at | TEXT | datetime('now') | |

### `budget_settings`

Single-row table for daily/monthly token budget limits. Created lazily on first access.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | INTEGER | 1 | PK, always 1 |
| daily_limit | INTEGER | 0 | 0 = unlimited |
| monthly_limit | INTEGER | 0 | 0 = unlimited |
| alert_threshold | REAL | 0.8 | Fraction (0.0-1.0) to trigger warning |
| updated_at | TEXT | datetime('now') | |

---

## Quality

### `quality_reports`

4-dimension quality gate results. Each report scores Build + Regression + Standards + Traceability (each 0-25, total 0-100).

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | TEXT | | PK |
| project_id | TEXT | NULL | |
| agent_id | TEXT | | NOT NULL |
| session_id | TEXT | NULL | |
| gate_name | TEXT | | NOT NULL |
| score_build | INTEGER | 0 | 0-25 |
| score_regression | INTEGER | 0 | 0-25 |
| score_standards | INTEGER | 0 | 0-25 |
| score_traceability | INTEGER | 0 | 0-25 |
| score_total | INTEGER | 0 | 0-100 (sum of 4 dimensions) |
| grade | TEXT | "F" | CHECK: "A", "B", "C", "D", "F" |
| passed | BOOLEAN | 0 | |
| details | TEXT | NULL | JSON |
| api_key_name | TEXT | NULL | Added via migration |
| created_at | TEXT | datetime('now') | |

**Grade thresholds:** A >= 90, B >= 80, C >= 70, D >= 60, F < 60

**Indexes:**
- `idx_quality_reports_project_created(project_id, created_at DESC)`
- `idx_quality_reports_agent(agent_id, created_at DESC)`

---

## Notifications

### `notification_preferences`

Per-event notification toggles.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| key | TEXT | | PK |
| enabled | INTEGER | 1 | 0 = disabled, 1 = enabled |
| updated_at | TEXT | datetime('now') | |

**Default rows:** `agent_disconnect`, `quality_gate_failure`, `task_assignment`, `session_handoff`

---

## Change Tracking

### `change_events`

Records code push events from webhooks, lefthook, or CI. Used by `cortex_detect_changes` to notify agents of unseen changes.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | TEXT | | PK |
| project_id | TEXT | | NOT NULL, FK -> projects(id) ON DELETE CASCADE |
| branch | TEXT | | NOT NULL |
| agent_id | TEXT | NULL | Who pushed |
| commit_sha | TEXT | NULL | |
| commit_message | TEXT | NULL | |
| files_changed | TEXT | NULL | JSON array of file paths |
| created_at | TEXT | datetime('now') | |

**Indexes:** `idx_change_events_project_created(project_id, created_at DESC)`

### `agent_ack`

Tracks the last change event each agent has acknowledged, per project.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| agent_id | TEXT | | PK (composite) |
| project_id | TEXT | | PK (composite) |
| last_seen_event_id | TEXT | | NOT NULL |
| updated_at | TEXT | datetime('now') | |

**Primary key:** `(agent_id, project_id)` -- uses ON CONFLICT DO UPDATE for upsert.

---

## Qdrant Vector Collections

Vector data is stored in Qdrant, not SQLite. Dimensions depend on the configured embedding provider.

### `cortex_memories`

Agent memories managed by mem9. Each memory is a vector embedding of conversation context.

- **Dimensions:** 384 (local embedder) or 768 (Gemini)
- **Payloads:** userId, agentId, metadata (type, session_id, project_id, etc.)
- **Used by:** `cortex_memory_store`, `cortex_memory_search`

### `knowledge`

Embedded chunks of knowledge documents. Point IDs correspond 1:1 to `knowledge_chunks.id` in SQLite.

- **Dimensions:** 384 (local embedder) or 768 (Gemini)
- **Payloads:** document_id, chunk_index, title, project_id, tags
- **Used by:** `cortex_knowledge_store`, `cortex_knowledge_search`

### `cortex-project-{projectId}`

Code chunks from GitNexus indexing. One collection per project.

- **Dimensions:** 384 (local embedder) or 768 (Gemini)
- **Payloads:** file path, symbol name, language, code content
- **Used by:** `cortex_code_search`, `cortex_code_reindex`

---

## Schema Management

- **Primary schema:** `apps/dashboard-api/src/db/schema.sql` -- executed on startup via `client.ts`
- **Migrations:** `apps/dashboard-api/src/db/client.ts` -- safe ALTER TABLE statements wrapped in try/catch for backward compatibility
- **Lazy creation:** `budget_settings` and `recipe_capture_log` are created on first access in their respective route handlers
- **WAL mode:** Enabled via `PRAGMA journal_mode = WAL` for concurrent read/write
- **Foreign keys:** Enabled via `PRAGMA foreign_keys = ON` (set in schema.sql, some worktrees)
- **Database file:** `data/cortex.db` (configurable via `DATABASE_PATH` env var)
