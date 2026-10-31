import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as protocol from '../src/index.js'

// Look up the boundary parsers so the red run reports the missing contract.
const validator = (name: string): ((value: unknown) => unknown) => {
  const parse = (protocol as Record<string, unknown>)[name]
  assert.equal(typeof parse, 'function', `${name} must be exported`)
  return parse as (value: unknown) => unknown
}
test('name-only settings receipts carry only the closed name and journal revision', () => {
  const parse = validator('parseLeadNameReceipt')
  const receipt = { version: 1, revision: 3, settings: { name: 'lex' } }
  assert.deepEqual(parse(receipt), receipt)
  for (const value of [{ ...receipt, settings: { name: 'other' } }, { ...receipt, settings: { name: 'lex', key: 'untrusted' } }, { ...receipt, revision: -1 }, { ...receipt, thread: {} }])
    assert.throws(() => parse(value), protocol.ValidationError)
})
const digest = 'a'.repeat(64)
const caps = { usdMicros: 5_000_000, rounds: 3 }
const policy = { version: 1, revision: 0, mode: 'default', rules: [] }
const contract = {
  version: 1, revision: 1, digest, goal: 'Repair the failing check',
  project: { id: 'project-demo', path: '/workspace/demo' }, policyRevision: 0,
  steps: [{ id: 'implement', title: 'Implement and review', flow: 'lead-reviewed-result', sourceRevision: 'source-1',
    variables: { task: 'Repair the check' }, attendance: 'attended',
    assignments: [{ role: 'implement', agent: 'builder', seat: { runtime: 'fixture', model: 'model-demo' }, ceiling: 'edit' }] }],
  assertions: [{ id: 'tests', kind: 'check', description: 'Required checks pass' }], caps,
}
const budget = { version: 1, revision: 1, caps, leadUsdMicros: 20, workerUsdMicros: 50,
  reservedUsdMicros: 100, roundsAdmitted: 1, spend: 'known', stop: null }
const result = { assertionId: 'tests', status: 'unknown', revision: 2, contractRevision: 1,
  evidence: [{ kind: 'check', id: 'check-1', revision: 'source-1' }], reason: 'Check still running' }
const base = { version: 1, id: 'card-1', revision: 1, contractDigest: digest }
const cards = [
  { ...base, type: 'plan', contract },
  { ...base, type: 'permission-change', previous: policy, proposed: { ...policy, revision: 1, mode: 'manage' } },
  { ...base, type: 'waiting', kind: 'person', runId: 'run-1', personCardId: 'person-1', summary: 'Review the result', assertions: [result] },
  { ...base, type: 'result', outcome: 'reviewed', summary: 'Ready for acceptance', assertions: [result], budget },
  { ...base, type: 'stopped', reason: 'budget', summary: 'Reported spend reached the cap', budget },
].map((card, index) => ({ ...card, id: `card-${index + 1}` }))
const thread = { cardPositions: undefined, contract: undefined, budget: undefined, decisions: undefined, version: 1, id: 'thread-1', revision: 2, state: 'awaiting-plan', project: contract.project,
  olderMessages: 0, messages: [{ version: 1, id: 'message-1', revision: 1, role: 'user', text: 'Repair the check' }], cards }
const settings = { follow: { checks: true, reviews: true }, version: 1, name: 'dex', model: 'model-demo', key: { configured: true, protection: 'encrypted' }, policy, caps }

test('Lead assignments round-trip structured Flow seats including slash model ids and optional effort', () => {
  for (const seat of [
    { runtime: 'fixture', model: 'vendor/model-1', effort: 'high' },
    { runtime: 'fixture', model: 'vendor/model-1' },
    { runtime: 'fixture', model: 'vendor/model-1', effort: 'high', thinking: true },
  ]) {
    const seated = { ...contract, steps: [{ ...contract.steps[0], assignments: [{ ...contract.steps[0]!.assignments[0], seat }] }] }
    assert.deepEqual(validator('parseLeadAcceptanceContract')(seated), seated)
  }
  for (const seat of ['fixture=model/high', { model: 'vendor/model-1' }, { runtime: ' ' },
    { runtime: 'fixture', model: 'bad\nmodel' }, { runtime: 'fixture', thinking: 'yes' }])
    assert.throws(() => validator('parseLeadAcceptanceContract')({ ...contract, steps: [{ ...contract.steps[0], assignments: [{ ...contract.steps[0]!.assignments[0], seat }] }] }), protocol.ValidationError)
})

test('Lead opaque host fields preserve their bounded string shape', () => {
  const candidate = { ...contract, project: { ...contract.project, id: 'acme.dev/demo+tools' },
    steps: [{ ...contract.steps[0], flow: 'Reviewed work+checks', sourceRevision: 'sha256=ab+/c==' }] }
  const parsed = protocol.parseLeadAcceptanceContract(candidate)
  assert.deepEqual(parsed, candidate)
  assert.deepEqual(validator('parseLeadSettingsProjection')({ ...settings, model: 'provider model+variant' }), { ...settings, model: 'provider model+variant' })
  for (const sourceRevision of ['bad\nrevision', 'x'.repeat(257)])
    assert.throws(() => validator('parseLeadAcceptanceContract')({ ...contract, steps: [{ ...contract.steps[0], sourceRevision }] }), protocol.ValidationError)
})

test('Lead stopped cards can describe planning failures before any contract exists', () => {
  const stopped = { ...cards[4]!, contractDigest: null, reason: 'error', summary: 'Planning could not start' }
  assert.deepEqual(validator('parseLeadCard')(stopped), stopped)
})

