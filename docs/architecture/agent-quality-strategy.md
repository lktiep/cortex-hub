# Agent Quality Gates & Performance Strategy

> Architecture decision document — Cortex Hub
> Created: 2026-03-20 | Updated: 2026-03-23 (enforcement hooks added)

---

## 1. Design Philosophy

Cortex Hub uses a **hybrid approach** to quality enforcement:

| Layer | Tool | Cost | Purpose |
|-------|------|------|---------|
| **Client-side** | AGENTS.md + workflows + cortex memory | Zero latency, zero tokens | Enforce process, conventions, verify commands |
| **Server-side** | Cortex Hub MCP tools | ~200-500ms, ~500-2000 tokens | Shared knowledge, memory, code intelligence |
| **Automated** | Lefthook pre-commit/pre-push hooks | Zero manual effort | Prevent bad code from reaching remote |

The key insight: **client-side rules enforce process** (what to do), **server-side MCP provides data** (what to know), **hooks enforce gates** (what must pass).

### Enforcement Layers (6 total)

| Layer | Type | Blocking? | What It Enforces |
|-------|------|-----------|------------------|
| **CLAUDE.md** | Instructions | Soft | Session protocol, tool usage |
| **AGENTS.md** | Instructions | Soft | Routing rules, tool priority |
| **agent-rules.md** | Auto-gen instructions | Soft | MCP tool requirements |
| **Claude Code hooks** | Runtime scripts | **HARD** | Session init, quality gates, commit blocking |
| **Lefthook** | Git hooks | **HARD** | Build/test must pass before git |
| **Server-side validation** | API middleware | **Warn** | Session must exist before quality reports |
| **Post-push webhook** | Notification | Soft | Code reindex trigger |

### IDE Hook Support Matrix

| IDE/Agent | Hooks? | Enforcement Type | What Works |
|-----------|--------|-----------------|------------|
| **Claude Code** | **YES** (4 hooks) | Hard blocking | Commit blocked without gates, session reminders |
| **Cursor** | No | Instructions only | `.cursorrules` + lefthook + server-side |
| **Windsurf** | No | Instructions only | `.windsurfrules` + lefthook + server-side |
| **VS Code Copilot** | No | Instructions only | `copilot-instructions.md` + lefthook + server-side |
| **Antigravity** | No | Instructions only | `GEMINI.md` (enriched) + lefthook + server-side |
| **Headless Bots** | No | Server-side only | API validates session before accepting reports |

### Server-Side Enforcement (All IDEs)

The Dashboard API validates session state on quality report submission:

```
POST /api/quality/report
  └─ validateSession(agent_id, session_id)
     ├─ session_id provided? → verify it's active in DB
     ├─ no session_id? → check if agent has ANY active session
     └─ no active session? → return warning in response
```

This ensures ALL agents (not just Claude Code) get feedback when they skip `cortex_session_start`.

### Auto-Installation via onboard.sh

The `scripts/onboard.sh` script (Step 6b) automatically installs Claude Code hooks when `--tool claude` is selected:

```bash
bash scripts/onboard.sh --tool claude
# Output:
#   ✓ Claude Code hooks installed (4 enforcement hooks)
#     SessionStart  → session-init.sh (inject reminder)
#     PreToolUse    → enforce-commit.sh (block commit without gates)
#     PostToolUse   → track-quality.sh (track gate passes)
#     Stop          → session-end-check.sh (session_end reminder)
```

### Claude Code Hooks (`.claude/settings.json`)

```
SessionStart  →  session-init.sh      Inject mandatory session_start reminder
PreToolUse    →  enforce-commit.sh     Block git commit without quality gates
PostToolUse   →  track-quality.sh      Track build/typecheck/lint pass + MCP calls
Stop          →  session-end-check.sh  Warn if session_end not called
```

**Flow:**
```
Session Start
│
├─ [HOOK] session-init.sh → inject reminder
├─ [AGENT] calls cortex_session_start
├─ [HOOK] track-quality.sh → marks session-started
│
├─ ... work ...
│
├─ [AGENT] runs pnpm build/typecheck/lint
├─ [HOOK] track-quality.sh → marks gates passed
│
├─ [AGENT] git commit
├─ [HOOK] enforce-commit.sh → BLOCKS if gates not passed
├─ [HOOK] lefthook pre-commit → BLOCKS if build fails
│
├─ [AGENT] calls cortex_session_end
│
└─ [HOOK] session-end-check.sh → warns if session_end missing
```

