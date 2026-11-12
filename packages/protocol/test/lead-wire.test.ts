import assert from 'node:assert/strict'
import test from 'node:test'
import { CLIENT_METHODS, LEAD_LIMITS, knownMethods, leadContextUse, parseClientMessage, parseLeadAsk, parseLeadThreadSend } from '../src/index.js'

const names = ['lead/chats/resetControl', 'lead/chats/control', 'lead/chat/takeOver', 'lead/chat/handBack', 'lead/approval/revoke', 'lead/repeat/control', 'lead/budget/raise', 'lead/spendLimit/set', 'lead/wakes/read', 'lead/thread/read', 'lead/thread/send', 'lead/card/decide', 'lead/settings/read', 'lead/settings/update', 'lead/resume', 'lead/stop', 'lead/action/perform', 'lead/steer', 'lead/memory/read', 'lead/memory/update', 'lead/memory/view', 'lead/memory/change', 'lead/schedule/read', 'lead/schedule/update', 'lead/context/read', 'lead/context/compact']
const chatNames = ['lead/chat/list', 'lead/chat/read', 'lead/chat/start', 'lead/chat/send', 'lead/chat/stop']
const request = (method: string, params: unknown) => parseClientMessage({ id: 1, method, params })

const workNames = ['lead/work/list', 'lead/work/read', 'lead/work/note', 'lead/work/close']
const presenceNames = ['lead/presence/read', 'lead/presence/dismiss', 'lead/brief/read', 'lead/brief/update']
const autonomyNames = ['lead/autonomy/read', 'lead/autonomy/set', 'lead/rules/read', 'lead/rules/update', 'lead/deadline/set']

test('the closed Lead window controls validate and none is on the client surface', () => {
  assert.deepEqual(knownMethods.filter(name => name.startsWith('lead/')).sort(), [...names, ...chatNames, 'lead/desk/summary', 'lead/usage/summary', ...workNames, ...presenceNames, ...autonomyNames, 'lead/memory/propose', 'lead/memory/search', 'lead/context/use', 'lead/inbox/read', 'lead/reminder/set', 'lead/reminder/cancel', 'lead/reminder/clear', 'lead/autonomy/propose', 'lead/rules/propose', 'lead/settings/decide'].sort())
  for (const name of names) assert.equal(Object.hasOwn(CLIENT_METHODS, name), false)
  // The Lead's own two memory methods are the only memory methods its client may call.
  for (const name of ['lead/memory/propose', 'lead/memory/search']) assert.equal(Object.hasOwn(CLIENT_METHODS, name), true)
  // The Lead reads its own context use; it never summarises or reads the summaries' words through its client.
  assert.equal(CLIENT_METHODS['lead/context/use' as keyof typeof CLIENT_METHODS], 'read')
  assert.equal(Object.hasOwn(CLIENT_METHODS, 'lead/context/read'), false)
  // A reminder the person asked for is an entry on the work board: the Lead sets and cancels it at the read tier.
  for (const name of ['lead/reminder/set', 'lead/reminder/cancel']) assert.equal(CLIENT_METHODS[name as keyof typeof CLIENT_METHODS], 'read')
  assert.doesNotThrow(() => request('lead/reminder/set', { text: 'Send the notes', inMinutes: 30 }))
  assert.doesNotThrow(() => request('lead/reminder/cancel', { id: 'remind-2' }))
  assert.throws(() => request('lead/reminder/set', { text: 'Send the notes' }))
  assert.throws(() => request('lead/reminder/cancel', { id: 'work-2' }))
  // #2144: clearing a fired or cancelled reminder is the person's, from the window or the phone, never the Lead's.
  assert.equal(Object.hasOwn(CLIENT_METHODS, 'lead/reminder/clear'), false)
  assert.doesNotThrow(() => request('lead/reminder/clear', { id: 'remind-2' }))
  assert.throws(() => request('lead/reminder/clear', { id: 'work-2' }))
  // #2106: the Lead proposes its own settings at the read tier; the person's decision is never on its door.
  for (const name of ['lead/autonomy/propose', 'lead/rules/propose']) assert.equal(CLIENT_METHODS[name as keyof typeof CLIENT_METHODS], 'read')
  assert.equal(Object.hasOwn(CLIENT_METHODS, 'lead/settings/decide'), false)
  assert.doesNotThrow(() => request('lead/autonomy/propose', { kind: 'desk-change', mode: 'observe' }))
  assert.doesNotThrow(() => request('lead/rules/propose', { section: 'talk', add: 'Report in Chinese, conclusion first.' }))
  assert.throws(() => request('lead/rules/propose', { section: 'talk', add: 'One line.', text: 'And whole words.' }))
  assert.throws(() => request('lead/rules/propose', { section: 'talk' }))
  assert.doesNotThrow(() => request('lead/settings/decide', { id: 's2', decision: 'apply' }))
  assert.throws(() => request('lead/settings/decide', { id: 'c2', decision: 'apply' }))
  // The person's inbox is the window's and the phone's read; the Lead never reads it through its client.
  assert.equal(Object.hasOwn(CLIENT_METHODS, 'lead/inbox/read'), false)
  assert.doesNotThrow(() => request('lead/inbox/read', {}))
  for (const name of ['lead/wakes/read', 'lead/thread/read', 'lead/settings/read']) assert.doesNotThrow(() => request(name, {}))
  assert.doesNotThrow(() => request('lead/thread/send', { idempotencyKey: 'send-1', text: 'Inspect the check' }))
  assert.doesNotThrow(() => request('lead/resume', { expectedRevision: 0 }))
  assert.doesNotThrow(() => request('lead/stop', { expectedRevision: 0 }))
  assert.doesNotThrow(() => request('lead/settings/update', { expectedRevision: 0, credential: { provider: 'anthropic', key: 'sk-test-not-real-0000' } }))
  assert.doesNotThrow(() => request('lead/card/decide', { version: 1, cardId: 'result', cardType: 'result', expectedRevision: 1, contractDigest: 'a'.repeat(64), choice: 'accept-open-pr' }))
  assert.doesNotThrow(() => request('lead/settings/update', { expectedRevision: 1, follow: { checks: false, reviews: true } }))
  assert.doesNotThrow(() => request('lead/card/decide', { version: 1, cardId: 'plan', cardType: 'plan', expectedRevision: 1, contractDigest: 'a'.repeat(64), choice: 'approve' }))
})