test('Lead text rejects lone surrogates and preserves well-formed Unicode', () => {
  for (const text of ['before\ud800', '\udfffafter'])
    assert.throws(() => validator('parseLeadThread')({ ...thread, messages: [{ ...thread.messages[0], text }] }), protocol.ValidationError)
  const candidate = { ...thread, messages: [{ ...thread.messages[0], text: 'Review 🐈\nRésumé' }] }
  assert.deepEqual(validator('parseLeadThread')(candidate), candidate)
})

test('Lead collections validate holes at every position, including inherited indices', () => {
  const parse = validator('parseLeadAcceptanceContract')
  const inherited = Array(1)
  const prototype = Object.create(Array.prototype)
  prototype[0] = contract.steps[0]
  Object.setPrototypeOf(inherited, prototype)
  for (const steps of [Array(1), [contract.steps[0], ,], inherited])
    assert.throws(() => parse({ ...contract, steps }), protocol.ValidationError)
  assert.throws(() => parse({ ...contract, assertions: Array(1) }), protocol.ValidationError)
  assert.throws(() => parse({ ...contract, steps: [{ ...contract.steps[0], assignments: Array(1) }] }), protocol.ValidationError)
  assert.throws(() => validator('parseLeadPermissionPolicy')({ ...policy, rules: Array(1) }), protocol.ValidationError)
  assert.throws(() => validator('parseLeadAssertionResult')({ ...result, evidence: Array(1) }), protocol.ValidationError)
  for (const field of ['messages', 'cards']) {
    assert.throws(() => validator('parseLeadThread')({ ...thread, [field]: Array(1) }), protocol.ValidationError)
  }
})

test('Lead steps, assertions, rules and assignment roles have unique identities', () => {
  const parse = validator('parseLeadAcceptanceContract')
  assert.throws(() => parse({ ...contract, steps: [contract.steps[0], { ...contract.steps[0], title: 'Different work' }] }), protocol.ValidationError)
  assert.throws(() => parse({ ...contract, assertions: [contract.assertions[0], { ...contract.assertions[0], kind: 'review' }] }), protocol.ValidationError)
  assert.throws(() => parse({ ...contract, steps: [{ ...contract.steps[0], assignments: [contract.steps[0]!.assignments[0], { ...contract.steps[0]!.assignments[0], agent: 'reviewer' }] }] }), protocol.ValidationError)
  const rule = { id: 'rule-1', effect: 'allow', method: 'flow/preview', action: null, project: null }
  assert.throws(() => validator('parseLeadPermissionPolicy')({ ...policy, rules: [rule, { ...rule, effect: 'deny' }] }), protocol.ValidationError)
  assert.doesNotThrow(() => parse({ ...contract, steps: [contract.steps[0], { ...contract.steps[0], id: 'review' }] }))
})

test('Lead identifiers, prose, project paths and variable keys are confined', () => {
  const parse = validator('parseLeadAcceptanceContract')
  for (const id of ['a\nb', '../x\u0007', 'space here', 'x\\y', 'x?y'])
    assert.throws(() => parse({ ...contract, steps: [{ ...contract.steps[0], id }] }), protocol.ValidationError)
  for (const goal of ['task\u0007', 'task\u007f', 'task\u0085'])
    assert.throws(() => parse({ ...contract, goal }), protocol.ValidationError)
  for (const path of ['relative/path', 'rel/../..', '/workspace/../other', '/workspace/..', 'C:\\workspace\\..\\other', '/workspace/\u0007'])
    assert.throws(() => parse({ ...contract, project: { ...contract.project, path } }), protocol.ValidationError)
  for (const path of ['/workspace/demo', 'C:\\workspace\\demo', '\\\\server\\share\\demo'])
    assert.doesNotThrow(() => parse({ ...contract, project: { ...contract.project, path } }))
  assert.throws(() => parse({ ...contract, steps: [{ ...contract.steps[0], variables: JSON.parse('{"__proto__":"poison"}') }] }), protocol.ValidationError)
  assert.throws(() => parse({ ...contract, steps: [{ ...contract.steps[0], variables: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`key-${i}`, 'value'])) }] }), protocol.ValidationError)
})

test('Lead caps reject non-finite, fractional, unsafe and out-of-range values', () => {
  const parse = validator('parseLeadCaps')
  assert.deepEqual(parse(caps), caps)
  assert.deepEqual(parse({ usdMicros: 0, rounds: 1 }), { usdMicros: 0, rounds: 1 })
  for (const usdMicros of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, '5'])
    assert.throws(() => parse({ ...caps, usdMicros }), protocol.ValidationError)
  for (const rounds of [NaN, Infinity, -1, 0, 1.5, 101, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => parse({ ...caps, rounds }), protocol.ValidationError)
})

test('Lead card decisions require a version, current revision and contract digest', () => {
  const parse = validator('parseLeadCardDecision')
  const decision = { version: 1, cardType: 'plan', cardId: 'card-1', expectedRevision: 1, contractDigest: digest, choice: 'approve' }
  assert.deepEqual(parse(decision), decision)
  for (const patch of [{ version: undefined }, { version: 2 }, { expectedRevision: -1 },
    { expectedRevision: Number.MAX_SAFE_INTEGER + 1 }, { cardId: '' }, { contractDigest: '' },
    { contractDigest: 'not-a-digest' }, { choice: 'run' }, { apiKey: 'synthetic-secret' }])
    assert.throws(() => parse({ ...decision, ...patch }), protocol.ValidationError)
})

