import assert from 'node:assert/strict'
import { realpath } from 'node:fs/promises'
import test, { type TestContext } from 'node:test'
import { createLeadJournal, type LeadPermissionCall, type LeadPermissionContext } from '@harnessdesk/lead'
import { CLIENT_METHODS, type LeadMemoryProposalResult, type LeadSettingsProposeResult } from '@harnessdesk/protocol'
import type { LeadSupervisorOptions } from '@harnessdesk/lead/supervisor'
import { PHONE_POLICY } from '../src/phone-link.js'
import { evidenceDesk } from './fixtures/evidence-desk.js'
import type { LeadProcess } from '../src/lead/service.js'

/** The real host and its context, an ordinary fake runtime and a journaled Lead; no child, model or vendor traffic. */
const rig = async (t: TestContext, send: LeadProcess['send'] = async () => ({ status: 'completed', text: '' })) => {
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
    createSupervisor: settings => { supervisor = settings; return { live: false, ensure: async () => {}, send, stop: async () => {}, ownershipWithdrawn() {} } },
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
const until = async (done: () => boolean, ms = 10_000) => {
  for (const end = Date.now() + ms; !done();) { if (Date.now() > end) throw new Error('timed out'); await new Promise(resolve => setTimeout(resolve, 25)) }
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
  assert.match(status, /\n- declined by the person[^\n]*Deploys happen on Tuesdays\.[^\n]*\(proposed [0-9-]+ [0-9:]+, asked again [0-9-]+ [0-9:]+, declined [0-9-]+ [0-9:]+\)/, status)
  assert.ok(!status.includes(note.id!), 'no memory proposal id either (#2167)')
  // The person writes again: the change may be offered once more, and the result says it was declined before.
  await r.personWrites('Actually, turn the stuck nudges off.')
  const fresh = result(await r.tool('autonomy_propose', { kind: 'stuck', mode: 'off' }))
  assert.deepEqual([fresh.outcome, fresh.declinedBefore], ['created', true])
})

test('#2165: a line the person applied and then edited away by hand reads as not in force, so the same request proposes it again', async t => {
  const r = await rig(t)
  const ADD = 'Report in Chinese, conclusion first.'
  // The Lead's epoch began before any of this: its instructions hold no words of the person's for the section.
  assert.equal(await r.status() !== null, true)
  assert.equal(result(await r.tool('rules_propose', { section: 'talk', add: ADD })).outcome, 'created')
  await r.host.call('lead/settings/decide', { id: (await r.host.call('lead/autonomy/read', {})).proposals![0]!.id, decision: 'apply' })
  assert.equal((await r.host.call('lead/rules/read', {})).sections.find(one => one.id === 'talk')!.version, 1)
  // The person edits the section on the Settings page and takes the line out again: version 2.
  await r.host.call('lead/rules/update', { section: 'talk', action: 'edit', text: 'Plain words, short.', expectedVersion: 1 })
  await r.personWrites('From now on report in Chinese, conclusion first.')
  // A scripted model that believes whatever its context says: the line is in force when the status shows it.
  const status = (await r.status())!
  const settings = status.slice(status.indexOf('<desk-settings-status>'))
  assert.match(settings, /How to talk to me \(talk\), version 2\. Last change [0-9-]+ [0-9:]+: the person edited it in Settings[^\n]*these hold now:\n {2}Plain words, short\./, settings)
  const answer: { readonly said?: string; readonly proposed?: LeadSettingsProposeResult } = settings.includes(ADD) ? { said: 'That is already in force.' } : { proposed: result(await r.tool('rules_propose', { section: 'talk', add: ADD })) }
  assert.equal(answer.said, undefined, `the status still read the line as in force:\n${settings}`)
  assert.equal(answer.proposed?.outcome, 'created', 'the same request makes a new proposal')
  assert.equal((await r.host.call('lead/autonomy/read', {})).proposals?.filter(one => one.state === 'pending').length, 1)
})

