import assert from 'node:assert/strict'
import { test } from 'node:test'
import { intakeDesk, commitTriggers } from './fixtures/intake-host.js'
import { makeRepo } from './fixtures/evidence-desk.js'
import { LeadFileJournal } from '../src/lead/journal.js'
import { createLeadJournal, LEAD_MESSAGES_DEFAULTS } from '@harnessdesk/lead'
import { CredentialBroker } from '../src/credentials.js'
import { dirname, join } from 'node:path'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createLeadRig } from './fixtures/lead-rig.js'
import { FakeForge, Clocks } from './fixtures/intake-forge.js'

const trigger = `- id: ask
  on: mention
  people: [a-teammate]
  opens: { flow: review-pr }
  again: { role: reviewer }
  concurrency: 4
`

test('characterize default Host mention observer and its real journal', { timeout: 60000 }, async t => {
  const repo = await makeRepo('hd-2066-repro-')
  await commitTriggers(repo, trigger)
  const calls: any[] = []
  const transport = { async send(request: any) {
    calls.push(JSON.parse(request.body))
    return { status: 200, body: JSON.stringify({ type: 'message', role: 'assistant', stop_reason: 'end_turn',
      content: [{ type: 'text', text: '{"decision":"ask","reason":"Please decide."}' }],
      usage: { input_tokens: 100000, output_tokens: 20000, cache_read_input_tokens: 10000, cache_creation_input_tokens: 5000 } }) }
  } }
  const cipher = { protection: 'synthetic cipher', encrypt: (plain: string) => Buffer.from(Buffer.from(plain).toString('hex')), decrypt: (blob: Buffer) => Buffer.from(blob.toString(), 'hex').toString() }
  const d = await intakeDesk({ repo, lead: true, characterizationTransport: transport, characterizationSeed: async stateDir => {
    await new CredentialBroker(join(stateDir, 'credentials.json'), cipher).storeLead('anthropic', 'sk-test-not-real-0000')
  } })
  t.after(() => d.stop())
  d.forge.users.set('a-teammate', { id: 31 })
  const preview: any = await d.host.call('trigger/preview', { root: repo.dir, id: 'ask' })
  assert.deepEqual(preview.problems, [])
  await d.host.call('trigger/arm', { root: repo.dir, id: 'ask', token: preview.token })
  await d.host.call('trigger/mode', { root: repo.dir, id: 'ask', mode: 'act' })
  const say = async (n: number) => {
    const at = d.clocks.wall + 1000
    d.forge.issues.push({ number: n, state: 'open', created: at, updated: at, events: [],
      comments: [{ id: 9000 + n, body: '@dex please fix this', created: at, updated: at, user: { id: 31, login: 'a-teammate' } }] })
    d.clocks.advance(60000)
    await d.host.intakePlane.tick()
  }
  await say(1)
  assert.equal(calls.length, 0, 'unassembled Host has no journal budget and sends nothing')
  console.log('PHASE first', JSON.stringify({calls: calls.length, decisions: await d.host.call('trigger/decisions', { root: repo.dir, id: 'ask' })}))
  await d.host.call('lead/thread/read', {})
  await say(2)
  assert.equal(calls.length, 0, 'automatic assessments default off even with an assembled Lead budget')
  console.log('PHASE assembled', JSON.stringify({calls: calls.length, models: calls.map(x => x.model), decisions: await d.host.call('trigger/decisions', { root: repo.dir, id: 'ask' })}))
})