---

## 2. 4-Dimension Quality Scoring

Every quality report evaluates code across **4 dimensions**, each worth 25 points (total = 100):

### Level 1 — Build (0 or 25 pts)
All-or-nothing. Build + typecheck + lint must ALL pass.

```
build passed   → +25
build failed   → 0 (entire level fails)
```

### Level 2 — Regression (0 or 25 pts)
Existing tests must continue passing. Greenfield projects auto-grant 25.

```
all tests pass + count >= baseline  → +25
test regression detected            → 0
greenfield (no baseline)            → +25 (auto-grant)
```

### Level 3 — Standards (0-25 pts, proportional)
Code quality standards enforcement.

| Check | Points | Logic |
|-------|--------|-------|
| No TODO/FIXME/HACK stubs | 10 | Binary: found = 0, none = 10 |
| No hardcoded secrets | 10 | Binary: detected = 0, clean = 10 |
| Lint cleanliness | 5 | Proportional: 0 errors = 5, >10 = 0 |

### Level 4 — Traceability (0-25 pts, proportional)
Output maps to requirements and is verifiable.

| Check | Points | Logic |
|-------|--------|-------|
| Requirements mapped | 15 | Proportional coverage |
| Has tests for new code | 5 | Binary |
| Has documentation | 5 | Binary |

### Scoring Engine

Pure TypeScript functions in `@cortex/shared-types/quality-scoring`:

```typescript
import {
  calculateFromVerificationResults,
  scoreToGrade,
  type VerificationResults,
} from '@cortex/shared-types'

const result = calculateFromVerificationResults({
  buildPassed: true,
  typecheckPassed: true,
  lintPassed: true,
  testsPassed: true,
  stubsFound: 0,
  secretsFound: 0,
  lintErrorCount: 0,
  hasTests: true,
  hasDocs: true,
})
// → { dimensions: { build: 25, regression: 25, standards: 25, traceability: 25 },
//     total: 100, grade: 'A', passed: true }
```

---

## 3. Grade System (A-F)

| Score | Grade | Action |
|-------|-------|--------|
| 90-100 | **A** | Proceed immediately |
| 80-89 | **B** | Proceed with minor warnings |
| 70-79 | **C** | Proceed but flag at next gate |
| 60-69 | **D** | Pause — show report, ask user |
| 0-59 | **F** | Stop — must remediate before proceeding |

Thresholds are configurable via `GradeThresholds`:

```typescript
const customThresholds = { A: 95, B: 85, C: 75, D: 65 }
const grade = scoreToGrade(88, customThresholds) // → 'B'
```

---

## 4. Trend Tracking

Quality scores are persisted per-session in the `quality_reports` SQLite table with full dimension breakdown.

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/quality/report` | POST | Submit a quality gate report |
| `/api/quality/reports` | GET | List reports (filterable) |
| `/api/quality/reports/latest` | GET | Most recent report |
| `/api/quality/trends` | GET | Daily aggregated trends |
| `/api/quality/summary` | GET | Overall statistics + grade distribution |
| `/api/quality/logs` | GET | Legacy execution logs (backward compat) |

### Trend Query Example

```
GET /api/quality/trends?days=30&project_id=proj_xxx

Response:
{
  "trends": [
    {
      "date": "2026-03-20",
      "avg_score": 92.5,
      "avg_build": 25,
      "avg_regression": 25,
      "avg_standards": 22.5,
      "avg_traceability": 20,
      "report_count": 4,
      "worst_grade": "B",
      "best_grade": "A"
    }
  ]
}
```

---

## 5. Auto-Generated Hooks

Lefthook hooks are auto-generated from `project-profile.json` by `scripts/onboard.sh`:

```
project-profile.json          lefthook.yml
┌─────────────────────┐       ┌──────────────────────────┐
│ verify:             │       │ pre-commit:              │
│   pre_commit:       │──────▶│   commands:              │
│     - pnpm build    │       │     pnpm_build:          │
│     - pnpm typecheck│       │       run: pnpm build    │
│     - pnpm lint     │       │     pnpm_typecheck:      │
│   full:             │       │       run: pnpm typecheck │
│     - ...           │──────▶│ pre-push:                │
│     - pnpm test     │       │   commands:              │
│                     │       │     pnpm_test:           │
└─────────────────────┘       │       run: pnpm test     │
                              └──────────────────────────┘
