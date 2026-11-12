import assert from 'node:assert/strict'
import { realpath } from 'node:fs/promises'
import test, { type TestContext } from 'node:test'
import { createLeadJournal, type LeadPermissionCall, type LeadPermissionContext } from '@harnessdesk/lead'
import { CLIENT_METHODS, type LeadMemoryProposalResult, type LeadSettingsProposeResult } from '@harnessdesk/protocol'
import type { LeadSupervisorOptions } from '@harnessdesk/lead/supervisor'
import { PHONE_POLICY } from '../src/phone-link.js'
import { evidenceDesk } from './fixtures/evidence-desk.js'

/** The real host and its context, an ordinary fake runtime and a journaled Lead; no child, model or vendor traffic. */
const rig = async (t: TestContext) => {
  const { StateStore } = await import('../src/index.js')
  const { tempDir } = await import('./scratch.js')
  const state = new StateStore(`${tempDir('hd-lead-settings-state-')}/state.json`)
  const desk = await evidenceDesk(t, { leadEnabled: true, state })
  const project = { id: 'project-demo', path: await realpath(desk.repo.dir) }
  const journal = await createLeadJournal({ read: async () => [], append: async () => {} })
  let supervisor: LeadSupervisorOptions | undefined
  await journal.setPolicy({ version: 1, revision: 1, mode: 'manage', rules: [] })
  await journal.updateBudget({ version: 1, type: 'initialize', logicalGoalId: 'settings-goal', now: Date.now(), caps: { usdMicros: 100000, rounds: 3 }, freshnessMs: 60000 })
  const context = (): LeadPermissionContext => ({ desk: journal.state.policy!, projectPolicy: null, project, approved: null, budget: null, now: Date.now(), policyInterpretation: 'idle' })
  const service = desk.host.createLeadService({ journal, project, prices: {},
    resolveTool: async () => ({ project, runId: null, start: null, stepId: null, context: context() }),
    freezePlan: async proposal => proposal, readEvidence: async () => { throw new Error('unused') },
    probeRuntime: async () => ({ supported: true }),
    createSupervisor: settings => { supervisor = settings; return { live: false, ensure: async () => {}, send: async () => ({ status: 'completed', text: '' }), stop: async () => {}, ownershipWithdrawn() {} } },
  })
  await service.setEnabled(true)
  let attempt = 0
  /** A call as the Lead's tool makes it (the alias is checked in the lead package): through the journal and the host's door. */
  const ALIAS: Record<string, string> = { autonomy_propose: 'lead/autonomy/propose', rules_propose: 'lead/rules/propose', memory_propose: 'lead/memory/propose' }
  const tool = async (name: string, input: Record<string, unknown>) => {
    const call = { method: ALIAS[name]!, params: input } as LeadPermissionCall
    return journal.execute({ id: `settings-${++attempt}`, request: { ...call, project, runId: null, start: null }, context: context() },
      async parsed => ({ value: await desk.host.call(parsed.method, parsed.params as never), identity: null }))
  }
  let said = 0
  const personWrites = async (text: string) => { await journal.appendMessage(`person-${++said}`, text, 'person') }
  return { ...desk, journal, tool, personWrites, status: () => supervisor!.readMemoryStatus!() }
}
const result = (outcome: { value?: unknown }) => outcome.value as LeadSettingsProposeResult

