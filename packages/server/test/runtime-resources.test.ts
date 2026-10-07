import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resourcesFromProcessTable } from '../src/runtime-resources.js'

test('counts each owned root and its descendants once, excluding other runtimes', () => {
  const table = '10 1 100\n11 10 200\n12 11 300\n20 1 400\n21 20 500\n'
  assert.deepEqual(resourcesFromProcessTable(table, [10, 11]), { processes: 3, residentBytes: 600 * 1024 })
  assert.deepEqual(resourcesFromProcessTable(table, []), { processes: 0, residentBytes: 0 })
  assert.deepEqual(resourcesFromProcessTable(table, [20]), { processes: 2, residentBytes: 900 * 1024 })
})

test('an exited root cannot claim descendants from a stale sample', () => {
  assert.deepEqual(resourcesFromProcessTable('11 10 200\n', [10]), { processes: 0, residentBytes: 0 })
  assert.throws(() => resourcesFromProcessTable('10 1 unknown\n', [10]), /process table/)
})
