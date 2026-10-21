---
layout: home
title: Cortex Hub
titleTemplate: Memory, code intelligence and orchestration for AI coding agents

hero:
  name: Cortex Hub
  text: One hub for every coding agent you run
  tagline: Self-hosted memory, code intelligence, quality gates and multi-agent orchestration, over one MCP endpoint.
  image:
    src: /mark.svg
    alt: Cortex Hub
  actions:
    - theme: brand
      text: Quick start
      link: /guide/quick-start
    - theme: alt
      text: What is Cortex Hub?
      link: /guide/what-is-cortex
    - theme: alt
      text: See the Conductor
      link: /conductor/index.html
      target: _self

features:
  - icon: 🧠
    title: Sessions that remember
    details: "/cs starts a session, recalls the team's knowledge and your own memory, and shows who else is editing. /ce closes it with a summary the next session picks up."
    link: /guide/sessions
    linkText: Sessions and recall
  - icon: 🔎
    title: Code intelligence across repos
    details: "Hybrid vector + BM25 search, symbol context, blast radius and Cypher over every indexed repo in your organization, without cloning them."
    link: /guide/code-intelligence
    linkText: Code intelligence
  - icon: 📚
    title: Knowledge that compounds
    details: "Team-wide knowledge with hall types and validity dates, per-agent memory, and file notes that show past risks before an agent opens a file."
    link: /guide/knowledge-memory
    linkText: Knowledge and memory
  - icon: 🛡️
    title: Gates the agent cannot skip
    details: "Eight hooks block edits before recall, block commits before build, typecheck and lint pass, and refuse --no-verify."
    link: /reference/hooks
    linkText: The hooks
  - icon: 🎼
    title: Conductor
    details: "A lead plans a tree of tasks; workers on any machine pick them up in worktrees, open PRs, and go through review, gates and quota-aware fallback."
    link: /conductor/overview
    linkText: Plans and workers
  - icon: 🧩
    title: Every IDE, one endpoint
    details: "Claude Code, Cursor, Windsurf, VS Code, Gemini/Antigravity and Codex. One installer writes the MCP config, hooks and rules for each."
    link: /guide/multi-ide
    linkText: Multi-IDE
---

<div class="cx-home">

<section class="cx-section">

<p class="cx-kicker">Why</p>

## Every agent starts from zero. Cortex Hub fixes that.

<p class="cx-lede">Switch IDE, machine or project and a plain coding agent forgets what it learned. Cortex Hub is a backend you host yourself. Every agent on the team talks to it through one MCP endpoint, so decisions, fixes and the code graph outlive the chat they came from.</p>

| | Plain coding agent | With Cortex Hub |
|---|---|---|
| A new session | Starts empty | `/cs` recalls the last session's summary, team knowledge and your memory |
| Finding code | grep, then reads files until it finds the spot | `cortex_code_search` / `cortex_code_context` over an AST graph, any repo in the organization |
| A bug someone already fixed | Fixed again | `cortex_knowledge_search` finds the stored fix |
| Two agents in one file | Find out at merge time | `cortex_changes` shows who else is editing |
| Committing | Whatever the agent decides | Hooks refuse the commit until build, typecheck and lint pass |
| Work bigger than one session | One agent, one chat | Conductor splits it into a plan that workers on other machines run |

</section>

<section class="cx-section">

<p class="cx-kicker">Measured</p>

## Numbers from this repo's own benchmarks

<div class="cx-stats">
  <div class="cx-stat"><b>96.0%</b><span>R@5 on LongMemEval-S, 500 questions</span></div>
  <div class="cx-stat"><b>15 / 15</b><span>code queries with the target file in the top 10</span></div>
  <div class="cx-stat"><b>0.703</b><span>MRR of the shipped hybrid code search (vector 0.656)</span></div>
  <div class="cx-stat"><b>32</b><span>MCP tools: 20 core, 12 Conductor</span></div>
</div>

<p class="cx-note">LongMemEval was measured with an in-process embedder that has since been replaced by Ollama <code>all-minilm</code>. The code retrieval set is small (n = 15). Details and how to rerun them: <a href="./architecture/benchmarks">Benchmarks</a>.</p>

</section>

<section class="cx-section">

<p class="cx-kicker">Start</p>

## Two commands

```bash
# 1. In your project: MCP config, hooks, /cs and /ce for every IDE it finds
curl -fsSL "https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/install.sh" | bash

# 2. In your agent
/cs
```

<p class="cx-lede">No hub yet? <a href="./guide/self-host">Self-host one</a> with Docker Compose. Want agents on other machines to take work? <a href="./conductor/workers">Start a worker</a>.</p>

</section>

</div>
