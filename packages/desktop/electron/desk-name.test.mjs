import assert from 'node:assert/strict'
import { test } from 'node:test'
import { systemDeskName } from './desk-name.mjs'

test('Mac desk default reads ComputerName through a bounded read-only system call', () => {
  const calls = []
  const name = systemDeskName({ platform: 'darwin', read: (...args) => { calls.push(args); return '  Studio Computer\n' }, fallback: () => 'host.local' })
  assert.equal(name, 'Studio Computer')
  assert.deepEqual(calls, [['/usr/sbin/scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 1000, maxBuffer: 1024 }]])
})
test('headless and unavailable Mac defaults fall back to the hostname', () => {
  assert.equal(systemDeskName({ platform: 'linux', read: () => { throw new Error('must not call') }, fallback: () => 'host.local' }), 'host.local')
  for (const read of [() => { throw new Error('unavailable') }, () => ' ', () => 'x'.repeat(81)]) {
    assert.equal(systemDeskName({ platform: 'darwin', read, fallback: () => 'host.local' }), 'host.local')
  }
})