test('Lead acceptance contracts bind the ordered work, project, evidence and caps', () => {
  const parse = validator('parseLeadAcceptanceContract')
  assert.deepEqual(parse(contract), contract)
  for (const patch of [{ version: 2 }, { revision: Infinity }, { goal: '' }, { goal: 'x'.repeat(16_385) },
    { steps: [] }, { steps: Array(65).fill(contract.steps[0]) }, { assertions: Array(129).fill(contract.assertions[0]) },
    { project: { id: 'project-demo', path: '' } }, { caps: { ...caps, rounds: 0 } }])
    assert.throws(() => parse({ ...contract, ...patch }), protocol.ValidationError)
  assert.throws(() => parse({ ...contract, steps: [{ ...contract.steps[0], variables: { task: 'x'.repeat(16_385) } }] }), protocol.ValidationError)
  assert.throws(() => parse({ ...contract, steps: [{ ...contract.steps[0], assignments: [{ ...contract.steps[0]!.assignments[0], ceiling: 'root' }] }] }), protocol.ValidationError)
})

test('Lead assertion results preserve all four statuses and revision-qualified evidence', () => {
  const parse = validator('parseLeadAssertionResult')
  for (const status of ['pending', 'passed', 'failed', 'unknown'])
    assert.deepEqual(parse({ ...result, status }), { ...result, status })
  for (const patch of [{ status: 'success' }, { revision: -1 }, { contractRevision: 0.5 },
    { evidence: [{ kind: 'check', id: 'check-1' }] }, { evidence: Array(129).fill(result.evidence[0]) }])
    assert.throws(() => parse({ ...result, ...patch }), protocol.ValidationError)
})

test('Lead cards validate their branch and approval binding', () => {
  const parse = validator('parseLeadCard')
  for (const card of cards) {
    assert.deepEqual(parse(card), card)
    assert.throws(() => parse({ ...card, version: 2 }), protocol.ValidationError)
  }
  assert.throws(() => parse({ ...cards[0], contractDigest: 'b'.repeat(64) }), protocol.ValidationError)
  assert.throws(() => parse({ ...base, type: 'worker-approval', approval: 'approval-1' }), protocol.ValidationError)
})

test('Lead policies and budget projections reject malformed numeric and authority fields', () => {
  const parsePolicy = validator('parseLeadPermissionPolicy')
  assert.deepEqual(parsePolicy(policy), policy)
  assert.throws(() => parsePolicy({ ...policy, mode: 'unrestricted' }), protocol.ValidationError)
  assert.throws(() => parsePolicy({ ...policy, rules: [{ id: 'r1', effect: 'allow', method: 'shell/run', action: null, project: null }] }), protocol.ValidationError)
  const parseBudget = validator('parseLeadBudgetState')
  assert.deepEqual(parseBudget(budget), budget)
  for (const patch of [{ version: 2 }, { workerUsdMicros: NaN }, { leadUsdMicros: -1 },
    { reservedUsdMicros: 0.5 }, { roundsAdmitted: Number.MAX_SAFE_INTEGER + 1 }, { spend: 'free' }])
    assert.throws(() => parseBudget({ ...budget, ...patch }), protocol.ValidationError)
})

test('Lead revisions only advance by safe integers and refuse overflow', () => {
  const next = validator('nextLeadRevision')
  assert.equal(next(0), 1)
  assert.equal(next(4), 5)
  for (const value of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER])
    assert.throws(() => next(value), protocol.ValidationError)
})

test('Lead thread, settings and child projections have no credential or human decision authority field', () => {
  const projection = { version: 1, revision: 2, thread, settings }
  assert.deepEqual(validator('parseLeadHostProjection')(projection), projection)
  for (const apiKey of ['synthetic-secret']) {
    assert.throws(() => validator('parseLeadHostProjection')({ ...projection, apiKey }), protocol.ValidationError)
    assert.throws(() => validator('parseLeadHostProjection')({ ...projection, settings: { ...settings, apiKey } }), protocol.ValidationError)
    assert.throws(() => validator('parseLeadHostProjection')({ ...projection, thread: { ...thread, messages: [{ ...thread.messages[0], apiKey }] } }), protocol.ValidationError)
  }
  const control = { version: 1, type: 'initialize', thread, model: 'model-demo', policy, budget }
  assert.deepEqual(validator('parseLeadChildControl')(control), control)
  assert.throws(() => validator('parseLeadChildControl')({ ...control, apiKey: 'synthetic-secret' }), protocol.ValidationError)
  assert.throws(() => validator('parseLeadChildControl')({ version: 1, type: 'decide', cardId: 'person-1' }), protocol.ValidationError)
  assert.throws(() => validator('parseLeadChildEvent')({ version: 1, type: 'decide', cardId: 'person-1' }), protocol.ValidationError)
  assert.throws(() => validator('parseLeadHostProjection')({ ...projection, thread: { ...thread, messages: Array(257).fill(thread.messages[0]) } }), protocol.ValidationError)
})

