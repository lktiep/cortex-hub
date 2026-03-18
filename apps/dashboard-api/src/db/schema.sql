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
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT
);

-- Insert default uncompleted setup status
INSERT OR IGNORE INTO setup_status (id, completed) VALUES (1, 0);
