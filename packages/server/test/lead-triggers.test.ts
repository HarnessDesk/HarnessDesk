import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLeadJournal, leadCheckpoint, parseLeadCheckpoint } from '@harnessdesk/lead'
import { parseClientMessage } from '@harnessdesk/protocol'
import { parseTriggers } from '../src/intake/definition.js'
import { definitionOf } from '../src/intake/store.js'
import { TriggerClosures } from '../src/intake/consent.js'
import { writeTriggers, draftTrigger } from '../src/authoring/model.js'
import { IntakeEffects } from '../src/intake/apply.js'
import { LeadControls } from '../src/lead/controls.js'
import { rig } from './fixtures/intake-consent.js'
import { leadRig } from './fixtures/lead.js'

const load = async (): Promise<any> => import('../src/lead/' + 'automatic-goals.js')
const yaml = '- id: lead-pr\n  on: pull-request\n  opens: { lead: true }\n'
const origin = { source: 'pull-request' as const, event: 'event-1', subject: '7', url: 'https://github.com/acme/widgets/pull/7' }

test('Lead targets round-trip YAML, authoring, wire and saved operations, and refuse again', () => {
  const doc = parseTriggers(yaml)
  assert.deepEqual(doc.problems, [])
  const definition = doc.definitions[0]!
  assert.deepEqual(definition.opens, { lead: true })
  assert.deepEqual(parseTriggers(writeTriggers([definition])).definitions, [definition])
  assert.deepEqual(draftTrigger('lead-pr', 'pull-request', { lead: true } as any).opens, { lead: true })
  assert.deepEqual(definitionOf(definition), definition)
  assert.doesNotThrow(() => parseClientMessage({ id: 1, method: 'authoring/triggers/render', params: { definitions: [definition] } }))
  assert.ok(parseTriggers(yaml + '  again: { role: implement }\n').problems.some(one => /again|approval/i.test(one.text)))
  assert.throws(() => writeTriggers([{ ...definition, again: { role: 'implement', title: 'Continue this work', detail: null } }]), /again|approval/i)
  assert.equal(definitionOf({ ...definition, again: { role: 'implement', title: 'Continue this work', detail: null } }), null)
})

test('Lead closure and arm preview promise only a plan for approval, with no fabricated Flow', async () => {
  const definition = parseTriggers(yaml).definitions[0]!
  let reads = 0
  const closure = await new TriggerClosures({ flowSource: async () => { reads++; throw new Error('no Flow') }, preview: async () => { reads++; throw new Error('no preview') } }).freeze('/repo', definition)
  assert.equal(closure.preview, null); assert.equal(reads, 0)
  const r = rig(); r.world.text = yaml
  const preview = await r.consent.preview(r.world.project, 'lead-pr')
  assert.deepEqual(preview.problems, []); assert.ok(preview.token); assert.equal(preview.flow, null)
  assert.match((preview as any).lead.summary, /draft.*plan.*approval/i)
  await r.consent.arm(r.world.project, 'lead-pr', preview.token!)
  assert.ok(await r.consent.binding(r.world.project, 'lead-pr'))
  r.world.text += '# changed\n'
  assert.equal(await r.consent.binding(r.world.project, 'lead-pr'), null)
})