test('#2106: the Lead proposes an autonomy change as a card; nothing changes until the person applies it', async t => {
  const r = await rig(t)
  const published: string[] = []
  t.after(r.host.addBroadcaster(notification => { published.push(notification.method) }))
  // "以后桌面有变化不用主动告诉我，只记下来": desk-change reports to Observe.
  const proposed = await r.tool('autonomy_propose', { kind: 'desk-change', mode: 'observe' })
  assert.ok(published.includes('lead/autonomy/changed'), 'the window and the phone are told to read the card')
  assert.equal(proposed.outcome, 'succeeded', JSON.stringify(proposed))
  assert.equal(result(proposed).outcome, 'created')
  assert.equal(result(proposed).id, undefined, 'the Lead is never handed the proposal id: it is no word for it to repeat (#2167)')
  assert.doesNotMatch(result(proposed).note, /\bs[0-9]+\b/)
  const id = (await r.host.call('lead/autonomy/read', {})).proposals![0]!.id
  assert.match(result(proposed).note, /Nothing changes until the person presses Apply/)
  let view = await r.host.call('lead/autonomy/read', {})
  assert.equal(view.modes['desk-change'], 'act', 'a proposal changes nothing')
  assert.deepEqual(view.proposals?.map(one => [one.id, one.state]), [[id, 'pending']])
  assert.ok(view.proposals![0]!.afterSeq > 0, 'placed under the Lead reply that follows it')
  // The phone reads the same card from the same view, and answers it with the same method.
  assert.deepEqual((await r.host.call('workspace/read', {})).autonomy?.proposals?.map(one => one.id), [id])
  assert.equal(PHONE_POLICY.methods['lead/settings/decide'], 'answer')
  view = await r.host.call('lead/settings/decide', { id, decision: 'apply' })
  assert.equal(view.modes['desk-change'], 'observe')
  assert.deepEqual(view.proposals?.map(one => [one.id, one.state, one.history.map(event => event.what)]), [[id, 'applied', ['proposed', 'applied']]])
  assert.deepEqual(view.changes?.[0], { at: view.changes![0]!.at, by: 'person', what: 'mode', kind: 'desk-change', from: 'act', to: 'observe', proposal: id }, 'recorded as the person\'s change, from the Lead\'s proposal')
  // Proposing what is already in force asks nothing.
  assert.equal(result(await r.tool('autonomy_propose', { kind: 'desk-change', mode: 'observe' })).outcome, 'same')
})

test('#2106: the Lead\'s door has no method that applies a setting', () => {
  for (const method of ['lead/autonomy/set', 'lead/rules/update', 'lead/settings/decide', 'lead/deadline/set']) assert.equal(Object.hasOwn(CLIENT_METHODS, method), false, `${method} is not on the client door`)
  assert.equal(CLIENT_METHODS['lead/autonomy/propose'], 'read')
  assert.equal(CLIENT_METHODS['lead/rules/propose'], 'read')
})

test('#2106: a rules proposal applies a new version against the words it was proposed on, and goes stale if they changed', async t => {
  const r = await rig(t)
  // "以后汇报用中文，先说结论": a line for How to talk to me.
  const add = 'Report in Chinese, conclusion first.'
  const first = result(await r.tool('rules_propose', { section: 'talk', add }))
  assert.equal(first.outcome, 'created')
  assert.equal((await r.host.call('lead/rules/read', {})).sections.find(one => one.id === 'talk')!.custom, false, 'nothing written yet')
  const firstId = (await r.host.call('lead/autonomy/read', {})).proposals![0]!.id
  await r.host.call('lead/settings/decide', { id: firstId, decision: 'apply' })
  const talk = (await r.host.call('lead/rules/read', {})).sections.find(one => one.id === 'talk')!
  assert.equal(talk.version, 1)
  assert.ok(talk.text.endsWith(`\n${add}`), talk.text)
  // A second proposal, then the person edits the section on the Settings page before applying it: nothing is overwritten.
  const second = result(await r.tool('rules_propose', { section: 'talk', add: 'Say what you need from me last.' }))
  assert.equal(second.outcome, 'created')
  const secondId = (await r.host.call('lead/autonomy/read', {})).proposals![0]!.id
  await r.host.call('lead/rules/update', { section: 'talk', action: 'edit', text: 'Short. In Chinese.', expectedVersion: 1 })
  await assert.rejects(r.host.call('lead/settings/decide', { id: secondId, decision: 'apply' }), (error: Error & { wireCode?: string }) => error.wireCode === 'lead-rules-stale')
  const after = await r.host.call('lead/autonomy/read', {})
  assert.equal(after.proposals?.find(one => one.id === secondId)?.state, 'stale')
  assert.equal((await r.host.call('lead/rules/read', {})).sections.find(one => one.id === 'talk')!.text, 'Short. In Chinese.')
})