```

---

## 6. MCP Tool: `cortex_quality_report`

### New Format (auto-scoring)

```typescript
cortex_quality_report({
  gate_name: "pre-push",
  agent_id: "claude-code",
  session_id: "sess_123",
  results: {
    buildPassed: true,
    typecheckPassed: true,
    lintPassed: true,
    testsPassed: true,
    stubsFound: 2,
    secretsFound: 0,
    lintErrorCount: 0,
    hasTests: true,
    hasDocs: false,
  }
})
```

Response:
```
Quality Report: pre-push
──────────────────────────────────────────────────
  Build:        25/25  PASS
  Regression:   25/25  PASS
  Standards:    15/25  WARN
  Traceability: 20/25  WARN
──────────────────────────────────────────────────
  Total: 85/100  Grade: B  PASSED
  Action: Proceed with minor warnings
```

### Legacy Format (backward compatible)

```typescript
cortex_quality_report({
  gate_name: "Gate 4",
  passed: true,
  score: 85,
  details: "All checks passed"
})
```

---

## 7. Dashboard Visualization

The Quality Gates dashboard (`/quality`) provides:

1. **Grade Hero** — Current grade badge (A-F) with score, action, and timestamp
2. **4-Dimension Breakdown** — Visual bars for Build, Regression, Standards, Traceability
3. **Statistics** — Total reports, passed/failed counts, average score
4. **Trend Chart** — 30-day bar chart with color-coded grades
5. **Dimension Averages** — Per-dimension progress bars
6. **Grade Distribution** — Histogram of A/B/C/D/F counts
7. **Report History** — Filterable table with per-dimension scores
8. **Execution Logs** — Legacy log view (backward compatible)

---

## 8. Project-Specific Verification

Each project defines verification commands in its `project-profile.json` → `verify` section:

```json
{
  "verify": {
    "pre_commit": ["pnpm build", "pnpm typecheck", "pnpm lint"],
    "full": ["pnpm build", "pnpm typecheck", "pnpm lint", "pnpm test"],
    "auto_fix": true,
    "max_retries": 2
  }
}
```

Agents **never hardcode** verify commands. They read from the profile, ensuring:
- CI/CD parity — local verification matches exactly what CI runs
- Project portability — changing `verify` section adapts to any tech stack
- Single source of truth — one config, all agents follow the same rules

---

## 9. Quality Enforcement Flow

```
Agent receives task
│
├─ [ALWAYS] Read project-profile.json + code-conventions.md (0ms, 0 tokens)
│
├─ [ALWAYS] cortex_memory_search — recall past context (~500ms, ~1000 tokens)
├─ [IF NEEDED] cortex_code_search — code intelligence (~1000ms, ~2000 tokens)
│
├─ [EXECUTE] Write code following conventions
│
├─ [ALWAYS] Run verify.pre_commit from profile
│   ├─ pnpm build
│   ├─ pnpm typecheck
│   └─ pnpm lint
│
├─ [ALWAYS] cortex_quality_report with results → auto-scored, logged to DB
│   ├─ 4-dimension scoring computed server-side
│   ├─ Grade assigned (A-F)
│   ├─ Trend data appended
│   └─ Dashboard updated in real-time
│
├─ [ALWAYS] cortex_memory_store — persist session context
│
└─ Done
```

---

## 10. Measurement Approach

Track these metrics via Dashboard:

| Metric | Source | Formula |
|--------|--------|---------|
| Quality score trend | `quality_reports` table | AVG(score_total) over time |
| Per-dimension health | `quality_reports` table | AVG per dimension |
| Grade distribution | `quality_reports` table | COUNT per grade |
| MCP call latency | `query_logs` table | Average per tool type |
| CI success rate | GitHub Actions | Green vs red builds |
| Edit-revert ratio | Git history | Reverted commits / total |

---

## 11. Complexity-Based Model Routing

The LLM Gateway uses **pure heuristic analysis** (zero LLM overhead) to route tasks to the optimal model tier:

### Tier Classification

| Tier | Score | Use Case | Example Models |
|------|-------|----------|----------------|
| **Light** | 1-3.5 | Simple tasks: typos, renames, status checks | gpt-5.4-mini, gemini-2.5-flash, claude-haiku |
| **Standard** | 3.5-6.5 | Feature work: endpoints, components, bug fixes | gpt-5.4, gemini-2.5-pro, claude-sonnet |
| **Heavy** | 6.5-10 | Complex: architecture, migrations, security audits | o3, gemini-2.5-pro, claude-opus |

### 8 Complexity Signals (weighted)

| Signal | Weight | Low (1-3) | High (7-10) |
|--------|--------|-----------|-------------|
| Keywords | 3 | "fix typo", "rename" | "architect", "migration" |
| Prompt length | 2 | < 10 words | > 500 words |
| File count | 2 | 1 file | > 20 files |
| Step count | 2 | 1 step | > 10 steps |
| Task type | 2 | completion | planning, architecture |
| Token estimate | 1 | < 1K | > 50K |
| Codebase size | 1 | small | large |
| Retry escalation | 1 | first attempt | retry after failure |

### API Usage

```typescript
// Auto-routing: set model to "auto" or omit
POST /api/llm/v1/chat/completions
{
  "model": "auto",
  "messages": [...],
  "complexity": { "fileCount": 5, "taskType": "refactor" }
}

