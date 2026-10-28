import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PhoneSim } from '@harnessdesk/phone-link/sim'
import {
  approvalId, itemId, runtimeId, sessionId, turnId, type Approval, type ApprovalOption, type PhoneTier, type PhoneWorkItem, type Session, type WireNotification,
} from '@harnessdesk/protocol'
import { Logger } from '../src/log.js'
import { dispatch, type HostContext } from '../src/methods/index.js'
import { phoneLinkOff, PHONE_POLICY, startPhoneLink, type PhoneLinkControl } from '../src/phone-link.js'
import { PhoneWork } from '../src/phone-work.js'

const RT = runtimeId('agent-a')
const SID = sessionId('s1')
const KEY = `${RT}:${SID}`
const CWD = '/home/dev/acme-api'
const DELAY = 25

const allow: ApprovalOption = { id: 'allow', label: 'Yes', intent: 'approve' }
const forTool: ApprovalOption = { id: 'always-tool', label: 'Yes, for this session', intent: 'approveAlways', grant: 'session-tool' }
const forever: ApprovalOption = { id: 'always-forever', label: 'Yes, always', intent: 'approveAlways', grant: 'permanent' }
const deny: ApprovalOption = { id: 'deny', label: 'No', intent: 'deny' }

const asked = (): Approval => ({
  id: approvalId('ap-1'), sessionId: SID, requestedAt: 1, type: 'command', command: 'pnpm test', cwd: CWD, actions: [], options: [allow, forTool, forever, deny],
})

const conversation: Session = {
  id: SID, runtime: RT, title: 'Fix the importer', cwd: CWD, status: { type: 'idle' }, createdAt: 1, updatedAt: 2, itemsLoaded: true,
  turns: [{
    id: turnId('t1'), status: 'completed',
    items: [
      { id: itemId('u1'), type: 'userMessage', content: [{ type: 'text', text: `Fix ${CWD}/src/auth.ts for dev@example.com` }] },
      { id: itemId('c1'), type: 'command', command: 'pnpm test', cwd: CWD, origin: 'agent', status: 'completed', actions: [], output: `${CWD}/src/auth.ts: the secret transcript line`, exitCode: 0 },
      { id: itemId('a1'), type: 'assistantMessage', text: `Done in ${CWD}/src. Ask dev@example.com.`, phase: 'final' },
    ],
  }],
}