test('Lead thread projections are explicit journal windows and IPC has a UTF-8 byte cap', () => {
  const parseThread = validator('parseLeadThread')
  assert.deepEqual(parseThread(thread), thread)
  const window = { ...thread, olderMessages: 1, messages: Array.from({ length: 256 }, (_, i) => ({ ...thread.messages[0], id: `message-${i}` })) }
  assert.deepEqual(parseThread(window), window)
  for (const olderMessages of [undefined, -1, Infinity, 0.5])
    assert.throws(() => parseThread({ ...thread, olderMessages }), protocol.ValidationError)
  const large = { ...thread, messages: Array.from({ length: 64 }, (_, i) => ({ ...thread.messages[0], id: `message-${i}`, text: 'é'.repeat(8192) })) }
  // Character count fits one MiB, encoded bytes do not.
  const event = { version: 1, type: 'projection', thread: large }
  assert.ok(JSON.stringify(event).length < 1_048_576)
  assert.throws(() => validator('parseLeadChildEvent')(event), protocol.ValidationError)
  assert.throws(() => validator('parseLeadChildControl')({ version: 1, type: 'initialize', thread: large, model: 'model-demo', policy, budget }), protocol.ValidationError)
  assert.throws(() => validator('parseLeadChildControl')({ version: 1, type: 'observe', projection: { version: 1, revision: 2, thread: large, settings } }), protocol.ValidationError)
})

test('Lead permission cards work before a contract and person cards identify their live gate', () => {
  const parse = validator('parseLeadCard')
  const permission = { ...cards[1], contractDigest: null }
  assert.deepEqual(parse(permission), permission)
  assert.throws(() => parse({ ...cards[2], personCardId: null }), protocol.ValidationError)
  assert.throws(() => parse({ ...cards[2], kind: 'worker-approval' }), protocol.ValidationError)
  assert.doesNotThrow(() => parse({ ...cards[2], kind: 'worker-approval', personCardId: null }))
  assert.throws(() => parse({ ...permission, proposed: policy }), protocol.ValidationError)
})

test('Lead decisions match the current card binding and the choices for its type', () => {
  const member = (protocol as Record<string, unknown>)['parseLeadCardDecisionFor']
  assert.equal(typeof member, 'function')
  const parse = member as (value: unknown, card: unknown) => unknown
  const decision = { version: 1, cardId: 'card-1', expectedRevision: 1, cardType: 'plan', contractDigest: digest, choice: 'approve' }
  assert.deepEqual(parse(decision, cards[0]), decision)
  for (const patch of [{ cardId: 'other' }, { expectedRevision: 2 }, { contractDigest: 'b'.repeat(64) }, { choice: 'accept' }, { cardType: 'waiting' }])
    assert.throws(() => parse({ ...decision, ...patch }, cards[0]), protocol.ValidationError)
  const permissionDecision = { ...decision, cardId: cards[1]!.id, cardType: 'permission-change', contractDigest: null }
  assert.deepEqual(parse(permissionDecision, { ...cards[1], contractDigest: null }), permissionDecision)
  const accept = { ...decision, cardId: cards[2]!.id, cardType: 'waiting', choice: 'accept' }
  assert.deepEqual(parse(accept, cards[2]), accept)
  assert.throws(() => parse({ ...accept, choice: 'approve' }, cards[2]), protocol.ValidationError)
  assert.throws(() => parse(accept, { ...cards[2], kind: 'worker-approval', personCardId: null }), protocol.ValidationError)
  const resultDecision = { ...accept, cardId: cards[3]!.id, cardType: 'result' }
  assert.deepEqual(parse(resultDecision, cards[3]), resultDecision)
  assert.throws(() => parse(resultDecision, { ...cards[3], outcome: 'accepted' }), protocol.ValidationError)
  assert.throws(() => parse({ ...accept, cardType: 'stopped' }, cards[4]), protocol.ValidationError)
})

test('Lead supported versions and thread migration reject unknown or unversioned records', () => {
  assert.deepEqual((protocol as Record<string, unknown>)['LEAD_SUPPORTED_VERSIONS'], [1])
  const migrate = validator('migrateLeadThread')
  assert.deepEqual(migrate(thread), thread)
  for (const version of [undefined, 0, 2, '1'])
    assert.throws(() => migrate({ ...thread, version }), protocol.ValidationError)
  assert.throws(() => migrate({ ...thread, apiKey: 'synthetic-secret' }), protocol.ValidationError)
})

test('Lead child control/event variants accept valid observations and cancellation', () => {
  for (const control of [{ version: 1, type: 'cancel', reason: 'cancelled' },
    { version: 1, type: 'observe', projection: { version: 1, revision: 2, thread, settings } }])
    assert.deepEqual(validator('parseLeadChildControl')(control), control)
  for (const event of [{ version: 1, type: 'ready' }, { version: 1, type: 'projection', thread }, { version: 1, type: 'stopped', reason: 'budget' }])
    assert.deepEqual(validator('parseLeadChildEvent')(event), event)
})

test('Lead budget snapshots reject unsafe totals and inconsistent open admission', () => {
  const parse = validator('parseLeadBudgetState')
  for (const patch of [
    { roundsAdmitted: 99 },
    { leadUsdMicros: caps.usdMicros }, { workerUsdMicros: Number.MAX_SAFE_INTEGER },
    { leadUsdMicros: 1_000_000_000_001 }, { stop: { reason: 'budget', revision: 2 } },
    { revision: -0 }, { reservedUsdMicros: -0 },
  ]) assert.throws(() => parse({ ...budget, ...patch }), protocol.ValidationError)
  assert.doesNotThrow(() => parse({ ...budget, reservedUsdMicros: caps.usdMicros }))
  // Tightening below admitted rounds or observed spend must still be representable after latching a stop.
  assert.doesNotThrow(() => parse({ ...budget, roundsAdmitted: 99, stop: { reason: 'rounds', revision: 1 } }))
  assert.doesNotThrow(() => parse({ ...budget, workerUsdMicros: caps.usdMicros + 1, stop: { reason: 'budget', revision: 1 } }))
  assert.throws(() => validator('parseLeadCaps')({ ...caps, usdMicros: 1_000_000_000_001 }), protocol.ValidationError)
  assert.throws(() => validator('nextLeadRevision')(-0), protocol.ValidationError)
})

