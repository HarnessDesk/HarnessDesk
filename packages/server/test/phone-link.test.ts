import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createLeadJournal, type LeadJournal, type LeadJournalRecord } from '@harnessdesk/lead'
import { PhoneSim } from '@harnessdesk/phone-link/sim'
import { LEAD_LIMITS, parseLeadAcceptanceContract, type PhoneLinkState, type WireNotification } from '@harnessdesk/protocol'
import { Logger } from '../src/log.js'
import { dispatch, type HostContext } from '../src/methods/index.js'
import { PHONE_POLICY, phoneLinkOff, phoneResult, startPhoneLink, type PhoneLinkControl } from '../src/phone-link.js'
import { LeadPersonActions } from '../src/lead/person-actions.js'
import { LeadService } from '../src/lead/service.js'

test('repeat history, repeat controls and direct limit raises require their own phone tiers', () => {
  assert.equal(PHONE_POLICY.methods['lead/schedule/read'], 'read')
  assert.equal(PHONE_POLICY.methods['lead/context/read'], 'read')
  assert.equal(PHONE_POLICY.methods['lead/repeat/control'], 'run')
  assert.equal(PHONE_POLICY.methods['lead/budget/raise'], 'answer')
  assert.equal(PHONE_POLICY.methods['lead/thread/read'], 'read')
  assert.equal(PHONE_POLICY.methods['lead/card/decide'], 'answer')
  assert.equal(PHONE_POLICY.methods['lead/settings/update'], undefined)
  assert.equal(PHONE_POLICY.methods['lead/spendLimit/set'], 'answer')
  // The phone reads the autonomy table and flips a switch; it never edits the rules or a deadline.
  assert.equal(PHONE_POLICY.methods['lead/autonomy/read'], 'read')
  assert.equal(PHONE_POLICY.methods['lead/autonomy/set'], 'answer')
  for (const method of ['lead/rules/read', 'lead/rules/update', 'lead/deadline/set']) assert.equal(PHONE_POLICY.methods[method], undefined, method)
})

const project = { id: 'demo', path: '/workspace/demo' }
const contract = parseLeadAcceptanceContract({ version: 1, revision: 1, digest: 'a'.repeat(64), goal: 'Inspect the check', project,
  policyRevision: 1, steps: [{ id: 'work', title: 'Review work', flow: 'lead-reviewed-result', sourceRevision: 'recipe-1', variables: {}, attendance: 'attended',
    assignments: [{ role: 'implement', agent: 'builder', seat: { runtime: 'fixture', model: 'fixture-model' }, ceiling: 'edit' }] }],
  assertions: [{ id: 'unit', kind: 'check', description: 'Tests pass' }, { id: 'review', kind: 'review', description: 'Review approves' }, { id: 'blockers', kind: 'blocking-findings', description: 'No blockers' }], caps: { usdMicros: 100000, rounds: 5 } })
const plan = { version: 1 as const, id: 'plan', revision: 1, type: 'plan' as const, contractDigest: contract.digest, contract }
const planClick = { version: 1 as const, cardId: 'plan', cardType: 'plan' as const, expectedRevision: 1, contractDigest: contract.digest, choice: 'approve' as const }