test('Lead controls reject open shapes, invalid fences and unbounded secret/text input', () => {
  const bad: [string, unknown][] = [
    ['lead/thread/read', { key: 'sk-test-not-real-0000' }],
    ['lead/thread/send', { text: 'missing receipt' }],
    ['lead/thread/send', { idempotencyKey: '', text: 'hello' }],
    ['lead/thread/send', { idempotencyKey: 'send', text: 'x'.repeat(16385) }],
    ['lead/stop', { expectedRevision: -1 }], ['lead/stop', { expectedRevision: 1, merge: true }],
    ['lead/resume', { expectedRevision: -1 }], ['lead/resume', { expectedRevision: 1, answer: true }],
    ['lead/settings/update', { expectedRevision: 1, credential: { provider: 'other', key: 'secret' } }],
    ['lead/settings/update', { expectedRevision: 1, credential: { provider: 'anthropic', key: 'x'.repeat(4097) } }],
    ['lead/card/decide', { version: 1, cardId: 'worker', cardType: 'waiting', expectedRevision: 1, choice: 'accept' }],
  ]
  for (const [method, params] of bad) assert.throws(() => request(method, params), { name: 'ValidationError' }, method)
})


test('lead/spendLimit/set takes a whole positive amount below the ceiling (which reads as Off), or null for Off, and nothing else', () => {
  const max = LEAD_LIMITS.maxUsdMicros
  for (const usdMicros of [null, 1, 2_500_000, max - 1]) assert.doesNotThrow(() => request('lead/spendLimit/set', { usdMicros, expectedRevision: 3 }), String(usdMicros))
  for (const params of [{ usdMicros: 0, expectedRevision: 1 }, { usdMicros: -1, expectedRevision: 1 }, { usdMicros: 1.5, expectedRevision: 1 },
    { usdMicros: max, expectedRevision: 1 }, { usdMicros: max + 1, expectedRevision: 1 }, { usdMicros: '1000000', expectedRevision: 1 }, { usdMicros: 1_000_000 }, { expectedRevision: 1 },
    { usdMicros: 1_000_000, expectedRevision: -1 }, { usdMicros: 1_000_000, expectedRevision: 1, rounds: 4 },
    { usdMicros: 1_000_000, expectedRevision: 1, policy: { mode: 'ask' } }])
    assert.throws(() => request('lead/spendLimit/set', params), { name: 'ValidationError' }, JSON.stringify(params))
  // The settings read carries the setting; absent stays legal for a desk that has not recorded one yet.
  assert.equal(Object.hasOwn(CLIENT_METHODS, 'lead/spendLimit/set'), false)
})