test('Lead message, variable and summary text can be empty without admitting controls', () => {
  assert.doesNotThrow(() => validator('parseLeadThread')({ ...thread, messages: [{ ...thread.messages[0], text: '' }] }))
  assert.doesNotThrow(() => validator('parseLeadAcceptanceContract')({ ...contract, steps: [{ ...contract.steps[0], variables: { optional: '' } }] }))
  assert.doesNotThrow(() => validator('parseLeadCard')({ ...cards[3], summary: '' }))
  assert.throws(() => validator('parseLeadThread')({ ...thread, messages: [{ ...thread.messages[0], text: '\u0007' }] }), protocol.ValidationError)
  assert.throws(() => validator('parseLeadAcceptanceContract')({ ...contract, goal: '' }), protocol.ValidationError)
})

test('Lead prose round-trips Markdown, CRLF goals and multiline Flow variables', () => {
  const message = { ...thread.messages[0], text: 'Fix the build.\n```ts\n\tconst value = 1\n```\nRun the tests.' }
  const multilineThread = { ...thread, messages: [message] }
  assert.deepEqual(validator('parseLeadThread')(multilineThread), multilineThread)
  const multilineContract = { ...contract, goal: 'Fix the build.\r\nRun the tests.',
    steps: [{ ...contract.steps[0], variables: { task: 'First line\n\tIndented second line\r\nThird line' } }] }
  assert.deepEqual(validator('parseLeadAcceptanceContract')(multilineContract), multilineContract)
  const multilineResult = { ...result, reason: 'Waiting for:\n\tchecks\r\nand review' }
  assert.deepEqual(validator('parseLeadAssertionResult')(multilineResult), multilineResult)
  const multilineCard = { ...cards[3], summary: 'Changes:\n\t- repaired the check\r\n- reviewed' }
  assert.deepEqual(validator('parseLeadCard')(multilineCard), multilineCard)
  for (const control of ['\u0000', '\u0008', '\u000b', '\u000c', '\u001f', '\u007f', '\u0085', '\u009f'])
    assert.throws(() => validator('parseLeadThread')({ ...thread, messages: [{ ...message, text: `before${control}after` }] }), protocol.ValidationError)
  for (const id of ['message\n1', 'message\r1', 'message\t1'])
    assert.throws(() => validator('parseLeadThread')({ ...thread, messages: [{ ...message, id }] }), protocol.ValidationError)
})

test('Lead thread snapshots have unique card and message IDs, and card assertions have unique targets', () => {
  const parse = validator('parseLeadThread')
  assert.deepEqual(parse(thread), thread)
  for (const revision of [1, 2])
    assert.throws(() => parse({ ...thread, cards: [cards[0], { ...cards[0], revision }] }), protocol.ValidationError)
  assert.throws(() => parse({ ...thread, messages: [thread.messages[0], { ...thread.messages[0], text: 'Changed message' }] }), protocol.ValidationError)
  for (const card of [cards[2], cards[3]])
    assert.throws(() => validator('parseLeadCard')({ ...card, assertions: [result, { ...result, status: 'passed' }] }), protocol.ValidationError)
})

const threadWindow = (value: unknown, maxBytes: number): unknown => {
  const member = (protocol as Record<string, unknown>)['windowLeadThread']
  assert.equal(typeof member, 'function', 'windowLeadThread must be exported')
  return (member as (value: unknown, maxBytes: number) => unknown)(value, maxBytes)
}
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8')

test('Lead byte window drops only the oldest messages and preserves the journal omission count', () => {
  const large = { ...thread, olderMessages: 9,
    messages: Array.from({ length: 64 }, (_, i) => ({ ...thread.messages[0], id: `message-${i}`, text: 'é'.repeat(8192) })) }
  const original = structuredClone(large)
  const expected = { ...large, olderMessages: 19, messages: large.messages.slice(10) }
  const maxBytes = jsonBytes(expected)
  assert.ok(jsonBytes(large) > 1_048_576)
  assert.deepEqual(threadWindow(large, maxBytes), expected)
  assert.deepEqual(threadWindow(large, maxBytes - 1), { ...large, olderMessages: 20, messages: large.messages.slice(11) })
  assert.deepEqual(large, original, 'windowing must not mutate journal data or cards')
  assert.deepEqual(threadWindow(thread, jsonBytes(thread)), thread)
  const empty = { ...thread, messages: [], olderMessages: 1 }
  assert.deepEqual(threadWindow(thread, jsonBytes(empty)), empty)
  assert.throws(() => threadWindow(thread, 1), protocol.ValidationError, 'cards and metadata cannot be silently dropped')
  for (const maxBytes of [0, -1, -0, NaN, Infinity, 0.5, 1_048_577])
    assert.throws(() => threadWindow(thread, maxBytes), protocol.ValidationError)
  assert.throws(() => threadWindow({ ...thread, olderMessages: Number.MAX_SAFE_INTEGER }, jsonBytes(empty)), protocol.ValidationError)
})

