---
description: Start a new phase with automated gate checks and verification
---
# /phase — Phase Management with Quality Gates

// turbo-all

## Usage

```
/phase N          # Start Phase N (checks Gate N-1→N first)
/phase N status   # Check Gate N-1→N without starting
```

Also triggered by: "start phase N", "bắt đầu phase N", "phase N"

## Steps

### 1. Load Context
- `cortex_memory_search` → recall current phase progress and decisions
- Read `.cortex/project-profile.json` → verify commands
- Check `AGENTS.md` → current phase status

### 2. Run Gate Checks
Execute verification commands:
// turbo
```bash
pnpm build
```
// turbo
```bash
pnpm typecheck
```
// turbo
```bash
pnpm lint
```
// turbo
```bash
pnpm test
```

For server checks (if applicable):
- `curl http://localhost:6333/healthz` (Qdrant)
- `curl http://localhost:8317/` (CLIProxy)

### 3. Report Gate Results
```
## Gate N-1→N Check Results

| Check | Status | Output |
|-------|--------|--------|
| Build | pass/fail | ... |
| Typecheck | pass/fail | ... |
| Lint | pass/fail | ... |
| Test | pass/fail | ... |

**Gate: PASSED** — Ready to start Phase N.
```

If any check fails → fix before proceeding.

### 4. Plan (if gate passed)
- Identify what needs to be built for this phase
- List files to create/modify
- Define acceptance criteria
- **Request user approval** before executing

### 5. Execute → Verify → Commit
- Write code following `.cortex/code-conventions.md`
- Run all verify commands from `project-profile.json`
- Commit with conventional prefix, update `AGENTS.md` phase status

## Rules
- Never skip gate checks
- Never skip the PLAN step
- Never execute before user approves
- Never hardcode verify commands — read from project-profile.json
- Always update `AGENTS.md` "Current Phase" after completing a phase
