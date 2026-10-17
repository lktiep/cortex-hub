import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { problems, summary } from '../scripts/check-plan.mjs'

const load = (name) => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'))

test('both plans pass', () => {
  assert.deepEqual(problems(load('plan.json')), [])
  assert.deepEqual(problems(load('plan-escalation.json')), [])
})

test('the summary names the shared file', () => {
  assert.match(summary(load('plan.json')), /lock: src\/format\.js is shared by B1, B2/)
})

test('catches the mistakes the hub would refuse', () => {
  const root = { key: 'R', title: 'Root', kind: 'group' }
  const work = (extra) => ({ key: 'W', title: 'Work', parentKey: 'R', files: ['a.js'], ...extra })
  const check = (...tasks) => problems({ tasks })
  assert.match(check(root, work({ executor: 'gpt' }))[0], /unknown executor/)
  assert.match(check(root, work({ approver: 'user' }))[0], /approver is only for gates/)
  assert.match(check(root, work({ dependsOn: ['R'] }))[0], /cycle: R -> W -> R/)
  assert.match(check(root, work({ files: ['src/*.js'] }))[0], /globs/)
  assert.match(check(root, work({ files: ['../x.js'] }))[0], /invalid path/)
  assert.match(check(root, work({ title: 'Review the diff' }))[0], /review/)
  assert.match(check(root, work({ parentKey: 'W2' }))[0], /not a group/)
  assert.match(check(root, root)[0], /duplicate key R/)
})
