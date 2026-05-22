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
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
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
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
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
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    expires_at TEXT
);

-- ── Organizations ──
CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    description TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
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
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime')),
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
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
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
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
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
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
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
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
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
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_conductor_comments_task ON conductor_comments(task_id);

-- ── Hub Configuration ──
CREATE TABLE IF NOT EXISTS hub_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
);

-- Insert defaults
INSERT OR IGNORE INTO hub_config (key, value) VALUES ('hub_name', 'Cortex Hub');
INSERT OR IGNORE INTO hub_config (key, value) VALUES ('hub_description', 'Self-hosted MCP Intelligence Platform');

-- ── Notification Preferences ──
CREATE TABLE IF NOT EXISTS notification_preferences (
    key TEXT PRIMARY KEY,
    enabled INTEGER DEFAULT 1,
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
);

INSERT OR IGNORE INTO notification_preferences (key, enabled) VALUES ('agent_disconnect', 1);
INSERT OR IGNORE INTO notification_preferences (key, enabled) VALUES ('quality_gate_failure', 1);
INSERT OR IGNORE INTO notification_preferences (key, enabled) VALUES ('task_assignment', 1);
INSERT OR IGNORE INTO notification_preferences (key, enabled) VALUES ('session_handoff', 1);

-- ── Knowledge Lineage (Version DAG — inspired by OpenSpace) ──
CREATE TABLE IF NOT EXISTS knowledge_lineage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
    child_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
    relationship TEXT DEFAULT 'derived'
        CHECK(relationship IN ('derived','fixed')),
    change_summary TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
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
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
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
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_recipe_capture_log_status ON recipe_capture_log(status);

-- Insert default uncompleted setup status
INSERT OR IGNORE INTO setup_status (id, completed) VALUES (1, 0);

-- Insert default organization
INSERT OR IGNORE INTO organizations (id, name, slug, description)
VALUES ('org-default', 'Personal', 'personal', 'Default personal organization');
