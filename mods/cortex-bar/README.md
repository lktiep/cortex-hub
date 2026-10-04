# cortex-bar

A Claude Code mod that draws this session's Cortex Hub tool calls above the prompt: a stacked
bar with one color per category, the latest call, what the results cost and saved in tokens,
how often the agent opened what a code lookup ranked, and where `/cs` stands. Each cortex
tool row in the transcript gets a tag in its category's color.

```
◆ cortex ████████████████████████████████████████ 9 calls · last plan_quality 1.3s ✓
■ session 2  ■ knowledge 1  ■ memory 1  ■ code 3  ■ quality 1  ■ tasks 1
tokens ~3.3k in · ~9.8k saved est.  │ hit@1 1/3 · hit@3 2/3 · hit@10 2/3
/cs ● session  ● recall  ● changes  ● tasks  │ ● build  ● typecheck  ○ lint  ○ report
```

While a call is running the tail reads `⟳ code_search`; a failed call turns it into `✗` and
adds `· 1 err`. In a cortex project the band shows `no cortex session yet — run /cs` until
the first `cortex_session_start`; elsewhere it stays out of the way until a cortex tool runs.

Under each cortex tool row:

```
● cortex-hub - cortex_code_search (MCP)(query: "hybrid search")
■ code · 233ms ✓ · ~700 tok · 3 files ~13k · used #2
```

`~700 tok` is what the result put into the context, `3 files ~13k` the files it pointed at
and their size, and `used #2` says the agent went on to open the second of them (`missed`:
it opened other files instead). A search or a check says how its result read instead:
`2 found · top 0.61`, `nothing found`, `risk low`, `7.5/10`.

Needs Claude Code **2.1.287 or later** in the terminal or the desktop app.

## In VS Code, Antigravity and Cursor

The Claude Code extension's chat panel (2.1.288) does not draw mod UI, so run Claude Code
in the IDE's terminal instead: set `"claudeCode.useTerminal": true` in the IDE's settings,
and the extension opens `claude` in an integrated terminal, where the band, the tags and the
pane all show. In Antigravity the setting lives in its user `settings.json`, and its CLI is
`antigravity-ide` (`/Applications/Antigravity IDE.app/Contents/Resources/app/bin/` on macOS).

The mod also knows how to draw on the extension's surface, for when it does: there is no
band above that prompt, so the **newest** cortex row carries the bar, the measures and the
`/cs` checklist, and `/cortex-calls` puts them above its list.

## Install

From a clone, for one session:

```bash
claude --plugin-dir mods/cortex-bar
```

Or from this repo as a marketplace, which is also how the IDE extension gets it (it reads
the same installed plugins as the CLI; it has no `--plugin-dir`):

```bash
claude plugin marketplace add lktiep/cortex-hub     # or the path of a clone
claude plugin install cortex-bar@cortex-hub         # --scope project to share it with the repo
```

Then start a new conversation in the extension (or the terminal).

## Commands

| Command                  | What it does                                        |
| ------------------------ | --------------------------------------------------- |
| `/cortex-bar`            | Show or hide the band and the row tags (remembered) |
| `/cortex-bar on` / `off` | Show / hide explicitly                              |
| `/cortex-bar reset`      | Clear the call counts and the measures              |
| `/cortex-calls`          | Open a pane with the measures and the last 50 calls |

```
◆ 10 cortex calls · 1 failed
tokens ~3.3k in · ~9.8k saved est.  │ hit@1 1/3 · hit@3 2/3 · hit@10 2/3

Per tool ──────────────────────────────────────────────────────────────────────────
  tool               calls   ok     avg    ~tok   saved  quality
■ knowledge_search       1    1   612ms    ~600       ·  1/1 found · last 2 found
■ code_search            2    2    1.3s   ~1.4k   ~9.8k  hit@1 0/2 · hit@3 1/2 · …
■ plan_quality           1    1    1.5s    ~225       ·  0/1 passed · last 7.5/10

Calls newest first ────────────────────────────────────────────────────────────────
17:55:33 ✗ ■ code_reindex          30s      ~0                              MCP error…
17:54:57 ✓ ■ plan_quality         1.5s    ~225  7.5/10                      plan=1. A…
17:54:29 ✓ ■ code_search          1.3s    ~700  3 files ~13k · used #2      query=whe…
```

Every column keeps its width, and only the last one in a row is cut, so nothing wraps. A
narrow pane drops `avg`, then `~tok`, then `ok` from the table, and the calls swap their
tokens and arguments for the result. Where no pane can be placed (a `claude -p` run) the
list comes back as text instead.