/** The desk's Lead, over real controls and a fake model, reachable the way the host reaches it. */
type WorkerActions = (journal: LeadJournal) => { read: () => Promise<readonly unknown[]>; perform: (input: any) => Promise<void>; assertPublic: (value: unknown, revision?: number) => Promise<void> }
const desk = async (worker?: WorkerActions) => {
  const performed: unknown[] = []
  const presenceCalls: { method: string; device: unknown }[] = []
  const sends: Record<string, unknown>[] = []
  let personActions: any[] = [{ kind: 'worker-approval', id: 'worker', runId: 'run', role: 'code reviewer', request: 'read the git log', choices: ['yes-once', 'yes-goal', 'no'] }, { kind: 'check', id: 'check', runId: 'run', name: 'verify', command: 'node --test' }]
  const records: LeadJournalRecord[] = []
  const journal = await createLeadJournal({ async read() { return records }, async append(record: LeadJournalRecord) { records.push(record) } })
  const workerActions = worker?.(journal)
  await journal.setPolicy({ version: 1, revision: 1, mode: 'default', rules: [] })
  await journal.updateBudget({ version: 1, type: 'initialize', now: 100, logicalGoalId: 'logical', caps: contract.caps, freshnessMs: 1000 })
  const broadcasters = new Set<(n: WireNotification) => void>()
  const { LeadControls } = await import('../src/lead/controls.js')
  const controls = new LeadControls({
    journal, project, model: 'fixture-model', now: () => 100, nextId: () => `card-${Math.random()}`,
    service: { async status() { return { configured: true, protection: 'synthetic' } }, async setKey() {}, async deleteKey() {}, assertPublic: workerActions?.assertPublic ?? (async () => {}),
      async send() { return { status: 'completed', text: 'Ready to inspect' } } },
    push: (notification: WireNotification) => broadcasters.forEach(f => f(notification)),
    decidePerson: async () => {}, decideResult: async () => {},
    revokeApproval: async (input: any) => journal.revokeWorkerApproval(input.id, input.contractDigest),
    readPersonActions: async () => journal.state.contract ? workerActions ? workerActions.read() : personActions : [], performAction: async (input: any) => { if (workerActions) return workerActions.perform(input); if (!personActions.some(one => one.id === input.id)) throw Object.assign(new Error('stale'), { wireCode: 'lead-card-stale' }); performed.push({ id: input.id, choice: input.choice }); personActions = personActions.filter(one => one.id !== input.id) },
  } as never)
  let attached: PhoneLinkControl | null = null
  const ctx = {
    phone: { state: () => attached?.state() ?? phoneLinkOff, pairing: () => attached!.pairing(), allow: (...a: never[]) => (attached!.allow as any)(...a),
      deny: (id: string) => attached!.deny(id), revoke: (d: string) => attached!.revoke(d) },
    leadPresence: { read: async (device: unknown) => { presenceCalls.push({ method: 'read', device }); return { version: 1, digest: null, asks: [], brief: { enabled: false, at: '07:30' } } },
      dismiss: async (device: unknown) => { presenceCalls.push({ method: 'dismiss', device }); return { version: 1, digest: null, asks: [], brief: { enabled: false, at: '07:30' } } } },
    leadApprovalRevoke: (p: any) => controls.revokeApproval(p), leadActionPerform: (p: unknown) => (controls as any).perform(p), leadThreadRead: () => controls.readThread(), leadThreadSend: (p: unknown) => { sends.push(p as Record<string, unknown>); return controls.send(p as never) }, leadCardDecide: (p: unknown) => controls.decide(p as never),
    leadSettingsRead: () => controls.readSettings(), leadSettingsUpdate: (p: unknown) => controls.updateSettings(p as never), leadSpendLimitSet: (p: unknown) => controls.setSpendLimit(p as never),
    leadStop: (p: unknown) => controls.stop(p as never), leadResume: (p: unknown) => controls.resume(p as never),
  } as unknown as HostContext
  const host = {
    call: (method: string, params: unknown) => dispatch(ctx, method as never, params as never),
    addBroadcaster: (f: (n: WireNotification) => void) => { broadcasters.add(f); return () => { broadcasters.delete(f) } },
    attachPhoneLink: (control: PhoneLinkControl) => { attached = control },
  }
  return { host, journal, controls, ctx, performed, presenceCalls, sends, broadcast: (n: WireNotification) => broadcasters.forEach(f => f(n)) }
}

const rig = async (name: string | (() => string) = 'Test desk', worker?: WorkerActions) => {
  const home = await mkdtemp(join(tmpdir(), 'hd-phone-server-'))
  const d = await desk(worker)
  const running = await startPhoneLink(d.host as never, new Logger('test', { console: false }), { home, host: '127.0.0.1', includeLoopback: true, name })
  const pair = async (tiers?: readonly import('@harnessdesk/protocol').PhoneTier[]) => {
    const code = await running.control.pairing()
    const phone = await PhoneSim.fromCode(code.url)
    await phone.open(running.service.port, phone.offer!.deskPub)
    await phone.enroll(phone.offer!.enroll, 'Jane’s phone')
    for (let i = 0; i < 200 && running.control.state().pending.length === 0; i++) await new Promise(r => setTimeout(r, 10))
    running.control.allow(running.control.state().pending[0]!.id, tiers)
    await phone.next(m => m.t === 'enroll.ok')
    return phone
  }
  return { ...d, running, pair, done: async () => { await running.close(); await rm(home, { recursive: true, force: true }) } }
}