const automatic = async (t: any) => {
  const s = await leadRig(t), records: any[] = []
  const storage = { async read() { return structuredClone(records) }, async append(record: any) { records.push(structuredClone(record)) } }
  const journal = await createLeadJournal(storage)
  await journal.setPolicy(s.journal.state.policy!)
  await journal.updateBudget({ version: 1, type: 'initialize', now: 100, logicalGoalId: 'initial', caps: s.contract.caps, freshnessMs: 1000 })
  let requests = 0, configured = true, enabled = true, quiet = false
  const controls = new LeadControls({ automaticProject: async (path: string) => { Object.assign(s.project, { path, id: 'automatic-project' }) }, journal, project: s.project, model: 'fixture', now: () => 100, nextId: () => 'automatic-goal', push() {}, decidePerson: async () => {}, decideResult: async () => {},
    service: { async status() { return { configured, protection: 'encrypted' as const } }, async setKey() {}, async deleteKey() {}, async assertPublic() {},
      async send() { requests++; await journal.offerCard({ version: 1, id: 'plan', revision: 1, type: 'plan', contractDigest: s.contract.digest, contract: { ...s.contract, project: { ...s.project } } }); return { status: 'completed' } } } } as any)
  t.after(async () => { controls.close(); await controls.idle() })
  const { LeadAutomaticGoals } = await load()
  const owner = new LeadAutomaticGoals({ journal, send: (input: any, origin: any, project: any) => (controls.send as any)(input, origin, project),
    enabled: () => enabled, quiet: async () => quiet })
  return { ...s, journal, controls, owner, storage, requests: () => requests, configured: (v: boolean) => { configured = v }, enabled: (v: boolean) => { enabled = v }, quiet: (v: boolean) => { quiet = v } }
}

test('automatic firing records origin and a plan with zero workers before approval; delivery replay opens nothing twice', async t => {
  const s = await automatic(t)
  const input = { key: 'firing-1', text: 'Draft a plan for PR #7', origin }
  assert.equal((await s.owner.offer(input)).delivered, true)
  await s.controls.idle()
  assert.equal(s.journal.state.phase, 'awaiting-plan'); assert.deepEqual((s.journal.state as any).origin, origin)
  assert.equal(s.journal.state.runs.length, 0); assert.equal(s.requests(), 1)
  assert.equal((await s.owner.offer(input)).delivered, true)
  assert.equal(s.requests(), 1)
  assert.deepEqual((await createLeadJournal(s.storage)).state, s.journal.state)
  assert.deepEqual(parseLeadCheckpoint(leadCheckpoint(s.journal.state, 'b'.repeat(64))).state, s.journal.state)
  const before = s.journal.state.seq
  const busy = await s.owner.offer({ ...input, key: 'firing-2', origin: { ...origin, event: 'event-2' } })
  assert.equal(busy.delivered, false); assert.match(busy.reason, /busy/i); assert.equal(s.journal.state.seq, before)
})
for (const hold of ['quiet', 'disabled', 'key']) test(`${hold} holds automatic input with a named reason`, async t => {
  const s = await automatic(t)
  if (hold === 'quiet') s.quiet(true)
  if (hold === 'disabled') s.enabled(false)
  if (hold === 'key') s.configured(false)
  const result = await s.owner.offer({ key: 'firing-1', text: 'Draft a plan', origin })
  assert.equal(result.delivered, false); assert.match(result.reason, /quiet|disabled|key|credential/i)
  assert.equal(s.requests(), 0); assert.equal(s.journal.state.runs.length, 0)
})

test('Lead-target effects create no Goal, evidence, Flow or Team and keep busy delivery pending', async () => {
  let starts = 0, deliveries = 0, held = true
  const forbidden = async () => { starts++; throw new Error('worker effect') }
  const effects = new IntakeEffects({ goals: { ensureTriggerGoal: forbidden }, flows: { startTriggered: forbidden, againTriggered: forbidden, resumeTriggered: forbidden },
    evidence: { observeTrigger: forbidden }, gate: async () => null,
    lead: async () => { deliveries++; return held ? { delivered: false, reason: 'Lead is busy; this firing waits.' } : { delivered: true } },
  } as any)
  const operation: any = { mode: 'start', state: 'prepared', key: 'firing-1', payload: { definition: parseTriggers(yaml).definitions[0] } }
  await effects.ensureGoal(operation); assert.deepEqual(await effects.observe(operation), []); assert.equal(await effects.ensureRound(operation, []), null)
  assert.deepEqual(await effects.release(operation), { released: false, reason: 'Lead is busy; this firing waits.' })
  held = false; assert.deepEqual(await effects.release(operation), { released: true })
  assert.equal(starts, 0); assert.equal(deliveries, 2)
})