test('#2107: asking again moves the card, a No stands until the person writes, and the Lead reads each proposal\'s real history', async t => {
  const r = await rig(t)
  const first = result(await r.tool('autonomy_propose', { kind: 'stuck', mode: 'off' }))
  assert.equal(first.outcome, 'created')
  const firstId = (await r.host.call('lead/autonomy/read', {})).proposals![0]!.id
  const again = result(await r.tool('autonomy_propose', { kind: 'stuck', mode: 'off' }))
  assert.deepEqual([again.outcome, again.id], ['asked-again', undefined])
  await r.host.call('lead/settings/decide', { id: firstId, decision: 'decline' })
  const refused = result(await r.tool('autonomy_propose', { kind: 'stuck', mode: 'off' }))
  assert.deepEqual([refused.outcome, refused.reason, refused.id], ['refused', 'declined', undefined])
  for (const said of [again.note, refused.note]) assert.doesNotMatch(said, /\bs[0-9]+\b/, 'no proposal id in what the Lead relays (#2167)')
  // Memory proposals carry their history too.
  const note = (await r.tool('memory_propose', { text: 'Deploys happen on Tuesdays.', kind: 'fact' })).value as LeadMemoryProposalResult
  await r.tool('memory_propose', { text: 'Deploys happen on Tuesdays.', kind: 'fact' })
  await r.host.call('lead/memory/change', { action: 'dismiss', id: note.id! })
  const status = (await r.status())!
  assert.match(status, /- Stuck nudges: act to off — declined by the person[^\n]*\(proposed [0-9-]+ [0-9:]+, asked again [0-9-]+ [0-9:]+, declined [0-9-]+ [0-9:]+\)/, status)
  assert.ok(!status.includes(`[${firstId}]`), 'no proposal ids in the settings status (#2167)')
  assert.match(status, new RegExp(`\\[${note.id}\\] declined by the person[^\\n]*\\(proposed [0-9-]+ [0-9:]+, asked again [0-9-]+ [0-9:]+, declined [0-9-]+ [0-9:]+\\)`), status)
  // The person writes again: the change may be offered once more, and the result says it was declined before.
  await r.personWrites('Actually, turn the stuck nudges off.')
  const fresh = result(await r.tool('autonomy_propose', { kind: 'stuck', mode: 'off' }))
  assert.deepEqual([fresh.outcome, fresh.declinedBefore], ['created', true])
})

test('#2165: a line the person applied and then edited away by hand reads as not in force, so the same request proposes it again', async t => {
  const r = await rig(t)
  const ADD = 'Report in Chinese, conclusion first.'
  assert.equal(result(await r.tool('rules_propose', { section: 'talk', add: ADD })).outcome, 'created')
  await r.host.call('lead/settings/decide', { id: (await r.host.call('lead/autonomy/read', {})).proposals![0]!.id, decision: 'apply' })
  assert.equal((await r.host.call('lead/rules/read', {})).sections.find(one => one.id === 'talk')!.version, 1)
  // The person edits the section on the Settings page and takes the line out again: version 2.
  await r.host.call('lead/rules/update', { section: 'talk', action: 'edit', text: 'Plain words, short.', expectedVersion: 1 })
  await r.personWrites('From now on report in Chinese, conclusion first.')
  // A scripted model that believes whatever its context says: the line is in force when the status shows it.
  const status = (await r.status())!
  const settings = status.slice(status.indexOf('<desk-settings-status>'))
  assert.match(settings, /How to talk to me \(talk\), version 2\. Last change [0-9-]+ [0-9:]+: the person edited it in Settings[^\n]*Words now:\n {2}Plain words, short\./, settings)
  const answer: { readonly said?: string; readonly proposed?: LeadSettingsProposeResult } = settings.includes(ADD) ? { said: 'That is already in force.' } : { proposed: result(await r.tool('rules_propose', { section: 'talk', add: ADD })) }
  assert.equal(answer.said, undefined, `the status still read the line as in force:\n${settings}`)
  assert.equal(answer.proposed?.outcome, 'created', 'the same request makes a new proposal')
  assert.equal((await r.host.call('lead/autonomy/read', {})).proposals?.filter(one => one.state === 'pending').length, 1)
})