const commandWorker = async (command: string, cwd = project.path) => {
  const approval: any = { type: 'permission', id: 'command-approval', sessionId: 'worker-session', requestedAt: 1,
    summary: command, cwd, facts: [{ label: 'Command', value: command }], options: [
      { id: 'yes', label: 'Allow once', intent: 'approve' }, { id: 'no', label: 'Deny', intent: 'deny' },
    ] }
  const responses: any[] = [], record = { runtime: 'fixture', session: { id: 'worker-session', cwd: project.path }, approvals: new Map([['command-approval', approval]]) }
  const s = await rig('Demo desk', journal => {
    // Run the real public-key guard; the broker and dormant child are synthetic.
    const guard = new LeadService({ journal, broker: { async leadStatus() { return { configured: true } }, async resolveLead() { return 'synthetic-broker-key-for-public-guard' } }, createSupervisor: () => ({}) } as never)
    const state = { get state() { return { ...journal.state, phase: 'running', runs: [{ runId: 'worker-run', teamId: 'worker-team', correlationId: 'worker-start' }], steps: [{ state: 'started', attemptId: 'worker-start' }] } } }
    const actions = new LeadPersonActions(state as never, { registry: { all: () => [record] }, flowsPlane: { executionOf: () => null }, async call(method: string, params: any) { responses.push({ method, params }); record.approvals.delete(params.approvalId) } } as never,
      { seats: { all: () => [{ role: 'implement', closed: null, session: { runtime: 'fixture', sessionId: 'worker-session' }, board: 'worker-team' }] } } as never, value => guard.assertPublic(value))
    return { read: () => actions.read(), perform: input => actions.perform(input), assertPublic: (value, revision) => guard.assertPublic(value, revision) }
  })
  try { await s.journal.offerCard(plan); await s.controls.decide(planClick); await s.controls.idle() }
  catch (error) { await s.done(); throw error }
  return { ...s, approval, responses, record }
}

for (const spec of [
  { name: 'different cwd', command: 'git status', cwd: '/outside/synthetic-folder' },
  { name: 'outside command path', command: 'cat /outside/synthetic-folder/note.txt', cwd: project.path },
  { name: 'scrubbed identity', command: 'echo user@example.com', cwd: project.path },
]) {
  test(`paired phone Lead Command fact retains complete ${spec.name} on reads and pushed projections`, async () => {
    const s = await commandWorker(spec.command, spec.cwd)
    try {
      const desktop = await s.controls.readThread(), desktopAction = desktop.personActions![0]!
      assert.ok(desktopAction.kind === 'worker-approval' && desktopAction.choices.includes('yes-once'), 'the complete request remains decidable on the desk')
      const phone = await s.pair()
      const read = await phone.request('lead/thread/read', {})
      assert.equal(read.ok, true, JSON.stringify(read))
      // lead.md documents complete one-time Lead decisions, unlike the
      // ordinary worker phone card whose fields cannot show this scope.
      const action = read.result.personActions[0]
      assert.deepEqual(action, desktopAction)
      assert.deepEqual(action.choices, ['yes-once', 'no'])
      assert.equal(action.details, `Command: ${spec.command}\nWorking folder: ${spec.cwd}`)
      s.broadcast({ method: 'lead/changed', params: desktop } as never)
      const pushed = await phone.next(m => m.t === 'evt' && m.topic === 'lead')
      assert.deepEqual(pushed.data.personActions[0], desktopAction)
      phone.close()
    } finally { await s.done() }
  })

  test(`paired phone Lead Command fact answers complete ${spec.name} once or No, with stale replay refused`, async () => {
    for (const choice of ['yes-once', 'no']) {
      const s = await commandWorker(spec.command, spec.cwd)
      try {
        const phone = await s.pair(), read = await phone.request('lead/thread/read', {})
        const input = { id: read.result.personActions[0].id, contractDigest: contract.digest, choice }
        const answered = await phone.request('lead/action/perform', input)
        assert.equal(answered.ok, true, JSON.stringify(answered))
        assert.equal(s.responses.length, 1)
        assert.equal(s.responses[0]?.params.decision.optionId, choice === 'no' ? 'no' : 'yes')
        assert.equal(s.record.approvals.size, 0)
        const stale = await phone.request('lead/action/perform', input)
        assert.equal(stale.error.code, 'lead-card-stale')
        assert.equal(s.responses.length, 1)
        phone.close()
      } finally { await s.done() }
    }
  })
}

