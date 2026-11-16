import assert from 'node:assert/strict'

/** Only synthetic cookie values from the owned loopback server are expected. */
export function checkCookies(phase, actual) {
  assert.ok(phase === 'write' || phase === 'read', 'unknown cookie phase')
  const when = phase === 'read' ? 'after restart' : 'before restart'
  assert.equal(actual.a, 'fixture=a', `cookie A ${when}`)
  assert.equal(actual.b, 'fixture=b', `cookie B ${when}`)
  assert.equal(actual.memory, phase === 'write' ? 'fixture=memory' : '', `memory cookie ${when}`)
}