test('credential provider validation never echoes a key-shaped value', () => {
  const secret = 'sk-ant-test-not-real-0000' // hd-secrets-ok: synthetic provider credential
  assert.throws(() => request('lead/settings/update', { expectedRevision: 0, credential: { provider: secret, key: null } }), (error: any) =>
    error.name === 'ValidationError' && !String(error).includes(secret))
})


test('Lead ordinary chat operations have bounded closed inputs and narrow client tiers', () => {
  for (const [method, params] of [
    ['lead/chat/list', {}], ['lead/chat/list', { limit: 50, cursor: 'opaque' }],
    ['lead/chat/read', { id: 'agent:session' }], ['lead/chat/start', { text: 'Do the task' }],
    ['lead/chat/send', { id: 'agent:session', text: 'Continue' }], ['lead/chat/stop', { id: 'agent:session' }],
  ] as const) assert.doesNotThrow(() => request(method, params))
  for (const name of chatNames) assert.equal(CLIENT_METHODS[name as keyof typeof CLIENT_METHODS], name.endsWith('/list') || name.endsWith('/read') ? 'read' : 'run')
  for (const [method, params] of [
    ['lead/chat/list', { limit: 0 }], ['lead/chat/list', { limit: 51 }], ['lead/chat/list', { limit: 1.5 }],
    ['lead/chat/read', { id: 'x'.repeat(301) }], ['lead/chat/start', { text: 'x'.repeat(16385) }],
    ['lead/chat/send', { id: 'agent:session', text: 'Continue', permissions: 'bypass' }],
    ['lead/chat/stop', { id: 'agent:session', approve: true }], ['lead/chat/list', { root: '/foreign' }],
  ] as const) assert.throws(() => request(method, params), { name: 'ValidationError' })
})

test('repeat controls and direct allowance raises are person-only closed inputs', () => {
  for (const action of ['pause', 'resume', 'stop', 'run-now']) assert.doesNotThrow(() => request('lead/repeat/control', { taskId: 'repeat-1', action }))
  assert.doesNotThrow(() => request('lead/budget/raise', { logicalGoalId: 'goal-1', caps: { usdMicros: 6_000_000, rounds: 3 }, expectedRevision: 1 }))
  for (const [method, params] of [['lead/repeat/control', { taskId: 'repeat-1', action: 'approve' }], ['lead/budget/raise', { logicalGoalId: 'goal-1', caps: { usdMicros: -1, rounds: 3 }, expectedRevision: 1 }]]) assert.throws(() => request(method as string, params))
})

test('goal approval decisions and revocation have closed person wire shapes', () => {
  assert.doesNotThrow(() => request('lead/action/perform', { id: 'worker', contractDigest: 'a'.repeat(64), choice: 'yes-goal' }))
  assert.doesNotThrow(() => request('lead/approval/revoke', { id: 'rule', contractDigest: 'a'.repeat(64) }))
  for (const params of [{ id: 'rule' }, { id: 'rule', contractDigest: 'a'.repeat(64), source: 'worker' }]) assert.throws(() => request('lead/approval/revoke', params))
})

test('chat start admits one to three unique opaque person message ids', () => {
  assert.doesNotThrow(() => request('lead/chat/start', { text: 'Brief', quote: ['message-1', 'message-2'] }))
  for (const quote of [[], ['one', 'two', 'three', 'four'], ['one', 'one'], ['bad\nid'], [''], ['x'.repeat(257)], [4]])
    assert.throws(() => request('lead/chat/start', { text: 'Brief', quote }))
})

test('Lead chat start admits only bounded agent and moveFrom selectors', () => {
  assert.doesNotThrow(() => request('lead/chat/start', { text: 'Brief', agent: 'Agent Two', moveFrom: 'fixture:old' }))
  for (const field of ['agent', 'moveFrom']) for (const value of ['', 'x'.repeat(301), 4])
    assert.throws(() => request('lead/chat/start', { text: 'Brief', [field]: value }))
})


test('chat send can request a provider-reset wait and rejects every other retry selector', () => {
  assert.doesNotThrow(() => request('lead/chat/send', { id: 'fixture:chat', text: 'Continue', retryAt: 'reset' }))
  for (const retryAt of ['now', '', 1, {}]) assert.throws(() => request('lead/chat/send', { id: 'fixture:chat', text: 'Continue', retryAt }))
})


