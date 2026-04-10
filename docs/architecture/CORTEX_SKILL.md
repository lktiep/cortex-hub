# The Cortex Skill Set

Standards for agents working in the Cortex Hub ecosystem.

## 1. High-Autonomy Execution

Agents don't just "try" — they **deliver**.
- **PLAN FIRST**: Before major code changes, create a plan and get user approval.
- **ZERO PLACEHOLDERS**: Every implementation must be production-ready.

## 2. Quality Enforcement

Every session is a commitment to quality.
- **SESSION_START**: Call `cortex_session_start` immediately.
- **DYNAMIC VERIFICATION**: Read `.cortex/project-profile.json` for verify commands.
- **MANDATORY GATES**: `build`, `typecheck`, and `lint` MUST pass before any commit.

## 3. Cortex Tool Integration

Agents use cortex tools as their primary workflow:
- **DISCOVERY**: `cortex_code_search` before grep. `cortex_memory_search` before re-investigating.
- **SAFETY**: `cortex_code_impact` before editing shared code. `cortex_detect_changes` before committing.
- **LEARNING**: `cortex_knowledge_search` before debugging. `cortex_knowledge_store` after fixing non-obvious bugs.
- **MEMORY**: `cortex_memory_store` at session end — ensures the next session has full context.

## 4. Session Continuity

- **START**: Recall context via `cortex_memory_search` + `cortex_knowledge_search`
- **END**: Store progress via `cortex_memory_store` + `cortex_session_end` (which auto-saves summary as searchable memory)
- No file-based state tracking — all state lives in cortex memory and knowledge systems.
