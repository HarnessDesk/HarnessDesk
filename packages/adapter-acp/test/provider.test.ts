import assert from 'node:assert/strict'
import { test } from 'node:test'

import { AcpRuntime } from '../src/runtime.js'

/*
 * An ACP agent's provider is what the host's reader of that agent's own
 * configuration says, carried on `RuntimeInfo` — and unknown for an agent
 * the host has no reader for, whatever it is called.
 */

test('an ACP runtime reports the provider its reader resolved, and unknown without one', async () => {
  const asked: (string | undefined)[] = []
  const read = new AcpRuntime({
    id: 'reader-acp', name: 'Reader', command: 'true',
    resolveProvider: async (cwd) => { asked.push(cwd); return cwd === '/elsewhere' ? null : 'vendor-a' },
  })
  assert.equal(await read.providerAt('/project'), 'vendor-a')
  assert.equal(read.info.provider, 'vendor-a')
  assert.equal(await read.providerAt('/elsewhere'), null, 'a folder whose own configuration overrides it')
  assert.ok(asked.includes('/project'))

  const unread = new AcpRuntime({ id: 'claude-code', name: 'Named for a vendor', command: 'true' })
  assert.equal(unread.info.provider, null, 'never inferred from a name')
  assert.equal(await unread.providerAt('/project'), null)
})
