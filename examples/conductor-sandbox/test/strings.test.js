import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slugify } from '../src/strings.js'

test('slugify keeps letters and digits, joined by dashes', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world')
  assert.equal(slugify('  Plan 2 -- go  '), 'plan-2-go')
  assert.equal(slugify(''), '')
})
