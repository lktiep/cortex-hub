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
        CHECK(status IN ('pending','blocked','assigned','accepted','in_progress','review','approved','rejected','completed','failed','cancelled')),
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

-- Insert default uncompleted setup status
INSERT OR IGNORE INTO setup_status (id, completed) VALUES (1, 0);

-- Insert default organization
INSERT OR IGNORE INTO organizations (id, name, slug, description) 
VALUES ('org-default', 'Personal', 'personal', 'Default personal organization');