test('desk summary accepts only a bounded whole recent limit', () => {
  assert.doesNotThrow(() => request('lead/desk/summary', {}))
  assert.doesNotThrow(() => request('lead/desk/summary', { limit: 20 }))
  for (const limit of [0, -1, 21, 1.5, '8', null])
    assert.throws(() => request('lead/desk/summary', { limit }), { name: 'ValidationError' })
  assert.throws(() => request('lead/desk/summary', { root: '/workspace/other' }), { name: 'ValidationError' })
})

test('allowance summary accepts only empty params', () => {
  assert.doesNotThrow(() => request('lead/usage/summary', {}))
  assert.throws(() => request('lead/usage/summary', { refresh: true }), { name: 'ValidationError' })
})

test('the work ledger methods take bounded shapes: notes never carry a stage, and only the person closes', () => {
  // The Lead reads and annotates its ledger through the client door; closing is the person's alone.
  assert.equal(CLIENT_METHODS['lead/work/note' as keyof typeof CLIENT_METHODS], 'read')
  assert.equal(Object.hasOwn(CLIENT_METHODS, 'lead/work/close'), false)
  assert.doesNotThrow(() => request('lead/work/list', {}))
  assert.doesNotThrow(() => request('lead/work/list', { state: 'all' }))
  assert.doesNotThrow(() => request('lead/work/read', { id: 'work-3' }))
  assert.doesNotThrow(() => request('lead/work/note', { id: 'work-3', note: 'Waiting on the review', remindAt: 1_800_000_000_000 }))
  assert.doesNotThrow(() => request('lead/work/note', { id: 'work-3', after: null, remindAt: null }))
  assert.doesNotThrow(() => request('lead/work/close', { id: 'work-3', outcome: 'dropped' }))
  assert.doesNotThrow(() => request('lead/chat/start', { text: 'Fix the docs', ledgerItem: 'work-3' }))
  const bad: [string, unknown][] = [
    ['lead/work/list', { state: 'closed' }],
    ['lead/work/read', { id: '3' }],
    ['lead/work/note', { id: 'work-3' }],
    ['lead/work/note', { id: 'work-3', stage: 'done' }],
    ['lead/work/note', { id: 'work-3', note: 'x'.repeat(301) }],
    ['lead/work/note', { id: 'work-3', after: 'work-3' }],
    ['lead/work/note', { id: 'work-3', remindAt: -1 }],
    ['lead/work/close', { id: 'work-3', outcome: 'merged' }],
    ['lead/chat/start', { text: 'Fix the docs', ledgerItem: 'anything' }],
  ]
  for (const [method, params] of bad) assert.throws(() => request(method, params), { name: 'ValidationError' }, `${method} ${JSON.stringify(params)}`)
})