test('paired phone Lead Command fact shows the full working folder for an informed once choice', async () => {
  const s = await commandWorker('git status')
  try {
    const phone = await s.pair(), read = await phone.request('lead/thread/read', {})
    const action = read.result.personActions[0]
    assert.deepEqual(action.choices, ['yes-once', 'no'])
    assert.match(action.details, /Command: git status/)
    assert.equal(action.details, `Command: git status\nWorking folder: ${project.path}`)
    const allowed = await phone.request('lead/action/perform', { id: action.id, contractDigest: contract.digest, choice: 'yes-once' })
    assert.equal(allowed.ok, true, JSON.stringify(allowed))
    assert.equal(s.responses[0]?.params.decision.optionId, 'yes')
    phone.close()
  } finally { await s.done() }
})

test('paired phone Lead Command fact keeps the public-key guard, desk review and No', async () => {
  const brokerFixture = 'synthetic-broker-key-for-public-guard', s = await commandWorker(`echo ${brokerFixture}`)
  try {
    const phone = await s.pair(), read = await phone.request('lead/thread/read', {})
    const action = read.result.personActions[0]
    assert.deepEqual(action.choices, ['no'])
    assert.match(action.request, /desk/)
    assert.equal(action.details, undefined)
    assert.ok(!JSON.stringify(read.result).includes(brokerFixture))
    const input = { id: action.id, contractDigest: contract.digest, choice: 'yes-once' }
    const refused = await phone.request('lead/action/perform', input)
    assert.equal(refused.error.code, 'lead-operation-refused')
    assert.equal(s.responses.length, 0)
    assert.equal((await phone.request('lead/action/perform', { ...input, choice: 'no' })).ok, true)
    assert.equal(s.responses[0]?.params.decision.optionId, 'no')
    phone.close()
  } finally { await s.done() }
})

test('phone response filtering does not remove coincident fields from other domains', () => {
  const value = { recordedStepInFlight: true, other: 'synthetic' }
  assert.deepEqual(phoneResult('workspace/read', value), value)
})

test('phone receives the old Lead reply state without the desktop-only recorded-step field', async () => {
  const s = await rig()
  try {
    await s.journal.stop(); await s.journal.runStopEffects(async () => {}); await s.controls.idle()
    const host = s.host as { call: (method: string, params: unknown) => Promise<unknown> }
    const call = host.call
    host.call = async (method, params) => {
      const result = await call(method, params)
      return method === 'lead/thread/read' ? { ...result as object, recordedStepInFlight: true } : result
    }
    const phone = await s.pair()
    const read = await phone.request('lead/thread/read', {})
    assert.equal(read.ok, true)
    assert.equal(read.result.requestInFlight, false)
    assert.equal('recordedStepInFlight' in read.result, false)
    const view = await s.controls.readThread()
    s.broadcast({ method: 'lead/changed', params: { ...view, recordedStepInFlight: true } } as never)
    const event = await phone.next(m => m.t === 'evt' && m.topic === 'lead')
    assert.equal(event.data.requestInFlight, false)
    assert.equal('recordedStepInFlight' in event.data, false)
    phone.close()
  } finally { await s.done() }
})