## What it measures

Everything is counted in this Claude Code session, from what passes through it; the hub's
own `cortex_tool_stats` counts on the server, with its own baseline.

- **Tokens in** (`~3.3k in`, `~700 tok`): the characters of each cortex result over 4, the
  rule the hub's stats use. An estimate of what the result added to the context.
- **Lookups** are `code_search`, `code_context`, `code_impact` and `cypher`. The mod reads
  the file paths in a lookup's result, up to ten, in the order they appear, and sizes each
  file on disk. A Read, Edit, Write or notebook edit of one of those files, or a Bash command
  naming it, is the agent **using** the lookup; the rank of the best one opened is `used #n`.
  A file can count for any of the last three lookups that returned it. A Read or Edit of a
  project file none of them returned is a stray, and a lookup that closes (three newer ones
  came after it) with strays and nothing used is **missed**; one with neither is unused and
  not judged.
- **hit@k** is the share of judged lookups (used or missed) whose best opened file was
  ranked k or better. It is how often the ranking put the right file where the agent looked.
- **Saved** (`~9.8k saved est.`) is, per lookup: the tokens of the files it pointed at
  (each capped at 25k, about what one Read shows), less what the result itself cost, less
  the files the agent opened anyway. A missed lookup saved nothing. It is an **upper
  bound**: it assumes that without the lookup the agent would have read every one of those
  files. `cortex_tool_stats` uses a fixed per-tool baseline instead, so the two differ.
- **Quality** of other tools comes from their own output: the number of results and the top
  score of `knowledge_search`, the number of `memory_search` results, the `risk_level` of
  `detect_changes` (`unknown` is a failed lookup, not a pass), the score and verdict of
  `plan_quality`.

The measures start over with a new `cortex_session_start`, `/clear` or `/cortex-bar reset`.
They never hold up or change a tool's result: sizes are read in the background, and an
output in a shape the parsers do not know is left unjudged.

## Colors

| Category  | Tools                                                                                    |
| --------- | ---------------------------------------------------------------------------------------- |
| session   | `session_start`, `session_end`, `changes`, `health`, `list_repos`                        |
| knowledge | `knowledge_search`, `knowledge_store`                                                    |
| memory    | `memory_search`, `memory_store`, `memory_delete`                                         |
| code      | `code_search`, `code_context`, `code_impact`, `code_reindex`, `cypher`, `detect_changes` |
| quality   | `quality_report`, `plan_quality`, `tool_stats`                                           |
| tasks     | `task_*`                                                                                 |
| other     | any cortex tool not listed                                                               |

## Where the data comes from

- **Calls** are timed in a `tool.call` hook on every `mcp__<server>__cortex_*` tool, whatever
  the MCP server is called. A new `cortex_session_start` starts the counts over.
- **Opened files** come from a `tool.call` hook on Read, Edit, Write, NotebookEdit and Bash,
  after the tool ran; a denied or failed call does not count.
- **The `/cs` checklist and the gates** come from the markers `.claude/hooks/` writes to
  `.cortex/.session-state/`, the same evidence the hooks gate on. A marker counts only when it
  holds the `tool=` line the tracker writes, so an empty or hand-made file stays `○`. The mod
  rereads them shortly after cortex, Bash and edit tools and at the end of each turn, so
  `build`/`typecheck`/`lint` turn green when the gates pass and go back to `○` after the next
  write clears them. `gate-off` shows as `⚠ gates off`.

The argument shown for a call is its first non-empty `query`, `name`, `target`, `title`,
`repo`, `taskId`, `plan` or `content`, cut to 48 characters. Fields whose name looks like a
credential (`key`, `token`, `secret`, `password`, `authorization`) are never shown. Nothing is
sent anywhere: the mod only reads what passes through this Claude Code session.

## Developing

```bash
cd mods/cortex-bar
claude plugin validate .
claude plugin test
```

The first load (`claude --plugin-dir mods/cortex-bar`) generates the engine's types into
`.claude-plugin/types/` (ignored by git), which `tsconfig.json` extends. After that the
hooks, plain JS with JSDoc types, typecheck strictly:

```bash
node_modules/.bin/tsc -p mods/cortex-bar/tsconfig.json --allowJs --checkJs --noEmit
```

`hooks/model.js` holds everything that decides what is drawn, as pure functions;
`hooks/register.js` times calls, reads the markers and turns rows into elements. The tests
mount every drawing on the surfaces that raise it: the band on `terminal` and `desktop`, the
tool rows, folded groups and the pane on `vscode` as well.