test('the context methods take nothing, and a checkpoint marker rides only on a host notice', async () => {
  const { parseLeadMessage, parseLeadContextFacts, parseLeadWakeRecord } = await import('../src/index.js')
  for (const name of ['lead/context/read', 'lead/context/compact']) {
    assert.doesNotThrow(() => request(name, {}))
    assert.throws(() => request(name, { id: 'x' }), { name: 'ValidationError' })
  }
  const notice = { version: 1, id: 'context-checkpoint-c1', revision: 4, role: 'notice', text: 'Earlier conversation summarised', checkpoint: { id: 'c1' } }
  assert.deepEqual(parseLeadMessage(notice).checkpoint, { id: 'c1' })
  assert.deepEqual(parseLeadMessage({ ...notice, checkpoint: { id: 'c1', fallback: true } }).checkpoint, { id: 'c1', fallback: true })
  assert.equal(Object.hasOwn(parseLeadMessage({ ...notice, checkpoint: undefined }), 'checkpoint'), false)
  assert.throws(() => parseLeadMessage({ ...notice, role: 'assistant' }))
  assert.throws(() => parseLeadMessage({ ...notice, checkpoint: { id: 'c1', fallback: false } }))
  assert.throws(() => parseLeadMessage({ ...notice, checkpoint: { id: 'c1', text: 'smuggled' } }))
  const wake = { id: 'w', at: 1, source: 'person', decision: 'spoke', modelTurn: true, usdMicros: 3 }
  assert.equal(Object.hasOwn(parseLeadWakeRecord(wake), 'tokens'), false)
  assert.deepEqual(parseLeadWakeRecord({ ...wake, tokens: { input: 10, output: 5, cacheRead: 900, cacheWrite: 90 } }).tokens, { input: 10, output: 5, cacheRead: 900, cacheWrite: 90 })
  assert.throws(() => parseLeadWakeRecord({ ...wake, tokens: { input: -1, output: 0, cacheRead: 0, cacheWrite: 0 } }))
  const facts = { version: 1, windowTokens: 200_000, usedTokens: 50_000, cacheHitRate: 0.8, compacting: false,
    checkpoints: [{ id: 'c1', at: 5, fallback: false, beforeTokens: 170_000, afterTokens: 30_000, text: 'What the person wants' }] }
  assert.deepEqual(parseLeadContextFacts(facts), facts)
  assert.throws(() => parseLeadContextFacts({ ...facts, cacheHitRate: 1.5 }))
  assert.throws(() => parseLeadContextFacts({ ...facts, checkpoints: Array.from({ length: 9 }, (_, i) => ({ ...facts.checkpoints[0], id: `c${i}` })) }))
  // The person's section rides as data beside the text, and only as data.
  const person = { messages: [{ id: 'm-1', text: 'Fix the sign-in page' }], leftOut: ['m-0'] }
  const withPerson = { ...facts, checkpoints: [{ ...facts.checkpoints[0], person }] }
  assert.deepEqual(parseLeadContextFacts(withPerson), withPerson)
  assert.equal(Object.hasOwn(parseLeadContextFacts(facts).checkpoints[0]!, 'person'), false)
  assert.throws(() => parseLeadContextFacts({ ...facts, checkpoints: [{ ...facts.checkpoints[0], person: { ...person, messages: [{ id: 'm 1', text: 'x' }] } }] }))
  assert.throws(() => parseLeadContextFacts({ ...facts, checkpoints: [{ ...facts.checkpoints[0], person: { ...person, messages: [{ id: 'm-1', text: 'x'.repeat(601) }] } }] }))
  assert.throws(() => parseLeadContextFacts({ ...facts, checkpoints: [{ ...facts.checkpoints[0], person: { ...person, extra: true } }] }))
})

test('presence requests name a device, a digest and a brief time, and nothing else', () => {
  const device = { id: 'window:main', label: 'Desktop' }
  assert.doesNotThrow(() => request('lead/presence/read', { device, active: true }))
  assert.doesNotThrow(() => request('lead/presence/read', { device: { id: 'phone:abc-1', label: 'Jane’s iPhone' }, recap: true }))
  assert.doesNotThrow(() => request('lead/presence/dismiss', { device, digest: 'away-1-2' }))
  assert.doesNotThrow(() => request('lead/brief/read', {}))
  assert.doesNotThrow(() => request('lead/brief/update', { enabled: true, at: '07:30' }))
  for (const [method, params] of [
    ['lead/presence/read', { active: true }], ['lead/presence/read', { device: { id: 'tablet:x', label: 'x' } }],
    ['lead/presence/read', { device, extra: 1 }], ['lead/presence/dismiss', { device }], ['lead/brief/update', {}],
    ['lead/brief/update', { at: '7:30' }], ['lead/brief/update', { at: '24:00' }], ['lead/brief/read', { x: 1 }],
  ] as const) assert.throws(() => request(method, params))
})

test('an ask may carry an expiry in minutes, and a send may name its device', () => {
  const ask = { question: 'Start it?', options: [{ id: 'start', label: 'Start it' }, { id: 'later', label: 'Not now' }], recommended: 'start' }
  assert.doesNotThrow(() => parseLeadAsk({ ...ask, expiresInMinutes: 30 }))
  for (const bad of [0, 4, 10_081, 1.5, '30']) assert.throws(() => parseLeadAsk({ ...ask, expiresInMinutes: bad }))
  assert.throws(() => parseLeadAsk({ ...ask, expiresAt: 5 }))
  assert.deepEqual(parseLeadThreadSend({ idempotencyKey: 'k', text: 'Start it', device: { id: 'phone:p1', label: 'iPhone' } }).device, { id: 'phone:p1', label: 'iPhone' })
  assert.equal(parseLeadThreadSend({ idempotencyKey: 'k', text: 'hi' }).device, undefined)
})