test('#2165: the note compares against the words the child built its epoch with, never the settings the host read first', async t => {
  const r = await rig(t)
  const talk = () => { const status = r.status(); return status.then(text => text!.slice(text!.indexOf('<desk-settings-status>')).split('\n')) }
  await r.host.call('lead/rules/update', { section: 'talk', action: 'edit', text: 'Words A.', expectedVersion: 0 })
  // The child builds this epoch's instructions with A and records them beside the epoch.
  await r.journal.memoryEpoch('settings-goal', r.journal.state.context.epoch, r.journal.state.memory, { talk: { version: 1, text: 'Words A.' } })
  // The person changes the words before the host first reads its settings for this epoch: the note must not take B as held.
  await r.host.call('lead/rules/update', { section: 'talk', action: 'edit', text: 'Words B.', expectedVersion: 1 })
  const lines = await talk()
  const at = lines.findIndex(line => line.startsWith('- How to talk to me (talk), version 2.'))
  assert.ok(at >= 0 && lines[at]!.endsWith('Your instructions hold other words; these hold now:') && lines[at + 1] === '  Words B.', lines.join('\n'))
  // Back to A: the instructions hold those words, so the line costs nothing more.
  await r.host.call('lead/rules/update', { section: 'talk', action: 'edit', text: 'Words A.', expectedVersion: 2 })
  assert.ok((await talk()).some(line => /^- How to talk to me \(talk\), version 3, same as your instructions\./.test(line)))
  // A new epoch the child has not recorded yet: what its instructions hold is not known, so the words are printed.
  await r.journal.memoryEpoch('settings-goal', r.journal.state.context.epoch + 1, r.journal.state.memory, {})
  const unknown = (await talk()).join('\n')
  assert.match(unknown, /version 3\.[^\n]* Your instructions may hold other words; these hold now:\n {2}Words A\./, unknown)
})

test('#2165: a settings change stays marked as news through a failed request and a wake, until the Lead answers the person', async t => {
  const notes: string[] = []
  const replies: ('fail' | 'answer')[] = []
  const r = await rig(t, async input => {
    const last = input.messages.at(-1)!
    const text = (Array.isArray(last.content) ? last.content : []).map(part => 'text' in part ? part.text : '').join('\n')
    notes.push(text.includes('<desk-settings-status>') ? text.slice(text.indexOf('<desk-settings-status>')) : '')
    return replies.shift() === 'fail' ? { status: 'failed', reason: 'lead-request-failed' } : { status: 'completed', text: 'Noted.' }
  })
  t.mock.method(r.host.credentials, 'leadStatus', async () => ({ configured: true, protection: 'synthetic cipher' }))
  t.mock.method(r.host.credentials, 'resolveLead', async () => 'fixture-key')
  const marked = /, changed since your last reply/
  const said = async (key: string, text: string) => {
    const before = notes.length
    await r.host.call('lead/thread/send', { idempotencyKey: key, text })
    await until(() => notes.length > before)
    // The request answered or failed: wait until the journal stops moving before the next one.
    let seq = -1, still = 0
    await until(() => { still = r.journal.state.seq === seq ? still + 1 : 0; seq = r.journal.state.seq; return still >= 4 })
    return notes.at(-1)!
  }
  replies.push('answer')
  await said('person-0', 'Hello.')
  await new Promise(resolve => setTimeout(resolve, 5))
  await r.host.call('lead/rules/update', { section: 'talk', action: 'edit', text: 'Plain words, short.', expectedVersion: 0 })
  replies.push('fail')
  assert.match(await said('person-a', 'How should you write to me?'), marked, 'the first request after the change marks it')
  assert.match((await r.status())!, marked, 'a failed request answered nobody, so a wake still reads the change as news')
  assert.match((await r.status())!, marked, 'and a wake answers nobody either')
  replies.push('answer')
  assert.match(await said('person-b', 'How should you write to me?'), marked, 'the person\'s next turn still marks it')
  replies.push('answer')
  assert.doesNotMatch(await said('person-c', 'Anything else?'), marked, 'once the Lead answered the person with it, it is no longer news')
})

