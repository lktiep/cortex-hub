-- Migration 001: Initial Schema
-- Cortex Hub v1 — SQLite WAL mode
-- 2026-03-18

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ============================================================
-- Admin Users (GitHub OAuth)
-- ============================================================
CREATE TABLE IF NOT EXISTS admin_user (
  id           TEXT PRIMARY KEY,
  github_id    TEXT UNIQUE NOT NULL,
  username     TEXT NOT NULL,
  display_name TEXT,
  avatar_url   TEXT,
  email        TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ============================================================
-- API Keys (per-agent auth)
-- ============================================================
CREATE TABLE IF NOT EXISTS api_key (
  id          TEXT PRIMARY KEY,
  admin_id    TEXT NOT NULL REFERENCES admin_user(id),
  key_hash    TEXT UNIQUE NOT NULL,
  key_prefix  TEXT NOT NULL,
  name        TEXT NOT NULL,
  agent_name  TEXT,
  permissions TEXT DEFAULT '["*"]',  -- JSON array of allowed tool patterns
  rate_limit  INTEGER DEFAULT 1000,   -- requests per hour
  is_active   INTEGER DEFAULT 1,      -- 0=revoked, 1=active
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at TEXT,
  revoked_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_key_hash   ON api_key(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_key_active ON api_key(is_active);

-- ============================================================
-- Tool Call Logs
-- ============================================================
CREATE TABLE IF NOT EXISTS tool_log (
  id            TEXT PRIMARY KEY,
  api_key_id    TEXT REFERENCES api_key(id),
  agent_name    TEXT NOT NULL,
  tool_name     TEXT NOT NULL,
  tool_category TEXT NOT NULL,  -- code|memory|knowledge|quality|session
  latency_ms    INTEGER,
  status_code   INTEGER,
  request_size  INTEGER,
  response_size INTEGER,
  error_message TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_tool_log_created ON tool_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tool_log_agent   ON tool_log(agent_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tool_log_tool    ON tool_log(tool_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tool_log_key     ON tool_log(api_key_id);

-- ============================================================
-- Quality Reports
-- ============================================================
CREATE TABLE IF NOT EXISTS quality_report (
  id                  TEXT PRIMARY KEY,
  project_name        TEXT NOT NULL,
  agent_name          TEXT NOT NULL,
  session_id          TEXT,
  score_build         INTEGER DEFAULT 0,  -- 0-25
  score_regression    INTEGER DEFAULT 0,  -- 0-25
  score_standards     INTEGER DEFAULT 0,  -- 0-25
  score_traceability  INTEGER DEFAULT 0,  -- 0-25
  score_total         INTEGER GENERATED ALWAYS AS (score_build + score_regression + score_standards + score_traceability) STORED,
  grade               TEXT CHECK(grade IN ('A','B','C','D','F')),
  details             TEXT,  -- JSON
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_quality_project ON quality_report(project_name, created_at DESC);

-- ============================================================
-- Session Handoffs
-- ============================================================
CREATE TABLE IF NOT EXISTS session_handoff (
  id           TEXT PRIMARY KEY,
  project_name TEXT NOT NULL,
  from_agent   TEXT NOT NULL,
  to_agent     TEXT,  -- NULL = open for any agent
  priority     TEXT DEFAULT 'normal' CHECK(priority IN ('critical','high','normal','low')),
  status       TEXT DEFAULT 'pending' CHECK(status IN ('pending','claimed','completed','expired')),
  context      TEXT,  -- JSON
  summary      TEXT NOT NULL,
  claimed_by   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  claimed_at   TEXT,
  completed_at TEXT,
  expires_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_handoff_status ON session_handoff(status, priority);

-- ============================================================
-- Indexed Repos (GitHub import)
-- ============================================================
CREATE TABLE IF NOT EXISTS indexed_repo (
  id              TEXT PRIMARY KEY,
  admin_id        TEXT NOT NULL REFERENCES admin_user(id),
  github_url      TEXT NOT NULL,
  repo_name       TEXT NOT NULL,
  is_private      INTEGER DEFAULT 0,
  clone_path      TEXT,
  status          TEXT DEFAULT 'pending' CHECK(status IN ('pending','indexing','indexed','error')),
  last_indexed_at TEXT,
  symbol_count    INTEGER DEFAULT 0,
  error_message   TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_repo_status ON indexed_repo(status);

-- ============================================================
-- Knowledge Items (agent-contributed, admin-curated)
-- ============================================================
CREATE TABLE IF NOT EXISTS knowledge_item (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  content         TEXT NOT NULL,
  domain          TEXT,
  project_name    TEXT,
  contributed_by  TEXT NOT NULL,
  status          TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  reviewed_by     TEXT,
  qdrant_point_id TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  reviewed_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_knowledge_status ON knowledge_item(status);
