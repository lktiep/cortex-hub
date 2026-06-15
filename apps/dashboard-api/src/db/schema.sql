CREATE TABLE IF NOT EXISTS setup_status (
    id INTEGER PRIMARY KEY DEFAULT 1,
    completed BOOLEAN DEFAULT 0,
    completed_at TEXT
);

CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,       -- prefix + short random
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL,    -- sha256 hash of the actual key
    scope TEXT NOT NULL,       -- e.g., 'all', 'knowledge', 'hub'
    permissions TEXT,          -- JSON string of permissions
    project_id TEXT,           -- optional scope to a project
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT,
    last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS query_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    params TEXT,
    latency_ms INTEGER,
    status TEXT DEFAULT 'ok',
    error TEXT,
    project_id TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS session_handoffs (
    id TEXT PRIMARY KEY,
    from_agent TEXT NOT NULL,
    to_agent TEXT,
    project TEXT NOT NULL,
    task_summary TEXT NOT NULL,
    context TEXT NOT NULL,           -- JSON
    priority INTEGER DEFAULT 5,
    status TEXT DEFAULT 'pending',
    claimed_by TEXT,
    project_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT
);

-- ── Organizations ──
CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    description TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- ── Projects ──
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES organizations(id),
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    description TEXT,
    git_repo_url TEXT,
    git_provider TEXT,              -- 'github', 'gitlab', 'bitbucket', 'azure', 'local'
    git_username TEXT,
    git_token TEXT,
    indexed_at TEXT,
    indexed_symbols INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(org_id, slug)
);

-- ── Index Jobs ──
CREATE TABLE IF NOT EXISTS index_jobs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    branch TEXT DEFAULT 'main',
    status TEXT DEFAULT 'pending',       -- pending | cloning | analyzing | ingesting | done | error
    progress INTEGER DEFAULT 0,          -- 0-100
    total_files INTEGER DEFAULT 0,
    symbols_found INTEGER DEFAULT 0,
    log TEXT,                             -- stdout/stderr from gitnexus
    error TEXT,
    started_at TEXT,
    completed_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

-- ── Usage Logs ──
CREATE TABLE IF NOT EXISTS usage_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_tokens INTEGER DEFAULT 0,
    completion_tokens INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    project_id TEXT,
    request_type TEXT DEFAULT 'chat',  -- 'chat', 'embedding', 'tool'
    created_at TEXT DEFAULT (datetime('now'))
);

-- ── Conductor Tasks ──
CREATE TABLE IF NOT EXISTS conductor_tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    project_id TEXT,
    parent_task_id TEXT,
    created_by_agent TEXT,
    assigned_to_agent TEXT,
    assigned_session_id TEXT,
    status TEXT DEFAULT 'pending'
        CHECK(status IN ('pending','blocked','assigned','accepted','in_progress','analyzing','strategy_review','synthesis','discussion','review','approved','rejected','completed','failed','cancelled')),
    priority INTEGER DEFAULT 5,
    required_capabilities TEXT DEFAULT '[]',
    depends_on TEXT DEFAULT '[]',
    notify_on_complete TEXT DEFAULT '[]',
    notified_agents TEXT DEFAULT '[]',
    context TEXT DEFAULT '{}',
    result TEXT,
    completed_by TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    assigned_at TEXT,
    accepted_at TEXT,
    completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_conductor_tasks_assigned ON conductor_tasks(assigned_to_agent, status);
CREATE INDEX IF NOT EXISTS idx_conductor_tasks_status ON conductor_tasks(status);
CREATE INDEX IF NOT EXISTS idx_conductor_tasks_parent ON conductor_tasks(parent_task_id);

CREATE TABLE IF NOT EXISTS conductor_task_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    agent_id TEXT,
    action TEXT NOT NULL,
    message TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_conductor_task_logs_task ON conductor_task_logs(task_id);

-- ── Conductor Comments ──
CREATE TABLE IF NOT EXISTS conductor_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    finding_id TEXT,
    agent_id TEXT,
    comment TEXT NOT NULL,
    comment_type TEXT DEFAULT 'comment'
        CHECK(comment_type IN ('comment', 'agree', 'disagree', 'amendment')),
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_conductor_comments_task ON conductor_comments(task_id);

-- ── Hub Configuration ──
CREATE TABLE IF NOT EXISTS hub_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Insert defaults
INSERT OR IGNORE INTO hub_config (key, value) VALUES ('hub_name', 'Cortex Hub');
INSERT OR IGNORE INTO hub_config (key, value) VALUES ('hub_description', 'Self-hosted MCP Intelligence Platform');