test('#2180: after an Apply the next answered request carries the news once, even when the reply is stored after the request returns', async t => {
  const notes: string[] = []
  // The child answers the way a tool turn does: the request returns before the reply is stored, and the reply comes
  // from the child's continuation a moment later, through the journal (#2170).
  let r!: Awaited<ReturnType<typeof rig>>
  r = await rig(t, async input => {
    const last = input.messages.at(-1)!
    const text = (Array.isArray(last.content) ? last.content : []).map(part => 'text' in part ? part.text : '').join('\n')
    notes.push(text.includes('<desk-settings-status>') ? text.slice(text.indexOf('<desk-settings-status>')) : '')
    setTimeout(() => { void r.journal.appendModelReply('Noted.') }, 30)
    return { status: 'completed', text: '' }
  })
  t.mock.method(r.host.credentials, 'leadStatus', async () => ({ configured: true, protection: 'synthetic cipher' }))
  t.mock.method(r.host.credentials, 'resolveLead', async () => 'fixture-key')
  const marked = /, changed since your last reply/
  const said = async (key: string, text: string) => {
    const before = notes.length, replies = r.journal.state.messages.filter(message => message.role === 'assistant').length
    await r.host.call('lead/thread/send', { idempotencyKey: key, text })
    await until(() => notes.length > before && r.journal.state.messages.filter(message => message.role === 'assistant').length > replies)
    let seq = -1, still = 0
    await until(() => { still = r.journal.state.seq === seq ? still + 1 : 0; seq = r.journal.state.seq; return still >= 4 })
    return notes.at(-1)!
  }
  await said('person-0', 'Hello.')
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(result(await r.tool('rules_propose', { section: 'talk', add: 'Report in Chinese, conclusion first.' })).outcome, 'created')
  const id = (await r.host.call('lead/autonomy/read', {})).proposals![0]!.id
  await r.host.call('lead/settings/decide', { id, decision: 'apply' })
  assert.match(await said('person-a', 'Anything new?'), marked, 'the first request after the Apply carries the news')
  assert.doesNotMatch(await said('person-b', 'And now?'), marked, 'the reply to it was stored, so the next request does not repeat it')
})

// #2176: Keep and Apply leave a receipt in the thread, as a host line both surfaces already draw; No leaves none.
// A receipt is a `system` line: the desktop draws it as a host notice and the phone as its grey line.
const receipts = (r: { journal: { state: { messages: readonly { role: string; id: string; text: string }[] } } }) =>
  r.journal.state.messages.filter(message => message.role === 'system' && message.id.startsWith('receipt-')).map(message => message.text)

test('#2176: Keep on a memory proposal leaves one receipt naming what was kept; No leaves none', async t => {
  const r = await rig(t)
  await r.tool('memory_propose', { text: 'Deploys happen on Tuesdays.', kind: 'fact' })
  await r.tool('memory_propose', { text: 'Reports go in Chinese.', kind: 'preference' })
  const inbox = (await r.host.call('lead/memory/view', {})).inbox
  const id = (text: string) => inbox.find(one => one.text === text)!.id
  await r.host.call('lead/memory/change', { action: 'dismiss', id: id('Deploys happen on Tuesdays.') })
  assert.deepEqual(receipts(r), [], 'No is its own answer: the card goes and nothing is said')
  await r.host.call('lead/memory/change', { action: 'keep', id: id('Reports go in Chinese.') })
  assert.deepEqual(receipts(r), ['Kept · Preference: Reports go in Chinese.'])
  // The person's own wording is what was kept, so it is what the receipt says.
  await r.tool('memory_propose', { text: 'The release train leaves on Fridays.', kind: 'fact' })
  const third = (await r.host.call('lead/memory/view', {})).inbox.find(one => one.text.startsWith('The release train'))!.id
  await r.host.call('lead/memory/change', { action: 'keep', id: third, text: 'The release train leaves on Thursdays.' })
  assert.deepEqual(receipts(r), ['Kept · Preference: Reports go in Chinese.', 'Kept · Fact: The release train leaves on Thursdays.'])
  // The phone draws the same notice from the same thread.
  const thread = await r.host.call('lead/thread/read', {})
  assert.deepEqual(thread.thread.messages.filter(message => message.role === 'system').map(message => message.text), receipts(r))
})

