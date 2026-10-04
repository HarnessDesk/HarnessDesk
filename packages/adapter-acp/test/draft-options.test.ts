import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { findOption, type AgentEvent } from '@harnessdesk/protocol'

import { AcpRuntime } from '../src/index.js'

for (const answer of ['announce', 'reply']) {
  test(`fresh ${answer} drafts start at new-session defaults and preserve the composer`, async (t) => {
    const runtime = new AcpRuntime({ id: 'variant', name: 'Variant', command: process.execPath, args: [fileURLToPath(new URL('./fixtures/variant-acp-agent.mjs', import.meta.url))], env: { VARIANT_ANSWER: answer } })
    t.after(() => runtime.dispose())
    const events: AgentEvent[] = []
    runtime.subscribe((event) => events.push(event))
    await runtime.start()
    await runtime.defaultSessionOptions('/tmp/acp-draft', { model: 'fam', effort: 'medium', thinking: true })
    events.length = 0
    const pending = Promise.all([
      runtime.defaultSessionOptions('/tmp/acp-draft', { model: 'fam', thinking: true }, { fresh: true }),
      runtime.defaultSessionOptions('/tmp/acp-draft', { model: 'fam', effort: 'medium', thinking: true }, { fresh: true }),
    ])
    assert.equal(await runtime.stopForIdle(), false, 'an outstanding read keeps the helper awake')
    assert.deepEqual(await runtime.refreshCatalog(), { refreshed: false, reason: 'Session options are being read.' })
    const [fresh, supported] = await pending
    assert.equal(findOption(fresh, 'effort')?.currentValue, 'high')
    assert.equal(findOption(fresh, 'thinking')?.currentValue, false)
    assert.equal(findOption(supported, 'thinking')?.currentValue, true)
    const composer = await runtime.defaultSessionOptions('/tmp/acp-draft')
    assert.equal(findOption(composer, 'effort')?.currentValue, 'medium')
    assert.equal(findOption(composer, 'thinking')?.currentValue, true)
    assert.deepEqual((await runtime.listSessions()).data, [])
    assert.equal(events.some((event) => event.type.startsWith('session/') || event.type.startsWith('turn/')), false)
    await assert.rejects(runtime.defaultSessionOptions('/tmp/acp-draft', { model: 'missing' }, { fresh: true }), /"missing" is not one of the values/)
    assert.deepEqual((await runtime.listSessions()).data, [], 'a refused read drops its temporary handle')
    assert.equal(await runtime.stopForIdle(), true, 'completed probes do not keep the helper awake')
  })
}