test('a paired phone reads and writes the Lead thread and gets its changes live', async () => {
  const s = await rig()
  try {
    const phone = await s.pair()
    const sent = await phone.request('lead/thread/send', { idempotencyKey: 'phone-1', text: 'Inspect the check' })
    assert.equal(sent.ok, true, JSON.stringify(sent))
    await s.controls.idle()
    const read = await phone.request('lead/thread/read')
    assert.deepEqual(read.result.thread.messages.map((m: any) => m.text), ['Inspect the check', 'Ready to inspect'])
    const changed = await phone.next(m => m.t === 'evt' && m.topic === 'lead')
    assert.equal(changed.data.version, 1)
    assert.ok(changed.seq >= 1)
    phone.close()
  } finally { await s.done() }
})

test('a phone decides a card, and a stale decision is refused with the Lead’s own code', async () => {
  const s = await rig()
  try {
    const phone = await s.pair()
    await s.journal.offerCard(plan)
    const stale = await phone.request('lead/card/decide', { ...planClick, expectedRevision: 0 })
    assert.equal(stale.ok, false)
    assert.equal(stale.error.code, 'lead-card-stale')
    const decided = await phone.request('lead/card/decide', planClick)
    assert.equal(decided.ok, true, JSON.stringify(decided))
    const again = await phone.request('lead/card/decide', planClick)
    assert.equal(again.error.code, 'lead-card-decided')
    phone.close()
  } finally { await s.done() }
})

test('a phone cannot reach settings, the window, or anything the table leaves out', async () => {
  const s = await rig()
  try {
    const phone = await s.pair()
    for (const method of ['lead/settings/update', 'phone/allow', 'phone/revoke', 'phone/pairing', 'flow/start-goal', 'session/start', 'host/hello', 'approval/respond', 'evidence/check/run']) {
      const reply = await phone.request(method, {})
      assert.equal(reply.error.code, 'notOnPhoneSurface', method)
    }
    const bad = await phone.request('lead/thread/send', { text: 7 })
    assert.equal(bad.error.code, 'badRequest')
    phone.close()
  } finally { await s.done() }
})

test('the window sees who is waiting and can remove a phone, which ends its session', async () => {
  const s = await rig()
  try {
    const states: PhoneLinkState[] = []
    s.running.control.onChange(() => states.push(s.running.control.state()))
    const phone = await s.pair()
    assert.ok(states.some(state => state.pending.length === 1))
    const state = await dispatch(s.ctx, 'phone/state', {})
    assert.equal(state.devices.length, 1)
    assert.equal(state.devices[0]!.name, 'Jane’s phone')
    assert.equal(JSON.stringify(state).includes('pushKey'), false)
    const after = await dispatch(s.ctx, 'phone/revoke', { device: state.devices[0]!.id })
    assert.equal(after.devices.length, 0)
    assert.equal((await phone.closedWith()).code, 4423)
  } finally { await s.done() }
})

test('with the phone link off, the window is told so', async () => {
  const d = await desk()
  const state = await dispatch(d.ctx, 'phone/state', {})
  assert.equal(state.enabled, false)
  assert.deepEqual(state.devices, [])
})

for (const choice of ['yes-once', 'yes-goal', 'no', 'run']) test(`paired phone performs person action ${choice} and replays are refused`, async () => {
  const s = await rig()
  try {
    await s.journal.offerCard(plan); await s.controls.decide(planClick)
    const phone = await s.pair()
    const params = { id: choice === 'run' ? 'check' : 'worker', contractDigest: contract.digest, choice }
    assert.equal((await phone.request('lead/action/perform', { ...params, choice: 'always' })).error.code, 'badRequest')
    const reply = await phone.request('lead/action/perform', params)
    assert.equal(reply.ok, true, JSON.stringify(reply))
    assert.deepEqual(s.performed, [{ id: params.id, choice }])
    assert.equal((await phone.request('lead/action/perform', params)).error.code, 'lead-card-stale')
    const device = s.running.control.state().devices[0]!
    await s.running.control.revoke(device.id)
    assert.equal((await phone.closedWith()).code, 4423)
    phone.close()
  } finally { await s.done() }
})

