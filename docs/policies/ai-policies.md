# AI Policies & Quality Gates

> Automated guardrails enforced by the Hub MCP Server to maintain code quality, prevent regressions, and encourage knowledge sharing across all agents.
>
> Inspired by [Forgewright](https://github.com/buiphucminhtam/forgewright-agents)'s quality gate framework, adapted for runtime enforcement.

---

## Core Principles

These principles govern all agent behavior when connected to Cortex Hub:

| # | Principle | Description |
|---|---|---|
| 1 | **Code Reuse First** | Always check for existing code before creating new files |
| 2 | **Verify Own Output** | Build and test after every change — never trust "it should work" |
| 3 | **Incremental Changes** | Small, focused changes. No monolithic rewrites |
| 4 | **No Stubs, No TODOs** | Every deliverable must be complete and functional |
| 5 | **Brownfield Safety** | Branch before modifying, baseline tests before editing |
| 6 | **Knowledge Contribution** | Discovered patterns go back into the shared knowledge base |

---

## Policy Enforcement

Policies are enforced as middleware in the Hub MCP Server. When a policy is violated, the tool call is blocked with a `403` response containing the reason and a suggested alternative.

### Policy 1: Code Reuse Gate

**Trigger:** `create_file` tool calls

**Logic:**
```
IF creating a new file:
  1. Query GitNexus for similar code patterns
  2. IF similar code exists (≥70% match):
     → BLOCK with suggestion to reuse existing code
     → Return file paths of matches
  3. ELSE:
     → ALLOW
```

**Example block response:**
```json
{
  "blocked": true,
  "policy": "code_reuse_gate",
  "reason": "Similar code found in 2 files",
  "matches": [
    "src/utils/formatDate.ts",
    "packages/shared-utils/src/date.ts"
  ],
  "suggestion": "Import from @cortex/shared-utils instead of creating a new file"
}
```

### Policy 2: Context Preservation

**Trigger:** Session start

**Logic:**
```
ON session start:
  1. Load agent memories from mem9
  2. Check for pending session handoffs
  3. Load project profile
  4. Inject context into agent's session
```

### Policy 3: Incremental Change Guard

**Trigger:** `edit_file` or `replace_file_content` tool calls

**Logic:**
```
IF change affects >50% of a file's lines:
  → WARN: "Large change detected — consider splitting"
  → Require explicit confirmation
IF change affects >80%:
  → BLOCK: "Full file rewrite — use incremental approach"
```

### Policy 4: Quality Gate

**Trigger:** After completing a work session (manual or automatic)

**Logic:**
```
Run quality assessment:
  1. Build check    (25 points) — does the project build?
  2. Regression     (25 points) — do existing tests pass?
  3. Standards      (25 points) — lint clean? type-safe?
  4. Traceability   (25 points) — changes documented? tests added?

Score = sum of all categories (0-100)
Grade = A (90+), B (75-89), C (60-74), D (40-59), F (<40)

IF score < 60:
  → BLOCK further work until issues resolved
  → Dashboard alert triggered
```

### Policy 5: Test Coverage Gate

**Trigger:** New function or class creation

**Logic:**
```
IF new exported function/class created:
  1. Check if corresponding test file exists
  2. IF no test:
     → WARN: "New code without tests — add test coverage"
  3. IF test exists but doesn't cover new exports:
     → WARN: "Test file exists but missing coverage for new exports"
```

### Policy 6: Knowledge Contribution

**Trigger:** Session end

**Logic:**
```
ON session end:
  1. Analyze session for discovered patterns
  2. IF new pattern detected (confidence ≥ 0.7):
     → Auto-submit knowledge.contribute()
     → Set approved = false (requires human review)
  3. Submit quality.report() with session score
```

---

## Quality Score Dashboard

The quality score is tracked over time per project and displayed in the Dashboard:

```
┌─────────────────────────────────────────────────────────────┐
│  Quality Trends — keothom                                   │
│                                                             │
│  100 ┤                                                      │
│   90 ┤        ╭──────╮     ╭──────────────╮                 │
│   80 ┤   ╭────╯      ╰─────╯              ╰──── A          │
│   70 ┤───╯                                                  │
│   60 ┤                                                      │
│      └──────────────────────────────────────────────────    │
│        Mon  Tue  Wed  Thu  Fri  Sat  Sun                    │
│                                                             │
│  Current: 87 (B)  │  7-day avg: 83  │  Trend: ↑ +4         │
│                                                             │
│  Gate Results:                                              │
│    Build:        25/25  ✅                                  │
│    Regression:   22/25  ⚠️  (1 flaky test)                 │
│    Standards:    20/25  ⚠️  (3 lint warnings)              │
│    Traceability: 20/25  ⚠️  (missing changelog)            │
└─────────────────────────────────────────────────────────────┘
```

---

## Configuration

Policies can be configured per-project via a `.cortex.yaml` in the project root:

```yaml
# .cortex.yaml
quality:
  min_score: 60              # Minimum passing score
  auto_block: true           # Block work if score < min_score
  grade_thresholds:
    A: 90
    B: 75
    C: 60
    D: 40

policies:
  code_reuse_gate:
    enabled: true
    similarity_threshold: 0.7

  incremental_guard:
    enabled: true
    warn_threshold: 50       # % of file changed
    block_threshold: 80

  test_gate:
    enabled: true
    mode: warn               # warn | block

  knowledge_contribution:
    enabled: true
    auto_contribute: true
    min_confidence: 0.7
```