test('a delivered firing survives an intake acknowledgement crash without opening the logical goal twice', async t => {
  const s = await automatic(t)
  const { Admission } = await import('../src/intake/admission.js')
  const { IntakeStore } = await import('../src/intake/store.js')
  const { tempDir } = await import('./scratch.js')
  const home = tempDir('hd-lead-trigger-ack-'), store = new IntakeStore(home); await store.load()
  const binding = { project: s.project.path, incarnation: 'clone', source: 'a'.repeat(64), closure: 'b'.repeat(64), account: 'c'.repeat(64), repository: 'acme/widgets' }
  const definition = parseTriggers(yaml).definitions[0]!
  const fact: any = { source: 'pull-request', project: s.project.path, repository: 'acme/widgets', subject: '7', event: 'd'.repeat(64), action: 'opened',
    at: 100, head: 'a'.repeat(40), fork: false, title: 'Fixture change', body: '', url: origin.url, trigger: null }
  let paused = false, crash = true
  const effects = new IntakeEffects({ goals: { ensureTriggerGoal: async () => { throw new Error('no Team') } }, flows: {} as any,
    evidence: {} as any, gate: async () => null, lead: async op => {
      const result = await s.owner.offer({ key: op.key, text: 'Draft a plan', origin: { ...origin, event: fact.event } })
      if (result.delivered && crash) throw new Error('acknowledgement crash')
      return result
    } })
  const port = { binding: async () => binding, paused: () => paused, now: () => 100, lifecycle: () => 'missing' as const, claim: async () => false }
  let admission = new Admission(store, port, effects)
  const arm = { project: s.project.path, id: definition.id, definition, binding, baseline: 0, armedAt: 0 }
  paused = true; await assert.rejects(admission.offer(arm, fact), /paused/i)
  assert.equal(Object.keys(store.read().firings).length, 0)
  paused = false; await admission.offer(arm, fact); await s.controls.idle()
  assert.equal(s.requests(), 1); assert.ok(store.read().operations.length)
  crash = false
  const reopened = new IntakeStore(home); await reopened.load()
  assert.equal(reopened.problem, null)
  admission = new Admission(reopened, port, effects)
  await admission.recover()
  assert.equal(reopened.read().operations.length, 0)
  assert.equal((await admission.offer(arm, fact)).outcome, 'duplicate')
  assert.equal(s.requests(), 1); assert.equal(s.journal.state.runs.length, 0)
})

 test('an idle Lead drafts in the firing project and a busy Lead never changes projects', async t => {
  const s = await automatic(t), path = '/workspace/other-project'
  const result = await s.owner.offer({ key: 'project-firing', text: 'Draft a plan', origin, project: path })
  assert.equal(result.delivered, true); await s.controls.idle()
  assert.equal((s.journal.state.cards.find(card => card.type === 'plan') as any)?.contract.project.path, path)
  const busy = await s.owner.offer({ key: 'another-project', text: 'Draft another plan', origin: { ...origin, event: 'event-2' }, project: '/workspace/third-project' })
  assert.equal(busy.delivered, false); assert.equal((s.journal.state.cards.find(card => card.type === 'plan') as any)?.contract.project.path, path)
})

test('a crash after origin preparation reserves the draft for its exact firing key', async t => {
  const s = await automatic(t)
  await (s.journal.setOrigin as any)(origin, 'first-firing')
  const result = await s.owner.offer({ key: 'second-firing', text: 'Another draft', origin })
  assert.equal(result.delivered, false); assert.match(result.reason, /busy/)
  assert.equal(s.requests(), 0); assert.equal(s.journal.state.messages.length, 0)
  assert.equal((await s.owner.offer({ key: 'first-firing', text: 'Original draft', origin })).delivered, true)
  await s.controls.idle(); assert.equal(s.requests(), 1)
})
