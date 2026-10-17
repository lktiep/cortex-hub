import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupDigits, pad2 } from '../src/format.js'

test('pad2 pads to two digits', () => {
  assert.equal(pad2(7), '07')
  assert.equal(pad2(42), '42')
})

test('groupDigits puts a comma every three digits', () => {
  assert.equal(groupDigits(1234567), '1,234,567')
  assert.equal(groupDigits(999), '999')
  assert.equal(groupDigits(-1234.9), '-1,234')
})
