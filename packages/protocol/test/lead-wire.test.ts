import assert from 'node:assert/strict'
import test from 'node:test'
import { CLIENT_METHODS, LEAD_LIMITS, knownMethods, parseClientMessage, parseLeadAsk, parseLeadThreadSend } from '../src/index.js'

const names = ['lead/chats/resetControl', 'lead/chats/control', 'lead/chat/takeOver', 'lead/chat/handBack', 'lead/approval/revoke', 'lead/repeat/control', 'lead/budget/raise', 'lead/spendLimit/set', 'lead/wakes/read', 'lead/thread/read', 'lead/thread/send', 'lead/card/decide', 'lead/settings/read', 'lead/settings/update', 'lead/resume', 'lead/stop', 'lead/action/perform', 'lead/steer', 'lead/memory/read', 'lead/memory/update', 'lead/memory/view', 'lead/memory/change', 'lead/schedule/read', 'lead/schedule/update', 'lead/context/read', 'lead/context/compact']
const chatNames = ['lead/chat/list', 'lead/chat/read', 'lead/chat/start', 'lead/chat/send', 'lead/chat/stop']
const request = (method: string, params: unknown) => parseClientMessage({ id: 1, method, params })

const workNames = ['lead/work/list', 'lead/work/read', 'lead/work/note', 'lead/work/close']
const presenceNames = ['lead/presence/read', 'lead/presence/dismiss', 'lead/brief/read', 'lead/brief/update']

test('the closed Lead window controls validate and none is on the client surface', () => {
  assert.deepEqual(knownMethods.filter(name => name.startsWith('lead/')).sort(), [...names, ...chatNames, 'lead/desk/summary', 'lead/usage/summary', ...workNames, ...presenceNames, 'lead/memory/propose', 'lead/memory/search'].sort())
  for (const name of names) assert.equal(Object.hasOwn(CLIENT_METHODS, name), false)
  // The Lead's own two memory methods are the only memory methods its client may call.
  for (const name of ['lead/memory/propose', 'lead/memory/search']) assert.equal(Object.hasOwn(CLIENT_METHODS, name), true)
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