test('paired phone reads saved approvals and revokes through the answer tier', async () => {
  const s = await rig()
  try {
    await s.journal.offerCard(plan); await s.controls.decide(planClick)
    await s.journal.saveWorkerApproval({ id: 'rule-demo', contractDigest: contract.digest, goalStartedSeq: s.journal.state.goalStartedSeq,
      key: { kind: 'fileChange', path: project.path + '/demo.ts' }, target: '/workspace/demo/demo.ts', count: 0 })
    await s.journal.useWorkerApproval('rule-demo', () => true, async () => {}, '+export const demo = 2')
    const auditId = s.journal.state.workerApprovals[0]!.entries![0]!.id
    const phone = await s.pair()
    const read = await phone.request('lead/thread/read', {})
    assert.deepEqual(read.result.savedApprovals, [{ id: 'rule-demo', target: '/workspace/demo/demo.ts', count: 1, entries: [{ id: auditId, number: 1, diff: '+export const demo = 2' }] }])
    assert.equal(read.result.thread.messages.some((message: any) => message.approval), false)
    assert.equal(read.result.personActions[0].choices.includes('yes-goal'), true)
    assert.equal(PHONE_POLICY.methods['lead/approval/revoke'], 'answer')
    const revoked = await phone.request('lead/approval/revoke', { id: 'rule-demo', contractDigest: contract.digest })
    assert.equal(revoked.ok, true, JSON.stringify(revoked))
    assert.deepEqual(revoked.result.savedApprovals, [])
    assert.deepEqual(revoked.result.revokedApprovals, read.result.savedApprovals)
    assert.equal(s.journal.state.workerApprovals[0]!.revoked, true)
    phone.close()
  } finally { await s.done() }
})

test('a paired phone sets the spending limit with Answer, but never reaches the settings that hold permissions and keys', async () => {
  const s = await rig()
  try {
    const policy = s.journal.state.policy, rounds = s.journal.state.budget!.caps.rounds
    const phone = await s.pair()
    const off = await phone.request('lead/spendLimit/set', { usdMicros: null, expectedRevision: s.journal.state.seq })
    assert.equal(off.ok, true, JSON.stringify(off))
    assert.equal(off.result.settings.spendLimitUsdMicros, null)
    assert.deepEqual(s.journal.state.budget!.caps, { usdMicros: LEAD_LIMITS.maxUsdMicros, rounds })
    const stale = await phone.request('lead/spendLimit/set', { usdMicros: 2_000_000, expectedRevision: 0 })
    assert.equal(stale.error.code, 'lead-revision-stale')
    for (const params of [{ usdMicros: 0, expectedRevision: s.journal.state.seq }, { usdMicros: 2_000_000, expectedRevision: s.journal.state.seq, rounds: 99 }])
      assert.equal((await phone.request('lead/spendLimit/set', params)).ok, false, JSON.stringify(params))
    const settings = await phone.request('lead/settings/update', { expectedRevision: s.journal.state.seq, caps: { usdMicros: 1, rounds: 1 } })
    assert.equal(settings.error.code, 'notOnPhoneSurface')
    assert.deepEqual(s.journal.state.policy, policy)
    assert.equal(s.journal.state.budget!.caps.rounds, rounds)
    phone.close()
    const reader = await s.pair(['read', 'run'])
    assert.equal((await reader.request('lead/spendLimit/set', { usdMicros: 2_000_000, expectedRevision: s.journal.state.seq })).error.code, 'tierNotGranted')
    assert.deepEqual(s.journal.state.spendLimit, { usdMicros: null })
    reader.close()
  } finally { await s.done() }
})

test('a paired phone without answer authority cannot save or revoke goal approvals', async () => {
  const s = await rig()
  try {
    await s.journal.offerCard(plan); await s.controls.decide(planClick)
    const phone = await s.pair(['read', 'run'])
    for (const [method, params] of [['lead/action/perform', { id: 'worker', contractDigest: contract.digest, choice: 'yes-goal' }], ['lead/approval/revoke', { id: 'rule-demo', contractDigest: contract.digest }]] as const) {
      const reply = await phone.request(method, params)
      assert.equal(reply.error.code, 'tierNotGranted')
    }
    assert.deepEqual(s.performed, []); assert.deepEqual(s.journal.state.workerApprovals, [])
    phone.close()
  } finally { await s.done() }
})