test('#2176: Apply on a settings proposal leaves one receipt with the section and its new version; No leaves none', async t => {
  const r = await rig(t)
  assert.equal(result(await r.tool('rules_propose', { section: 'talk', add: 'Report in Chinese, conclusion first.' })).outcome, 'created')
  const first = (await r.host.call('lead/autonomy/read', {})).proposals![0]!.id
  await r.host.call('lead/settings/decide', { id: first, decision: 'apply' })
  assert.deepEqual(receipts(r), ['Applied · How to talk to me, version 1'])
  assert.equal(result(await r.tool('autonomy_propose', { kind: 'stuck', mode: 'off' })).outcome, 'created')
  const mode = (await r.host.call('lead/autonomy/read', {})).proposals!.find(one => one.state === 'pending')!.id
  await r.host.call('lead/settings/decide', { id: mode, decision: 'decline' })
  assert.deepEqual(receipts(r), ['Applied · How to talk to me, version 1'], 'a No adds nothing')
  await r.personWrites('Fine, turn the stuck nudges off after all.')
  assert.equal(result(await r.tool('autonomy_propose', { kind: 'stuck', mode: 'off' })).outcome, 'created')
  const again = (await r.host.call('lead/autonomy/read', {})).proposals!.find(one => one.state === 'pending')!.id
  await r.host.call('lead/settings/decide', { id: again, decision: 'apply' })
  assert.deepEqual(receipts(r), ['Applied · How to talk to me, version 1', 'Applied · Stuck nudges, Off'])
  assert.equal(result(await r.tool('rules_propose', { section: 'talk', add: 'Say what you need from me last.' })).outcome, 'created')
  const second = (await r.host.call('lead/autonomy/read', {})).proposals!.find(one => one.state === 'pending')!.id
  await r.host.call('lead/settings/decide', { id: second, decision: 'apply' })
  assert.equal(receipts(r).at(-1), 'Applied · How to talk to me, version 2')
})

test('#2176: two Keeps at once each leave the receipt for what they kept, never one for the other', async t => {
  const r = await rig(t)
  await r.tool('memory_propose', { text: 'Deploys happen on Tuesdays.', kind: 'fact' })
  await r.tool('memory_propose', { text: 'Reports go in Chinese.', kind: 'preference' })
  await r.tool('memory_propose', { text: 'Ask before a force push.', kind: 'rule' })
  const inbox = (await r.host.call('lead/memory/view', {})).inbox
  const id = (text: string) => inbox.find(one => one.text === text)!.id
  // Pressed together, from two devices: all start before any is written. The first is kept in the person's own words,
  // which puts it ahead of the others in Core, so a Keep that looked for "the entry that was not there before" would
  // find it again and say it twice.
  await Promise.all([
    r.host.call('lead/memory/change', { action: 'keep', id: id('Deploys happen on Tuesdays.'), text: 'Deploys happen on Tuesdays and Thursdays.' }),
    r.host.call('lead/memory/change', { action: 'keep', id: id('Reports go in Chinese.') }),
    r.host.call('lead/memory/change', { action: 'keep', id: id('Ask before a force push.') }),
  ])
  assert.deepEqual([...receipts(r)].sort(), ['Kept · Fact: Deploys happen on Tuesdays and Thursdays.', 'Kept · Preference: Reports go in Chinese.', 'Kept · Rule: Ask before a force push.'])
})

test('#2176: Apply on a stale or already decided settings proposal is refused and leaves no receipt', async t => {
  const r = await rig(t)
  assert.equal(result(await r.tool('rules_propose', { section: 'talk', add: 'Report in Chinese, conclusion first.' })).outcome, 'created')
  const first = (await r.host.call('lead/autonomy/read', {})).proposals![0]!.id
  await r.host.call('lead/settings/decide', { id: first, decision: 'apply' })
  assert.deepEqual(receipts(r), ['Applied · How to talk to me, version 1'])
  // The same card pressed again from another device: already applied, so nothing changes and nothing is said.
  await assert.rejects(r.host.call('lead/settings/decide', { id: first, decision: 'apply' }), (error: Error & { wireCode?: string }) => error.wireCode === 'lead-proposal-decided')
  // A card whose words the person changed in Settings first.
  assert.equal(result(await r.tool('rules_propose', { section: 'talk', add: 'Say what you need from me last.' })).outcome, 'created')
  const second = (await r.host.call('lead/autonomy/read', {})).proposals!.find(one => one.state === 'pending')!.id
  await r.host.call('lead/rules/update', { section: 'talk', action: 'edit', text: 'Short. In Chinese.', expectedVersion: 1 })
  await assert.rejects(r.host.call('lead/settings/decide', { id: second, decision: 'apply' }), (error: Error & { wireCode?: string }) => error.wireCode === 'lead-rules-stale')
  await assert.rejects(r.host.call('lead/settings/decide', { id: second, decision: 'apply' }), (error: Error & { wireCode?: string }) => error.wireCode === 'lead-proposal-decided')
  assert.deepEqual(receipts(r), ['Applied · How to talk to me, version 1'], 'a refused Apply writes nothing')
})
