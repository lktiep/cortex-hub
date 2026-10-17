import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mean, sum } from '../src/math.js'

test('sum adds a list, 0 when empty', () => {
  assert.equal(sum([1, 2, 3]), 6)
  assert.equal(sum([]), 0)
})

test('mean averages a list, NaN when empty', () => {
  assert.equal(mean([2, 4]), 3)
  assert.ok(Number.isNaN(mean([])))
})