// Response includes routing metadata
{ "routing": { "tier": "standard", "score": 5.2, "reasoning": "..." } }

// Standalone analysis
POST /api/llm/analyze-complexity
{ "prompt": "Refactor the auth system to use JWT", "fileCount": 8 }
```

### Estimated Savings

| Scenario | Without Routing | With Routing | Savings |
|----------|----------------|--------------|---------|
| 100 tasks (mix) | All use Opus | 40% light, 40% standard, 20% heavy | **40-60% tokens** |

---

## 12. Plan Quality Loop

Pre-execution validation scores plans against **8 criteria** before implementation starts.

### 8 Scoring Criteria

| Criterion | Weight | What It Measures |
|-----------|--------|------------------|
| Completeness | 2 | Does the plan cover all aspects of the request? |
| Specificity | 2 | Are file paths, function names, and commands specified? |
| Feasibility | 1.5 | Is the scope achievable in one session? |
| Risk Awareness | 1 | Are breaking changes, rollback, edge cases addressed? |
| Scope Boundary | 1.5 | Is scope clearly defined without creep? |
| Ordering | 1 | Are steps logically ordered with dependencies? |
| Testability | 1.5 | How will success be verified? (build/test commands) |
| Impact Clarity | 1 | What changes, what's affected, expected outcome? |

### Threshold & Iteration

```
Score >= 8.0/10  → APPROVED — proceed with implementation
Score < 8.0      → NEEDS IMPROVEMENT — revise plan (max 3 iterations)
3 failed iterations → ESCALATE to user for guidance
```

### MCP Tool: `cortex_plan_quality`

```typescript
cortex_plan_quality({
  plan: "1. Add JWT middleware to auth.ts\n2. Update user routes...",
  request: "Add JWT authentication",
  iteration: 1,
  threshold: 8.0,
  plan_type: "feature",
})
```

Response:
```
Plan Quality Assessment (Iteration 1/3)
───────────────────────────────────────────────────────────
  Completeness       ████████░░ 8.0/10  GOOD
  Specificity        █████████░ 9.0/10  GOOD
  Feasibility        ████████░░ 8.0/10  GOOD
  Risk Awareness     ██████░░░░ 6.0/10  OK
  Scope Boundary     █████████░ 9.0/10  GOOD
  Ordering           ████████░░ 8.0/10  GOOD
  Testability        ████████░░ 8.0/10  GOOD
  Impact Clarity     ███████░░░ 7.0/10  GOOD
───────────────────────────────────────────────────────────
  Total Score: 8.1/10  APPROVED

Plan APPROVED. Proceed with implementation.
```

---

### Comparison with Forgewright Reference

| Feature | Forgewright | Cortex Hub | Status |
|---------|-------------|------------|--------|
| 4-dimension scoring | Protocol docs | Scoring engine + DB + API | **Implemented** |
| Grade system (A-F) | Protocol docs | Configurable thresholds | **Implemented** |
| Trend tracking | JSON files | SQLite + REST API + Dashboard | **Implemented** |
| Auto-generated hooks | Conceptual | Lefthook from project-profile | **Production-ready** |
| Dashboard visualization | N/A | Full web dashboard | **Implemented** |
| MCP integration | N/A | `cortex_quality_report` tool | **Implemented** |