test('Lead byte window reserves envelope overhead before crossing the child boundary', () => {
  const large = { ...thread, messages: Array.from({ length: 64 }, (_, i) => ({ ...thread.messages[0], id: `message-${i}`, text: 'é'.repeat(8192) })) }
  const envelope = { version: 1, type: 'initialize', thread: null, model: 'model-demo', policy, budget }
  const overhead = jsonBytes(envelope) - jsonBytes(null)
  const window = threadWindow(large, 1_048_576 - overhead)
  const control = { ...envelope, thread: window }
  assert.ok(jsonBytes(control) <= 1_048_576)
  assert.deepEqual(validator('parseLeadChildControl')(control), control)
  assert.deepEqual(threadWindow(window, 1_048_576 - overhead), window, 'windowing is idempotent')
})

test('Lead rules carry actions only for action-tier methods', () => {
  const base = { id: 'rule-1', effect: 'allow', action: 'abandon', project: null }
  for (const method of ['workspace/open', 'library/read', 'library/definition', 'session/loadout', 'evidence/seat'])
    assert.throws(() => protocol.parseLeadPermissionPolicy({ ...policy, rules: [{ ...base, method }] }), protocol.ValidationError)
  assert.doesNotThrow(() => protocol.parseLeadPermissionPolicy({ ...policy, rules: [{ ...base, method: 'team/intent' }] }))
  assert.doesNotThrow(() => protocol.parseLeadPermissionPolicy({ ...policy, rules: [{ ...base, method: 'workspace/open', action: null }] }))
})

test('Lead budget events validate identity money freshness and complete source qualifications', () => {
  const parse = validator('parseLeadBudgetEvent')
  const event = { version: 1, type: 'reserve', now: 100, requestId: 'request-1', inputTokens: 12, maxOutputTokens: 30,
    inputUsdMicrosPerMillion: 3, outputUsdMicrosPerMillion: 5, cacheReadUsdMicrosPerMillion: 1, cacheWriteUsdMicrosPerMillion: 4 }
  assert.deepEqual(parse(event), event)
  for (const patch of [{ version: 2 }, { now: -1 }, { requestId: '' }, { inputTokens: 1.5 }, { maxOutputTokens: -1 },
    { inputUsdMicrosPerMillion: null }, { outputUsdMicrosPerMillion: Number.MAX_SAFE_INTEGER }, { extra: true }])
    assert.throws(() => parse({ ...event, ...patch }), protocol.ValidationError)
  const observed = { version: 1, type: 'observe', now: 100, at: 100, revision: 1, source: 'insight/goal', sourceIds: ['corpus-1'],
    goalId: 'goal-1', executionIds: ['run-1'], quality: 'known', usdMicros: 10 }
  assert.deepEqual(parse(observed), observed)
  for (const patch of [{ source: 'unqualified' }, { sourceIds: [] }, { executionIds: ['run-1', 'run-1'] },
    { quality: 'known', usdMicros: null }, { usdMicros: -1 }, { at: 101 }, { quality: 'estimated' }])
    assert.throws(() => parse({ ...observed, ...patch }), protocol.ValidationError)
})

test('Lead budget increases are bound to a validated revision and current immutable card', () => {
  const card = { version: 1, id: 'budget-1', revision: 2, type: 'budget-change', contractDigest: null,
    logicalGoalId: 'logical-1', previous: { revision: 3, caps }, proposed: { ...caps, rounds: 4 } }
  assert.deepEqual(validator('parseLeadCard')(card), card)
  const click = { version: 1, cardId: card.id, cardType: card.type, expectedRevision: 2, contractDigest: null, choice: 'approve' }
  assert.deepEqual(protocol.parseLeadCardDecisionFor(click, card), click)
  for (const patch of [{ expectedRevision: 1 }, { cardId: 'different-card' }, { choice: 'accept' }])
    assert.throws(() => protocol.parseLeadCardDecisionFor({ ...click, ...patch }, card), protocol.ValidationError)
  for (const patch of [{ logicalGoalId: '' }, { previous: { revision: -1, caps } }, { proposed: caps },
    { proposed: { usdMicros: -1, rounds: 4 } }])
    assert.throws(() => validator('parseLeadCard')({ ...card, ...patch }), protocol.ValidationError)
})

test('unavailable worker spend can be recorded without inventing source identities', () => {
  const event = { version: 1, type: 'observe', now: 100, at: 100, revision: 1, source: 'insight/goal', sourceIds: [],
    goalId: 'goal-1', executionIds: ['run-1'], quality: 'unknown', usdMicros: null }
  assert.deepEqual(validator('parseLeadBudgetEvent')(event), event)
})

test('cache usage and cache prices validate independently without weakening numeric refusals', () => {
  const parse = validator('parseLeadBudgetEvent')
  const reservation = { version: 1, type: 'reserve', now: 100, requestId: 'paid-1', inputTokens: 10, maxOutputTokens: 20,
    inputUsdMicrosPerMillion: 3, outputUsdMicrosPerMillion: 5, cacheReadUsdMicrosPerMillion: 1, cacheWriteUsdMicrosPerMillion: 4 }
  assert.deepEqual(parse(reservation), reservation)
  for (const patch of [{ cacheReadUsdMicrosPerMillion: -1 }, { cacheWriteUsdMicrosPerMillion: NaN }, { cacheReadUsdMicrosPerMillion: 'free' }])
    assert.throws(() => parse({ ...reservation, ...patch }), protocol.ValidationError)
  const usage = { version: 1, type: 'settle', now: 100, requestId: 'paid-1', inputTokens: 12, outputTokens: 21, cacheReadTokens: 20, cacheWriteTokens: 10 }
  assert.deepEqual(parse(usage), usage)
  for (const patch of [{ cacheReadTokens: -1 }, { cacheWriteTokens: 0.1 }, { cacheReadTokens: Infinity }])
    assert.throws(() => parse({ ...usage, ...patch }), protocol.ValidationError)
})

