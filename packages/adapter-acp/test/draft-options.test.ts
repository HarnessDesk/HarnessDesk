import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { findOption, sessionId, type AgentEvent } from '@harnessdesk/protocol'

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

test('a real conversation retires a probe ID reused after helper refresh', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'hd-acp-reused-probes-'))
  const identities = join(home, 'probe-sessions.jsonl')
  // A durable record left by an earlier helper must lose to a real open too.
  await writeFile(identities, '"variant-2"\n')
  const runtime = new AcpRuntime({
    id: 'variant', name: 'Variant', command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/variant-acp-agent.mjs', import.meta.url))],
    probeSessionsFile: identities,
  })
  t.after(async () => { await runtime.dispose(); await rm(home, { recursive: true, force: true }) })
  await runtime.start()
  await runtime.defaultSessionOptions('/tmp/acp-draft')
  await runtime.defaultSessionOptions('/tmp/acp-draft', {}, { fresh: true })
  await runtime.defaultSessionOptions('/tmp/acp-draft', {}, { fresh: true })
  assert.deepEqual(await runtime.refreshCatalog(), { refreshed: true })
  await runtime.defaultSessionOptions('/tmp/acp-draft')
  const personal = await runtime.createSession({ cwd: '/tmp/acp-draft' })
  assert.equal(personal.id, 'variant-2', 'the restarted peer really reuses an old probe ID')
  assert.deepEqual((await runtime.listSessions()).data.map((row) => row.id), [personal.id])
  assert.equal(await runtime.resumeSession(personal.id), personal)
  assert.equal((await runtime.readSession(personal.id)).id, personal.id)
  assert.equal((await readFile(identities, 'utf8')).includes('variant-2'), false, 'retire the durable record as well')
  assert.equal(await runtime.stopForIdle(), false)
  assert.deepEqual(await runtime.refreshCatalog(), {
    refreshed: false, reason: 'It keeps no conversations of its own, so restarting it would lose the ones that are open.',
  })
  await personal.close()
  const next = await runtime.createSession({ cwd: '/tmp/acp-draft' })
  assert.equal(next.id, 'variant-3')
  assert.deepEqual((await runtime.listSessions()).data.map((row) => row.id), [next.id])
  assert.equal(await runtime.resumeSession(next.id), next)
  assert.equal(await runtime.stopForIdle(), false, 'an ephemeral probe from the old generation is no longer a probe')
})


test('stored option probes stay hidden across refresh, idle, later reads and desk recreation', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'hd-acp-stored-probes-'))
  const store = join(home, 'agent.json')
  await writeFile(store, JSON.stringify({ personal: { sessionId: 'personal', cwd: '/tmp/acp-draft', title: 'A conversation', updatedAt: '2026-01-01T00:00:00Z', turns: [] } }))
  const config = {
    id: 'stored', name: 'Stored', command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url))],
    env: { FAKE_ACP_STORE: store, FAKE_ACP_STORE_DRAFTS: '1' },
    probeSessionsFile: join(home, 'probe-sessions.jsonl'),
  }
  const runtime = new AcpRuntime(config)
  t.after(async () => { await runtime.dispose(); await rm(home, { recursive: true, force: true }) })
  await runtime.start()
  await runtime.defaultSessionOptions('/tmp/acp-draft', { model: 'small' }, { fresh: true })
  await assert.rejects(runtime.defaultSessionOptions('/tmp/acp-draft', { model: 'missing' }, { fresh: true }), /not one of the values/)
  assert.ok(Object.keys(JSON.parse(await readFile(store, 'utf8'))).length > 1, 'the peer really stored unprompted drafts')
  const onlyPersonal = async (reader: AcpRuntime) => assert.deepEqual((await reader.listSessions()).data.map((row) => String(row.id)), ['personal'])
  await onlyPersonal(runtime)
  assert.deepEqual(await runtime.refreshCatalog(), { refreshed: true })
  await onlyPersonal(runtime)
  assert.equal(await runtime.stopForIdle(), true)
  await onlyPersonal(runtime)
  await runtime.start()
  await runtime.defaultSessionOptions('/tmp/acp-draft', {}, { fresh: true })
  await onlyPersonal(runtime)
  await runtime.dispose()
  const recreated = new AcpRuntime(config)
  t.after(() => recreated.dispose())
  await recreated.start()
  await onlyPersonal(recreated)
  for (const id of Object.keys(JSON.parse(await readFile(store, 'utf8'))).filter((id) => id !== 'personal')) {
    await assert.rejects(recreated.resumeSession(sessionId(id)), /has no conversation/, 'a stored probe cannot be resumed after desk recreation')
  }
  await recreated.defaultSessionOptions('/tmp/acp-draft', {}, { fresh: true })
  await onlyPersonal(recreated)
  const personalDraft = await recreated.createSession({ cwd: '/tmp/acp-draft' })
  assert.deepEqual(new Set((await recreated.listSessions()).data.map((row) => String(row.id))), new Set(['personal', String(personalDraft.id)]), 'a person’s own unprompted draft is visible')
  assert.deepEqual(await recreated.refreshCatalog(), { refreshed: true })
  assert.deepEqual(new Set((await recreated.listSessions()).data.map((row) => String(row.id))), new Set(['personal', String(personalDraft.id)]))
  assert.ok(JSON.parse(await readFile(store, 'utf8')).personal, 'the person’s conversation is never deleted')
})