test('phone projects uncertain dispatches and keeps revoked history after Answer-tier revocation', async () => {
  const s = await rig()
  try {
    await s.journal.offerCard(plan); await s.controls.decide(planClick)
    await s.journal.saveWorkerApproval({ id: 'uncertain', contractDigest: contract.digest, goalStartedSeq: s.journal.state.goalStartedSeq,
      key: { kind: 'tool', tool: 'get_team_status' }, target: 'get_team_status', count: 0 })
    await assert.rejects(s.journal.useWorkerApproval('uncertain', () => true, async () => { throw Error('fixture lost acknowledgement') }))
    const phone = await s.pair()
    const read = await phone.request('lead/thread/read', {})
    assert.equal(read.result.savedApprovals[0].uncertain, true)
    assert.equal(read.result.waitReason, 'lead-worker-audit-failed')
    assert.equal(read.result.wayOut, null)
    const revoked = await phone.request('lead/approval/revoke', { id: 'uncertain', contractDigest: contract.digest })
    assert.deepEqual(revoked.result.savedApprovals, [])
    assert.deepEqual(revoked.result.revokedApprovals, [{ id: 'uncertain', target: 'get_team_status', count: 0 }])
    const again = await phone.request('lead/approval/revoke', { id: 'uncertain', contractDigest: contract.digest })
    assert.equal(again.error.code, 'lead-approval-not-live')
    phone.close()
  } finally { await s.done() }
})

test('a phone is named by its pairing: a device in the request body is ignored end to end', async () => {
  const s = await rig()
  try {
    const phone = await s.pair()
    const forged = { id: 'window:forged', label: 'Forged desktop' }
    assert.equal((await phone.request('lead/presence/read', { device: forged, active: true })).ok, true)
    assert.equal((await phone.request('lead/presence/dismiss', { device: forged, digest: 'away-1-2' })).ok, true)
    assert.equal(s.presenceCalls.length, 2)
    for (const call of s.presenceCalls) {
      const device = call.device as { id: string; label: string }
      assert.match(device.id, /^phone:/, call.method)
      assert.equal(device.label, 'Jane’s phone')
    }
    phone.close()
  } finally { await s.done() }
})

test('a tap carries the ask it answers from the phone to the host, under the phone’s own name', async () => {
  const s = await rig()
  try {
    const phone = await s.pair()
    const forged = { id: 'window:forged', label: 'Forged desktop' }
    const tapped = await phone.request('lead/thread/send', { idempotencyKey: 'tap-1', text: 'Start it', ask: 'message-3', device: forged })
    assert.equal(tapped.ok, true, JSON.stringify(tapped))
    assert.equal(s.sends.length, 1)
    assert.equal(s.sends[0]!.ask, 'message-3', 'the host hears which question the tap answers')
    assert.equal(s.sends[0]!.text, 'Start it')
    assert.match((s.sends[0]!.device as { id: string }).id, /^phone:/)
    assert.equal((await phone.request('lead/thread/send', { idempotencyKey: 'tap-2', text: 'Start it', ask: 7 })).ok, false, 'an ask that is not an id is refused')
    phone.close()
  } finally { await s.done() }
})

test('a presence change reaches an open phone on its own topic, with no text', async () => {
  const s = await rig()
  try {
    const phone = await s.pair()
    s.broadcast({ method: 'lead/presence/changed', params: {} } as never)
    const event = await phone.next(m => m.t === 'evt' && m.topic === 'presence')
    assert.deepEqual(event.data, { v: 1 })
    phone.close()
  } finally { await s.done() }
})

test('local metadata and newly issued pairing codes follow the current desk name', async () => {
  let name = 'Studio Computer'
  const s = await rig(() => name)
  try {
    assert.equal(s.running.control.state().deskName, 'Studio Computer')
    const first = await PhoneSim.fromCode((await s.running.control.pairing()).url)
    assert.equal(first.offer?.name, 'Studio Computer')
    name = 'Travel desk'
    assert.equal(s.running.control.state().deskName, 'Travel desk')
    const second = await PhoneSim.fromCode((await s.running.control.pairing()).url)
    assert.equal(second.offer?.name, 'Travel desk')
  } finally { await s.done() }
})
