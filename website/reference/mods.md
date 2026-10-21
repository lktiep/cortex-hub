# Mods: cortex-bar

`mods/cortex-bar` is a Claude Code mod (plugin version 0.9.0) that shows this session's Cortex
calls above the prompt: a stacked bar with one color per category, the latest call, what the
results cost and saved in tokens, how often the agent opened what a code lookup ranked, and where
`/cs` stands. Each cortex tool row in the transcript gets a tag in its category's color.

```
◆ cortex ████████████████████████████████████████ 9 calls · last plan_quality 1.3s ✓
■ session 2  ■ knowledge 1  ■ memory 1  ■ code 3  ■ quality 1  ■ tasks 1
tokens ~3.3k in · ~9.8k saved est.  │ lookups cortex 3 · grep 9 · 25% · 1 fallback  │ hit@1 1/3 · …
/cs ● session  ● recall  ● changes  ● tasks  │ ● build  ● typecheck  ○ lint  ○ report
```

Under each cortex tool row:

```
● cortex-hub - cortex_code_search (MCP)(query: "hybrid search")
■ code · 233ms ✓ · ~700 tok · 3 files ~13k · used #2
```

It needs Claude Code 2.1.287 or later, in the terminal or the desktop app.

## Install

For one session, from a clone:

```bash
claude --plugin-dir mods/cortex-bar
```

Or from this repo as a plugin marketplace:

```bash
claude plugin marketplace add lktiep/cortex-hub
claude plugin install cortex-bar@cortex-hub      # --scope project to share it with the repo
```

Then start a new conversation.

### In VS Code, Antigravity and Cursor

The Claude Code extension's chat panel does not draw mod UI. Run Claude Code in the IDE's terminal
instead: set `"claudeCode.useTerminal": true` in the IDE's settings, and the band, the tags and the
pane all show.

## Commands

| Command | What it does |
|---|---|
| `/cortex-bar` | Show or hide the band and the row tags (remembered) |
| `/cortex-bar on`, `/cortex-bar off` | Show or hide explicitly |
| `/cortex-bar reset` | Clear the call counts and the measures |
| `/cortex-calls` | Open a pane with the measures, a per-tool table and the last 50 calls |

## What it measures

Everything is counted in this Claude Code session. The hub's `cortex_tool_stats` counts on the
server, with its own baseline, so the two differ.

| Measure | Meaning |
|---|---|
| Tokens in | Characters of each cortex result divided by 4: what the result added to the context |
| Saved | Per lookup: the size of the files it pointed at (each capped at 25k tokens), less the result's own cost, less the files the agent opened anyway. An upper bound |
| Used / missed | The agent opened one of the files a lookup named (`used #n` is the rank), or opened other files instead (`missed`) |
| hit@k | The share of judged lookups whose best opened file was ranked k or better |
| Lookups vs grep | Cortex code lookups against the agent's own searches that cortex could have answered. A fallback is such a search within three calls of a cortex lookup |
| Quality | From each tool's own output: result counts, top score, `risk_level`, plan score |

The `/cs` checklist reads the same [markers](./hooks#markers) the hooks gate on. `gate-off` shows as
`⚠ gates off`.

The mod sends nothing anywhere. Arguments whose name looks like a credential (`key`, `token`,
`secret`, `password`, `authorization`) are never shown.

## Colors

| Category | Tools |
|---|---|
| session | `session_start`, `session_end`, `changes`, `health`, `list_repos` |
| knowledge | `knowledge_search`, `knowledge_store` |
| memory | `memory_search`, `memory_store`, `memory_delete` |
| code | `code_search`, `code_context`, `code_impact`, `code_reindex`, `cypher`, `detect_changes` |
| quality | `quality_report`, `plan_quality`, `tool_stats` |
| tasks | `task_*` |
| other | any cortex tool not listed |

## Past sessions

The same measures, read back from Claude Code's transcripts:

```bash
node mods/cortex-bar/scripts/lookup-audit.mjs             # this directory's newest 5 sessions
node mods/cortex-bar/scripts/lookup-audit.mjs --last 0    # all of them
```

The full description is in the mod's
[README](https://github.com/lktiep/cortex-hub/tree/master/mods/cortex-bar).