test('#2145: an ask option that starts a chat says so with starts: true, and nothing else', () => {
  const options = [{ id: 'start', label: 'Start it', starts: true }, { id: 'read', label: 'Only read why it failed' }]
  const parsed = parseLeadAsk({ question: 'Try it again?', options, recommended: 'read' })
  assert.deepEqual(parsed.options, options)
  assert.equal(Object.hasOwn(parsed.options[1]!, 'starts'), false, 'an option without the flag starts nothing')
  for (const starts of [false, 'yes', 1]) assert.throws(() => parseLeadAsk({ question: 'Try it again?', options: [{ id: 'start', label: 'Start it', starts }, options[1]], recommended: 'read' }))
})

test('autonomy and rules take closed shapes: a kind with a mode, a section with a version, a deadline in whole milliseconds, and nothing else', () => {
  for (const name of autonomyNames) assert.equal(Object.hasOwn(CLIENT_METHODS, name), false, name)
  for (const name of ['lead/autonomy/read', 'lead/rules/read']) { assert.doesNotThrow(() => request(name, {})); assert.throws(() => request(name, { kind: 'brief' }), { name: 'ValidationError' }) }
  for (const kind of ['desk-change', 'stuck', 'repeat', 'mention', 'brief']) for (const mode of ['off', 'observe', 'act'])
    assert.doesNotThrow(() => request('lead/autonomy/set', { kind, mode }), `${kind} ${mode}`)
  for (const params of [{ kind: 'merge', mode: 'act' }, { kind: 'brief', mode: 'always' }, { kind: 'brief' }, { mode: 'act' }, { kind: 'brief', mode: 'act', extra: 1 }])
    assert.throws(() => request('lead/autonomy/set', params), { name: 'ValidationError' }, JSON.stringify(params))
  assert.doesNotThrow(() => request('lead/rules/update', { section: 'talk', action: 'edit', text: 'Be brief.', expectedVersion: 0 }))
  assert.doesNotThrow(() => request('lead/rules/update', { section: 'done', action: 'rollback', to: 1, expectedVersion: 2 }))
  assert.doesNotThrow(() => request('lead/rules/update', { section: 'delegate', action: 'reset', expectedVersion: 1 }))
  for (const params of [{ section: 'money', action: 'reset', expectedVersion: 0 }, { section: 'talk', action: 'edit', expectedVersion: 0 }, { section: 'talk', action: 'edit', text: 'x'.repeat(3001), expectedVersion: 0 },
    { section: 'talk', action: 'rollback', expectedVersion: 1 }, { section: 'talk', action: 'reset' }, { section: 'talk', action: 'reset', expectedVersion: -1 }])
    assert.throws(() => request('lead/rules/update', params), { name: 'ValidationError' }, JSON.stringify(params))
  assert.doesNotThrow(() => request('lead/deadline/set', { logicalGoalId: 'goal-1', deadlineAt: 1_800_000_000_000 }))
  assert.doesNotThrow(() => request('lead/deadline/set', { logicalGoalId: 'goal-1', deadlineAt: null }))
  for (const params of [{ logicalGoalId: 'goal-1', deadlineAt: 1.5 }, { logicalGoalId: 'goal-1' }, { deadlineAt: 5 }, { logicalGoalId: 'goal-1', deadlineAt: -1 }])
    assert.throws(() => request('lead/deadline/set', params), { name: 'ValidationError' }, JSON.stringify(params))
})

test('context use is one figure: percent of the window, tokens, and when the conversation was last summarised', () => {
  const facts = { version: 1 as const, windowTokens: 200_000, usedTokens: 73_622, cacheHitRate: 0.9, compacting: false,
    checkpoints: [{ id: 'c1', at: 1_000, fallback: false, beforeTokens: 150_000, afterTokens: 20_000, text: 'Earlier summary words' },
      { id: 'c2', at: 2_000, fallback: false, beforeTokens: 150_000, afterTokens: 20_000, text: 'Later summary words' }] }
  const use = leadContextUse(facts as never)
  assert.deepEqual(use, { version: 1, windowTokens: 200_000, usedTokens: 73_622, percent: 37, lastSummaryAt: 2_000, compacting: false })
  assert.ok(!JSON.stringify(use).includes('summary words'), 'no summary text: a figure, not the conversation')
  assert.deepEqual(leadContextUse({ ...facts, usedTokens: null, checkpoints: [] } as never), { version: 1, windowTokens: 200_000, usedTokens: null, percent: null, lastSummaryAt: null, compacting: false })
  assert.equal(leadContextUse({ ...facts, full: true } as never).full, true)
  assert.doesNotThrow(() => request('lead/context/use', {}))
  assert.throws(() => request('lead/context/use', { more: 1 }))
})
