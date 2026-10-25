import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as protocol from '@harnessdesk/protocol'

test('proactive reports have exactly three bounded lines and downgrade stale or failed reads', () => {
  const make = (protocol as any).leadProactiveReport
  assert.equal(typeof make, 'function')
  const fact = { finding: 'The review is ready.', caveat: 'Checks still need you.', ask: 'Open changes', action: 'changes' }
  assert.deepEqual(make(fact, 20, 20, true), fact)
  for (const [evidence, read, ok] of [[10, 20, true], [20, 20, false]]) {
    const result = make(fact, evidence, read, ok)
    assert.match(result.finding, /^Unverified report:/)
    assert.match(result.caveat, /could not verify/)
  }
  assert.throws(() => make({ ...fact, extra: 'More text' }, 20, 20, true))
  assert.throws(() => make({ ...fact, finding: 'One\nTwo' }, 20, 20, true))
})
