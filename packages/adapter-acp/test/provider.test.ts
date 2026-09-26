import assert from 'node:assert/strict'
import { test } from 'node:test'

import { AcpRuntime } from '../src/runtime.js'

/*
 * An ACP agent's provider is what the host's reader of that agent's own
 * configuration says, carried on `RuntimeInfo` — three values, not two.
 * `null` is a reader that could not rule an override out; `undefined` is no
 * reader at all, for an agent the host has none for, whatever it is called.
 * A stall naming why independence could not be proven tells the two apart —
 * see `FlowExecutions#unreadableProviderStall` — but the guard that refuses
 * a seat treats them identically: neither is ever taken for independent.
 */

test('an ACP runtime reports the provider its reader resolved, unknown when it could not tell, and undefined with no reader at all', async () => {
  const asked: (string | undefined)[] = []
  const read = new AcpRuntime({
    id: 'reader-acp', name: 'Reader', command: 'true',
    resolveProvider: async (cwd) => { asked.push(cwd); return cwd === '/elsewhere' ? null : 'vendor-a' },
  })
  assert.equal(await read.providerAt('/project'), 'vendor-a')
  assert.equal(read.info.provider, 'vendor-a')
  assert.equal(await read.providerAt('/elsewhere'), null, 'a folder whose own configuration overrides it')
  assert.ok(asked.includes('/project'))

  const uncertain = new AcpRuntime({ id: 'uncertain-acp', name: 'Uncertain', command: 'true', resolveProvider: async () => null })
  assert.equal(await uncertain.providerAt('/project'), null)
  assert.equal(uncertain.info.provider, null, 'a reader that could not rule an override out is null, not undefined')

  const unread = new AcpRuntime({ id: 'claude-code', name: 'Named for a vendor', command: 'true' })
  assert.equal(await unread.providerAt('/project'), undefined)
  assert.equal(unread.info.provider, undefined, 'never inferred from a name, and no reader at all is undefined, not null')
})