test('reservations refuse missing cache prices rather than treating them as ordinary input', () => {
  const event = { version: 1, type: 'reserve', now: 100, requestId: 'paid-1', inputTokens: 10, maxOutputTokens: 20,
    inputUsdMicrosPerMillion: 3, outputUsdMicrosPerMillion: 5, cacheReadUsdMicrosPerMillion: 1, cacheWriteUsdMicrosPerMillion: 4 }
  for (const name of ['cacheReadUsdMicrosPerMillion', 'cacheWriteUsdMicrosPerMillion']) {
    const missing: any = { ...event }; delete missing[name]
    assert.throws(() => validator('parseLeadBudgetEvent')(missing), protocol.ValidationError)
  }
})


test('first-round proof requires the bound start and a valid host round identity', () => {
  const parse = validator('parseLeadBudgetEvent')
  const event = { version: 1, type: 'bind', now: 100, goalId: 'team-1', executionId: 'run-1', startId: 'start-1', firstRoundId: 'round-1' }
  assert.deepEqual(parse(event), event)
  for (const patch of [{ startId: null }, { startId: undefined }, { firstRoundId: '' }, { firstRoundId: false }, { firstRoundId: 1 }])
    assert.throws(() => parse({ ...event, ...patch }), protocol.ValidationError)
})


test('every start binding requires first-round proof in the protocol', () => {
  const parse = validator('parseLeadBudgetEvent')
  const event = { version: 1, type: 'bind', now: 100, goalId: 'team-1', executionId: 'run-1', startId: 'start-1' }
  assert.throws(() => parse(event), protocol.ValidationError)
  assert.deepEqual(parse({ ...event, firstRoundId: '1' }), { ...event, firstRoundId: '1' })
})


test('a missing first-round identity names its field including a nested path', () => {
  const event = { version: 1, type: 'bind', now: 100, goalId: 'team-1', executionId: 'run-1', startId: 'start-1' }
  for (const path of ['', 'event']) assert.throws(() => protocol.parseLeadBudgetEvent(event, path),
    (error: unknown) => error instanceof protocol.ValidationError && error.path === (path ? `${path}.firstRoundId` : 'firstRoundId'))
})


test('terminal spend observations require one run and a known final cost', () => {
  const event = { version: 1, type: 'observe', now: 100, at: 100, revision: 1, source: 'worker-samples', sourceIds: ['sample-1'],
    goalId: 'goal-1', executionIds: ['run-1'], quality: 'known', usdMicros: 20, terminal: true }
  assert.deepEqual(protocol.parseLeadBudgetEvent(event), event)
  for (const patch of [{ executionIds: [] }, { executionIds: ['run-1', 'run-2'] }, { quality: 'partial' }, { usdMicros: null }, { terminal: 'yes' }])
    assert.throws(() => protocol.parseLeadBudgetEvent({ ...event, ...patch }), protocol.ValidationError)
})

test('decided history cannot crowd live decisions or messages out of the window envelope', () => {
  const value = { ...thread, cards: [cards[0]], decisions: [1, 2].map(position => ({ position, choice: 'approve', card: { ...cards[0], contract: { ...contract, goal: 'x'.repeat(10000) } } })) }
  const result = (protocol as any).windowLeadThread(value, 4000)
  assert.deepEqual(result.cards, value.cards)
  assert.deepEqual(result.messages, value.messages)
  assert.deepEqual(result.decisions, [])
  assert.ok(new TextEncoder().encode(JSON.stringify(result)).byteLength <= 4000)
})

test('a window projection says where a running goal stands, and refuses a reading that cannot be true', () => {
  const parse = validator('parseLeadWindowProjection')
  const projection = { version: 1, revision: 2, thread: { ...thread, state: 'running' }, settings, requestInFlight: false, wayOut: null, waitReason: null, planConsentExpiresAt: null }
  const progressOf = (value: unknown) => (parse(value) as { progress?: unknown }).progress
  for (const progress of [{ step: 2, steps: 3, runs: 1 }, { step: 1, steps: 1, runs: 0 }, { step: 64, steps: 64, runs: 64 }])
    assert.deepEqual(progressOf({ ...projection, progress }), { ...progress, since: undefined })
  assert.equal(progressOf(projection), undefined)
  assert.equal(progressOf({ ...projection, progress: null }), undefined)
  for (const progress of [{ step: 0, steps: 1, runs: 0 }, { step: 2, steps: 1, runs: 0 }, { step: 1, steps: 65, runs: 0 }, { step: 1, steps: 1, runs: -1 },
    { step: 1.5, steps: 2, runs: 0 }, { step: 1, steps: 1 }, { step: 1, steps: 1, runs: 0, title: 'Implement and review' }, 'Step 1 of 1'])
    assert.throws(() => parse({ ...projection, progress }), protocol.ValidationError)
})