/** Everything a phone must never read in any response. */
const leaks = (value: unknown): string[] => {
  const text = JSON.stringify(value)
  return [/\/home\//, /@/, /secret transcript/].filter(pattern => pattern.test(text)).map(String)
}

/**
 * The real link and the real wire methods over a desk whose work is one session, asked the way a phone asks.
 * What the desk would have to say is scripted through the ports of `PhoneWork`; everything between is the product.
 */
const door = async () => {
  const home = await mkdtemp(join(tmpdir(), 'hd-phone-wire-'))
  const state = { title: 'Fix the importer', pending: [asked()], builds: 0, running: false, responded: [] as any[], actions: [] as any[] }
  const items = (): PhoneWorkItem[] => [{ id: KEY, kind: 'session', title: state.title, phase: 'running', line: 'Working', updatedAt: 1 }]
  const work = new PhoneWork({
    workspace: { workItems: async () => { state.builds++; return items() }, workUsage: async () => undefined, workSessions: () => ({ items: items(), nextCursor: null }) },
    deskName: () => 'Studio Mac',
    home: '/home/dev',
    seatName: runtime => runtime === RT ? 'Agent A' : null,
    isOwn: (runtime, id) => runtime === RT && id === SID,
    summary: () => null,
    read: async () => conversation,
    live: () => ({ running: state.running, pending: state.pending, cwd: CWD }),
    defaultRuntime: () => RT, projectRoots: () => [CWD], canInterrupt: () => true,
    newSessionValues: async () => ({}), queue: async params => { state.actions.push(['send', params]); state.running = true; return { queuedId: null, sent: true } }, create: async params => { state.actions.push(['create', params]); return conversation },
    send: async params => { state.actions.push(['send', params]); state.running = true },
    interrupt: async params => { state.actions.push(['stop', params]); state.running = false },
    respond: async params => { state.responded.push(params); state.pending = state.pending.filter(one => one.id !== params.approvalId) },
    hasSecret: () => false,
    now: () => 1_000,
  })
  let attached: PhoneLinkControl | null = null
  const ctx = {
    phone: { state: () => attached?.state() ?? phoneLinkOff, pairing: () => attached!.pairing(), allow: (...a: never[]) => (attached!.allow as any)(...a),
      deny: (id: string) => attached!.deny(id), revoke: (d: string) => attached!.revoke(d) },
    phoneWork: work,
  } as unknown as HostContext
  const broadcasters = new Set<(notification: WireNotification) => void>()
  const host = {
    call: (method: string, params: unknown) => dispatch(ctx, method as never, params as never),
    addBroadcaster: (listener: (notification: WireNotification) => void) => { broadcasters.add(listener); return () => { broadcasters.delete(listener) } },
    attachPhoneLink: (control: PhoneLinkControl) => { attached = control },
  }
  const running = await startPhoneLink(host as never, new Logger('test', { console: false }), { home, host: '127.0.0.1', includeLoopback: true, name: 'Test desk', workspaceDelayMs: DELAY })
  const pair = async (tiers?: readonly PhoneTier[]) => {
    const code = running.control.pairing()
    const phone = await PhoneSim.fromCode(code.url)
    await phone.open(running.service.port, phone.offer!.deskPub)
    await phone.enroll(phone.offer!.enroll, 'Jane’s phone')
    for (let i = 0; i < 200 && running.control.state().pending.length === 0; i++) await new Promise(r => setTimeout(r, 10))
    running.control.allow(running.control.state().pending[0]!.id, tiers)
    await phone.next(m => m.t === 'enroll.ok')
    return phone
  }
  const emit = (notification: unknown): void => broadcasters.forEach(listener => listener(notification as WireNotification))
  const settle = (ms = DELAY * 6) => new Promise(resolve => setTimeout(resolve, ms))
  return { pair, emit, settle, state, done: async () => { await running.close(); await rm(home, { recursive: true, force: true }) } }
}

const isSnapshot = (m: any): boolean => m.t === 'evt' && m.topic === 'workspace'

test('index changes invalidate paged sessions even when the bounded snapshot is identical', async () => {
  const d = await door()
  try {
    const phone = await d.pair(['read'])
    d.emit({ method: 'goal/changed', params: {} })
    await phone.next(isSnapshot)
    d.emit({ method: 'session/indexChanged', params: { upserted: [], removed: [], firstPageCursor: null } })
    await d.settle()
    assert.equal(phone.inbox.filter(isSnapshot).length, 1, 'an index change beyond the snapshot cap still tells the phone to refresh its pages')
    phone.close()
  } finally { await d.done() }
})

test('encrypted phone page and action requests dispatch only the visible choices to the existing host ports', async () => {
  const d = await door()
  try {
    const reader = await d.pair(['read'])
    const page = await reader.request('workspace/sessions/list', { limit: 37 })
    assert.equal(page.ok, true)
    assert.deepEqual(page.result.items.map((item: any) => item.id), [KEY])
    assert.equal(page.result.nextCursor, null)
    reader.close()
    const phone = await d.pair(['run'])
    assert.deepEqual((await phone.request('workspace/session/start', { text: '  Hello\n', project: 'acme-api' })).result, { id: KEY })
    assert.deepEqual((await phone.request('workspace/session/send', { id: KEY, text: 'Reply\n' })).result, {})
    assert.deepEqual((await phone.request('workspace/stop', { id: KEY })).result, {})
    assert.deepEqual(d.state.actions, [
      ['create', { runtime: RT, options: { cwd: CWD } }],
      ['send', { runtime: RT, sessionId: SID, input: [{ type: 'text', text: '  Hello\n' }] }],
      ['send', { runtime: RT, sessionId: SID, input: [{ type: 'text', text: 'Reply\n' }] }],
      ['stop', { runtime: RT, sessionId: SID }],
    ])
    phone.close()
  } finally { await d.done() }
})

test('session paging needs Read and session start, send and stop each need Run', async () => {
  const d = await door()
  try {
    const reader = await d.pair(['read'])
    for (const [method, params] of [
      ['workspace/session/start', { text: 'Hello' }], ['workspace/session/send', { id: KEY, text: 'Hello' }], ['workspace/stop', { id: KEY }],
    ] as const) assert.equal((await reader.request(method, params)).error.code, 'tierNotGranted', method)
    reader.close()
    const runner = await d.pair(['run'])
    assert.equal((await runner.request('workspace/sessions/list', {})).error.code, 'tierNotGranted')
    runner.close()
  } finally { await d.done() }
})

test('session controls reject invalid text, hidden defaults, unbounded pages and invalid targets at the encrypted boundary', async () => {
  const d = await door()
  try {
    const phone = await d.pair()
    for (const [method, params] of [
      ['workspace/sessions/list', { limit: 0 }], ['workspace/sessions/list', { limit: 101 }], ['workspace/sessions/list', { limit: 1.5 }],
      ['workspace/sessions/list', { cursor: '' }], ['workspace/sessions/list', { archived: 'yes' }],
      ['workspace/session/start', { text: '' }], ['workspace/session/start', { text: ' \n ' }], ['workspace/session/start', { text: 'x'.repeat(32_001) }],
      ['workspace/session/start', { text: 'Hello', project: '' }], ['workspace/session/start', { text: 'Hello', permissions: 'always' }],
      ['workspace/session/start', { text: 'Hello', model: 'hidden' }], ['workspace/session/send', { id: KEY, text: 'Hello', effort: 'high' }],
      ['workspace/session/send', { id: KEY, text: ' ' }], ['workspace/session/send', { id: '', text: 'Hello' }],
      ['workspace/stop', {}], ['workspace/stop', { id: '' }],
    ] as const) assert.equal((await phone.request(method, params)).error.code, 'badRequest', `${method} ${JSON.stringify(params).slice(0, 100)}`)
    phone.close()
  } finally { await d.done() }
})

test('the phone surface carries the three workspace names at the tiers a phone needs, and the topic at read', () => {
  assert.equal(PHONE_POLICY.methods['workspace/read'], 'read')
  assert.equal(PHONE_POLICY.methods['workspace/thread/read'], 'read')
  assert.equal(PHONE_POLICY.methods['workspace/approval/decide'], 'answer')
  assert.equal(PHONE_POLICY.topics.workspace, 'read')
  assert.deepEqual(Object.keys(PHONE_POLICY.methods).filter(name => name.startsWith('workspace/')).sort(), ['workspace/approval/decide', 'workspace/read', 'workspace/session/send', 'workspace/session/start', 'workspace/sessions/list', 'workspace/stop', 'workspace/thread/read'])
})

test('a phone that may read gets the snapshot and a conversation, and neither holds a path, an address or output', async () => {
  const d = await door()
  try {
    const phone = await d.pair(['read'])
    const snapshot = await phone.request('workspace/read', {})
    assert.equal(snapshot.ok, true, JSON.stringify(snapshot))
    assert.equal(snapshot.result.deskName, 'Studio Mac')
    assert.deepEqual(snapshot.result.items.map((item: any) => item.id), [KEY])
    assert.deepEqual(snapshot.result.capabilities, { startSession: true, startTeam: false, reply: true, stop: true, delete: false, chooseModel: false, choosePermissions: false, attach: false, undo: false, decide: true })
    const thread = await phone.request('workspace/thread/read', { id: KEY })
    assert.equal(thread.ok, true, JSON.stringify(thread))
    assert.equal(thread.result.status, 'asksYou')
    assert.deepEqual(thread.result.turns.map((turn: any) => turn.type), ['you', 'work', 'agent', 'approval'])
    const ask = thread.result.turns.at(-1)
    assert.deepEqual([ask.id, ask.state, ask.highRisk, ask.command, ask.sessionGrant !== undefined], ['ap-1', 'pending', false, 'pnpm test', true])
    for (const [name, reply] of Object.entries({ snapshot, thread })) assert.deepEqual(leaks(reply.result), [], name)
    phone.close()
  } finally { await d.done() }
})

test('a phone without the read tier cannot read, and one without the answer tier cannot decide', async () => {
  const d = await door()
  try {
    const runOnly = await d.pair(['run'])
    for (const [method, params] of [['workspace/read', {}], ['workspace/thread/read', { id: KEY }]] as const) {
      const reply = await runOnly.request(method, params)
      assert.equal(reply.error.code, 'tierNotGranted', method)
    }
    const answers = await runOnly.request('workspace/approval/decide', { id: 'ap-1', session: KEY, allow: true })
    assert.equal(answers.error.code, 'tierNotGranted', 'run is not answer')
    runOnly.close()

    const reader = await d.pair(['read'])
    const decide = await reader.request('workspace/approval/decide', { id: 'ap-1', session: KEY, allow: true })
    assert.equal(decide.error.code, 'tierNotGranted', 'read is not answer')
    reader.close()
    assert.deepEqual(d.state.responded, [], 'a refused phone answered nothing')
    assert.equal(d.state.pending.length, 1)
  } finally { await d.done() }
})

test('the window’s other workspace methods, and the actions a phone cannot take yet, stay off the phone surface', async () => {
  const d = await door()
  try {
    const phone = await d.pair()
    for (const method of ['workspace/recent', 'workspace/open', 'workspace/pick', 'workspace/forget', 'workspace/reveal', 'workspace/files', 'workspace/browse', 'workspace/readFile', 'workspace/stat',
      'workspace/team/start', 'workspace/delete', 'workspace/undo', 'phone/sessions/list-all']) {
      const reply = await phone.request(method, {})
      assert.equal(reply.error.code, 'notOnPhoneSurface', method)
    }
    phone.close()
  } finally { await d.done() }
})

test('bad params are refused before any work, and a conversation that is not the person’s is refused without saying more', async () => {
  const d = await door()
  try {
    const phone = await d.pair()
    for (const [method, params] of [
      ['workspace/read', { id: 'x' }], ['workspace/thread/read', {}], ['workspace/thread/read', { id: 7 }],
      ['workspace/approval/decide', { id: 'ap-1', session: KEY }], ['workspace/approval/decide', { id: 'ap-1', session: KEY, allow: 'yes' }],
      ['workspace/approval/decide', { id: 'ap-1', session: KEY, allow: true, scope: 'forever' }], ['workspace/approval/decide', { id: 1, session: KEY, allow: true }],
    ] as const) {
      const reply = await phone.request(method, params)
      assert.equal(reply.error.code, 'badRequest', `${method} ${JSON.stringify(params)}`)
    }
    assert.equal(d.state.builds, 0, 'no work was done for a bad request')
    for (const id of ['agent-a:other', 'agent-b:s1', 'nope', ':']) {
      const reply = await phone.request('workspace/thread/read', { id })
      assert.equal(reply.error.code, 'methodFailed', id)
      assert.equal(reply.error.message, 'That is not a session this desk can show.')
    }
    phone.close()
  } finally { await d.done() }
})

test('a phone decides once or for the session through the window’s own answer, and a repeat is refused', async () => {
  const d = await door()
  try {
    const phone = await d.pair(['answer'])
    const wide = await phone.request('workspace/approval/decide', { id: 'ap-1', session: KEY, allow: false, scope: 'session' })
    assert.equal(wide.error.code, 'methodFailed')
    assert.match(wide.error.message, /Only an allow can last/)
    const unknown = await phone.request('workspace/approval/decide', { id: 'ap-9', session: KEY, allow: true })
    assert.match(unknown.error.message, /not waiting any more/)
    assert.deepEqual(d.state.responded, [])

    const done = await phone.request('workspace/approval/decide', { id: 'ap-1', session: KEY, allow: true, scope: 'session' })
    assert.equal(done.ok, true, JSON.stringify(done))
    assert.deepEqual(done.result, {})
    assert.deepEqual((d.state.responded as any[]).map(one => [one.approvalId, one.decision]), [['ap-1', { type: 'option', optionId: 'always-tool' }]])
    const again = await phone.request('workspace/approval/decide', { id: 'ap-1', session: KEY, allow: true })
    assert.match(again.error.message, /not waiting any more/)
    phone.close()
  } finally { await d.done() }
})

test('a listening phone gets the snapshot when the work changes, once for a change, and never for what did not', async () => {
  const d = await door()
  try {
    const phone = await d.pair(['read'])
    d.emit({ method: 'goal/changed', params: {} })
    const first = await phone.next(isSnapshot)
    assert.equal(first.data.items[0].title, 'Fix the importer')
    assert.equal(first.data.deskName, 'Studio Mac')
    assert.deepEqual(leaks(first.data), [])

    // The same work again is not news, and a burst of changes is one snapshot.
    d.emit({ method: 'seat/activity', params: {} })
    d.emit({ method: 'event', params: { event: { type: 'turn/completed' } } })
    await d.settle()
    assert.equal(phone.inbox.filter(isSnapshot).length, 0, 'an identical snapshot is not sent twice')

    d.state.title = 'Fix the importer and its tests'
    d.emit({ method: 'event', params: { event: { type: 'session/title' } } })
    d.emit({ method: 'team/changed', params: {} })
    const changed = await phone.next(isSnapshot)
    assert.equal(changed.data.items[0].title, 'Fix the importer and its tests')
    assert.ok(changed.seq > first.seq)
    await d.settle()
    assert.equal(phone.inbox.filter(isSnapshot).length, 0, 'a burst is one snapshot')

    // Spend arrives many times a second and changes nothing the snapshot shows between scans.
    const builds = d.state.builds
    d.emit({ method: 'event', params: { event: { type: 'usage/updated' } } })
    await d.settle()
    assert.equal(d.state.builds, builds)
    phone.close()
  } finally { await d.done() }
})

test('with no phone that may read listening, a change builds nothing and a phone without read gets no snapshot', async () => {
  const d = await door()
  try {
    d.emit({ method: 'goal/changed', params: {} })
    await d.settle()
    assert.equal(d.state.builds, 0, 'nobody is listening')

    const runOnly = await d.pair(['run', 'answer'])
    d.emit({ method: 'goal/changed', params: {} })
    await d.settle()
    assert.equal(d.state.builds, 0, 'a phone that cannot read is not listening')
    assert.equal(runOnly.inbox.filter(isSnapshot).length, 0)
    runOnly.close()
  } finally { await d.done() }
})