-- ── Notification Preferences ──
CREATE TABLE IF NOT EXISTS notification_preferences (
    key TEXT PRIMARY KEY,
    enabled INTEGER DEFAULT 1,
    updated_at TEXT DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO notification_preferences (key, enabled) VALUES ('agent_disconnect', 1);
INSERT OR IGNORE INTO notification_preferences (key, enabled) VALUES ('quality_gate_failure', 1);
INSERT OR IGNORE INTO notification_preferences (key, enabled) VALUES ('task_assignment', 1);
INSERT OR IGNORE INTO notification_preferences (key, enabled) VALUES ('session_handoff', 1);

-- ── Knowledge Documents (core memory store) ──
CREATE TABLE IF NOT EXISTS knowledge_documents (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT,
    source TEXT DEFAULT 'manual',
    source_agent_id TEXT,
    source_task_id TEXT,
    project_id TEXT,
    tags TEXT DEFAULT '[]',
    content_preview TEXT,
    status TEXT DEFAULT 'active' CHECK(status IN ('active', 'archived')),
    chunk_count INTEGER DEFAULT 0,
    hit_count INTEGER DEFAULT 0,
    selection_count INTEGER DEFAULT 0,
    applied_count INTEGER DEFAULT 0,
    completion_count INTEGER DEFAULT 0,
    fallback_count INTEGER DEFAULT 0,
    origin TEXT DEFAULT 'manual',
    generation INTEGER DEFAULT 0,
    created_by_agent TEXT,
    category TEXT DEFAULT 'general',
    hall_type TEXT DEFAULT 'general'
        CHECK(hall_type IN ('fact','event','discovery','preference','advice','general')),
    valid_from TEXT,
    invalidated_at TEXT,
    superseded_by TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_knowledge_docs_project ON knowledge_documents(project_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_docs_status ON knowledge_documents(status);
CREATE INDEX IF NOT EXISTS idx_knowledge_docs_hall_type ON knowledge_documents(hall_type);
CREATE INDEX IF NOT EXISTS idx_knowledge_docs_valid_from ON knowledge_documents(valid_from);
CREATE INDEX IF NOT EXISTS idx_knowledge_docs_invalidated_at ON knowledge_documents(invalidated_at);

-- ── Knowledge Chunks (chunked content for vector retrieval) ──
CREATE TABLE IF NOT EXISTS knowledge_chunks (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    char_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_doc ON knowledge_chunks(document_id);

-- ── Knowledge Lineage (Version DAG — inspired by OpenSpace) ──
CREATE TABLE IF NOT EXISTS knowledge_lineage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
    child_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
    relationship TEXT DEFAULT 'derived'
        CHECK(relationship IN ('derived','fixed')),
    change_summary TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(parent_id, child_id)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_lineage_parent ON knowledge_lineage(parent_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_lineage_child ON knowledge_lineage(child_id);

-- ── Knowledge Usage Log (quality feedback tracking) ──
CREATE TABLE IF NOT EXISTS knowledge_usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id TEXT NOT NULL,
    task_id TEXT,
    session_id TEXT,
    agent_id TEXT,
    action TEXT NOT NULL
        CHECK(action IN ('suggested','applied','completed','fallback')),
    token_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_knowledge_usage_doc ON knowledge_usage_log(document_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_usage_task ON knowledge_usage_log(task_id);

-- ── Recipe Capture Log (diagnostics — track attempts and failures) ──
CREATE TABLE IF NOT EXISTS recipe_capture_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL CHECK(source IN ('task', 'session')),
    source_id TEXT,
    agent_id TEXT,
    project_id TEXT,
    status TEXT NOT NULL CHECK(status IN ('attempt', 'captured', 'derived', 'skipped', 'error')),
    title TEXT,
    doc_id TEXT,
    error_message TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_recipe_capture_log_status ON recipe_capture_log(status);

-- ── Provider Accounts (LLM/embedding providers) ──
CREATE TABLE IF NOT EXISTS provider_accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    auth_type TEXT,
    api_base TEXT,
    api_key TEXT,
    capabilities TEXT DEFAULT '[]',
    models TEXT DEFAULT '[]',
    status TEXT DEFAULT 'enabled',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- ── Model Routing (purpose → provider/model chain) ──
CREATE TABLE IF NOT EXISTS model_routing (
    purpose TEXT PRIMARY KEY,
    chain TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
);

-- ── Agent Acknowledgement (last seen change event per agent+project) ──
CREATE TABLE IF NOT EXISTS agent_ack (
    agent_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    last_seen_event_id TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (agent_id, project_id)
);

-- ── Budget Settings (singleton org-wide budget) ──
CREATE TABLE IF NOT EXISTS budget_settings (
    id INTEGER PRIMARY KEY DEFAULT 1,
    daily_limit INTEGER DEFAULT 0,
    monthly_limit INTEGER DEFAULT 0,
    alert_threshold REAL DEFAULT 0.8,
    updated_at TEXT DEFAULT (datetime('now'))
);

-- ── Change Events (git push / manual triggers) ──
CREATE TABLE IF NOT EXISTS change_events (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    branch TEXT NOT NULL,
    agent_id TEXT,
    commit_sha TEXT,
    commit_message TEXT,
    files_changed TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_change_events_project ON change_events(project_id);
CREATE INDEX IF NOT EXISTS idx_change_events_created ON change_events(created_at);

-- ── Quality Reports (4-dimension session scoring) ──
CREATE TABLE IF NOT EXISTS quality_reports (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    agent_id TEXT NOT NULL,
    session_id TEXT,
    gate_name TEXT NOT NULL,
    score_build INTEGER DEFAULT 0,
    score_regression INTEGER DEFAULT 0,
    score_standards INTEGER DEFAULT 0,
    score_traceability INTEGER DEFAULT 0,
    score_total INTEGER DEFAULT 0,
    grade TEXT CHECK(grade IN ('A','B','C','D','F')),
    passed INTEGER DEFAULT 0,
    details TEXT,
    api_key_name TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_quality_reports_project ON quality_reports(project_id);
CREATE INDEX IF NOT EXISTS idx_quality_reports_agent ON quality_reports(agent_id);
CREATE INDEX IF NOT EXISTS idx_quality_reports_grade ON quality_reports(grade);

-- Insert default uncompleted setup status
INSERT OR IGNORE INTO setup_status (id, completed) VALUES (1, 0);

-- Insert default organization
INSERT OR IGNORE INTO organizations (id, name, slug, description)
VALUES ('org-default', 'Personal', 'personal', 'Default personal organization');