test('only a pending reviewed result permits accept-open-pr, including a push result variant', () => {
  const result = { ...cards[3]!, publication: 'push' }
  const click = { version: 1, cardId: result.id, cardType: 'result', expectedRevision: result.revision,
    contractDigest: digest, choice: 'accept-open-pr' }
  assert.deepEqual(protocol.parseLeadCardDecisionFor(click, result), click)
  for (const card of cards.filter(card => card.type !== 'result'))
    assert.throws(() => protocol.parseLeadCardDecisionFor({ ...click, cardId: card.id, cardType: card.type }, card))
  assert.throws(() => protocol.parseLeadCardDecisionFor(click, { ...result, outcome: 'accepted' }))
  const decided = protocol.parseLeadThread({ ...thread, state: 'following', cards: [],
    decisions: [{ card: result, choice: 'accept-open-pr', position: 1 }] })
  assert.equal(decided.state, 'following')
})

test('follow preferences are closed booleans and older settings default to on', () => {
  const { follow: _follow, ...legacy } = settings
  const parsed = protocol.parseLeadSettingsProjection(legacy) as any
  assert.deepEqual(parsed.follow, { checks: true, reviews: true })
  assert.deepEqual(protocol.parseLeadSettingsUpdate({ expectedRevision: 1, follow: { checks: false, reviews: true } }).follow,
    { checks: false, reviews: true })
  assert.throws(() => protocol.parseLeadSettingsUpdate({ expectedRevision: 1, follow: { checks: 'yes', reviews: true } }))
})

test('automatic origin and repair projection are bounded data and never decision authority', () => {
  const origin = { source: 'pull-request', event: 'event-1', subject: '7', url: 'https://github.com/acme/widgets/pull/7' }
  assert.deepEqual(protocol.parseLeadOrigin(origin), origin)
  assert.throws(() => protocol.parseLeadOrigin({ ...origin, command: 'start' }), protocol.ValidationError)
  assert.throws(() => protocol.parseLeadOrigin({ ...origin, subject: 'x'.repeat(5000) }), protocol.ValidationError)
  const handback = { key: 'repair-1', event: 'event-1', kind: 'checks', head: 'a'.repeat(40), runId: 'run-1', teamId: 'team-1', round: 4, at: 100,
    stage: 'prepared', publishedHead: null }
  assert.deepEqual(protocol.parseLeadHandback(handback), handback)
  assert.throws(() => protocol.parseLeadHandback({ ...handback, round: 0 }), protocol.ValidationError)
  assert.throws(() => protocol.parseLeadHandback({ ...handback, approved: true }), protocol.ValidationError)
})

test('repeat scope, bounded run history, and host information cards are closed and validated', () => {
  const repeat = { every: 'mondays', at: '09:00' }
  const repeating = { ...contract, repeat }
  assert.deepEqual(protocol.parseLeadAcceptanceContract(repeating), repeating)
  assert.throws(() => protocol.parseLeadAcceptanceContract({ ...contract, repeat: { every: 'weekly', at: '09:00' } }))
  assert.throws(() => protocol.parseLeadAcceptanceContract({ ...contract, repeat: { every: 'mondays', at: '24:00' } }))
  const task = { id: 'repeat-1', title: 'Dependencies', goal: 'Update acme-web', every: 'mondays', at: '09:00', enabled: true, lastRunAt: null,
    approved: { contract: repeating, contractDigest: digest }, perRunCaps: caps, paused: false,
    runs: [{ slot: 1, at: 2, state: 'started', logicalGoalId: 'goal-1', outcome: 'accepted', usdMicros: 100, rounds: 2 }] }
  assert.doesNotThrow(() => protocol.parseLeadSchedule({ version: 1, tasks: [task], quiet: null }))
  for (const bad of [{ ...task, approved: { contract: repeating, contractDigest: 'b'.repeat(64) } }, { ...task, runs: Array(13).fill(task.runs[0]) },
    { ...task, runs: [{ ...task.runs[0], state: 'queued' }] }, { ...task, runs: [{ ...task.runs[0], usdMicros: -1 }] }])
    assert.throws(() => protocol.parseLeadSchedule({ version: 1, tasks: [bad], quiet: null }))
  for (const card of [
    { ...base, type: 'second-look', logicalGoalId: 'goal-1', runId: 'run-1', stopKey: 'stop-1', said: 'Blocked on #231', found: '#231 merged', did: 'Restarted' },
    { ...base, type: 'allowance-warning', logicalGoalId: 'goal-1', usdMicros: 4_000_000, caps },
  ]) {
    assert.deepEqual(protocol.parseLeadCard(card), card)
    assert.throws(() => protocol.parseLeadCard({ ...card, permission: 'merge' }))
    assert.throws(() => protocol.parseLeadCardDecision({ version: 1, cardId: card.id, cardType: card.type, expectedRevision: 1, contractDigest: digest, choice: 'approve' }))
  }
  assert.throws(() => protocol.parseLeadCard({ ...base, type: 'second-look', logicalGoalId: 'goal-1', runId: 'run-1', stopKey: 'stop-1', said: 'x'.repeat(1001), found: 'Cleared', did: 'Restarted' }))
})


test('Lead contracts preserve explicit no-publication pins without adding an absent pin', () => {
  for (const publicationRepository of [undefined, null, 'acme/acme-web']) {
    const value = { ...contract, ...(publicationRepository === undefined ? {} : { publicationRepository }) }
    assert.deepEqual(protocol.parseLeadAcceptanceContract(value), value)
  }
})
