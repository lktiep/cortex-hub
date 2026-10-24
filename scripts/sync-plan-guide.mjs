#!/usr/bin/env node
// templates/skills/plan/SKILL.md is the planning guide. hub-mcp serves the same text from
// cortex_task_tree_create(guide: true), so a model without skills reads it too. This writes
// the skill's body into apps/hub-mcp/src/tools/plan-guide.ts.
//
//   node scripts/sync-plan-guide.mjs            write plan-guide.ts
//   node scripts/sync-plan-guide.mjs --check    report drift and exit 1 (for CI)
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const skill = readFileSync(`${root}templates/skills/plan/SKILL.md`, 'utf8')
const body = skill.replace(/^---\n[\s\S]*?\n---\n+/, '')
const literal = body.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
const out = [
  '// Generated from templates/skills/plan/SKILL.md by scripts/sync-plan-guide.mjs. Edit the skill, then run it.',
  `export const PLAN_GUIDE = \`${literal}\``,
  '',
].join('\n')

const target = `${root}apps/hub-mcp/src/tools/plan-guide.ts`
if (process.argv.includes('--check')) {
  let current = ''
  try { current = readFileSync(target, 'utf8') } catch { /* missing counts as drift */ }
  if (current !== out) {
    console.error('plan-guide.ts is out of date: run node scripts/sync-plan-guide.mjs')
    process.exit(1)
  }
} else {
  writeFileSync(target, out)
}
