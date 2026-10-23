import assert from 'node:assert/strict'
import test from 'node:test'
import { parseLeadAcceptanceContract, type LeadAcceptanceContract } from '@harnessdesk/protocol'
import { leadContinuation, leadInstructions } from '../src/index.js'

const project = { id: 'acme', path: '/work/acme' }
const assignments = [
  { role: 'implement', agent: 'implementer', seat: { runtime: 'writer', model: 'model-w' }, ceiling: 'edit' },
  { role: 'review', agent: 'code-reviewer', seat: { runtime: 'reviewer', model: 'model-r' }, ceiling: 'read' },
]
const step = (id: string, over: Record<string, unknown> = {}) => ({ id, title: `Change ${id}`, flow: 'lead-reviewed-result', sourceRevision: 'recipe-1',
  variables: { area: 'billing' }, attendance: 'attended', assignments, ...over })
const contractOf = (steps: unknown[] = [step('first'), step('second')]): LeadAcceptanceContract => parseLeadAcceptanceContract({
  version: 1, revision: 1, digest: 'b'.repeat(64), goal: 'Fix the rounding in invoices', project, policyRevision: 1, steps,
  assertions: [{ id: 'unit', kind: 'check', description: 'The checks pass' }, { id: 'review', kind: 'review', description: 'The review approves' },
    { id: 'blockers', kind: 'blocking-findings', description: 'No blocking finding is left' }],
  caps: { usdMicros: 5_000_000, rounds: 12 },
})
const pending = (contract: LeadAcceptanceContract) => contract.steps.map(one => ({ id: one.id, state: 'pending' }))
const textOf = (blocks: readonly { readonly text: string }[]) => blocks.map(block => block.text).join('')
const contractLine = (text: string) => text.split('\n').find(line => line.startsWith('Approved contract: '))

test('the desk message carries the approved contract itself, as one compact JSON line', () => {
  const contract = contractOf()
  const line = contractLine(textOf(leadContinuation({ contract, steps: pending(contract) })))
  assert.ok(line, 'one line holds the contract')
  const json = line.slice('Approved contract: '.length)
  assert.equal(json, JSON.stringify(contract), 'compact, with nothing added or left out')
  assert.deepEqual(JSON.parse(json), contract)
  for (const part of [contract.digest, '"usdMicros":5000000', '"rounds":12', '"role":"implement"', '"model":"model-r"', '"id":"blockers"', '"area":"billing"'])
    assert.ok(json.includes(part), `the contract line includes ${part}`)
})

test('the desk message says the person approved the plan, and how a step is started', () => {
  const contract = contractOf()
  const text = textOf(leadContinuation({ contract, steps: pending(contract) }))
  assert.match(text, /^The person approved your plan\./)
  // The standing instructions say these calls apply only once this message has arrived, so this message has to say how.
  for (const word of ['flow_preview', 'flow_start_goal', 'root', 'source', 'seats', 'vars', 'attended', 'token', 'sentence'])
    assert.match(text, new RegExp(`\\b${word}\\b`), `names ${word}`)
  assert.match(text, /never answer worker approvals/)
  assert.match(text, /do not look for one/, 'the desk holds no goal record for the model to hunt for')
})

test('the desk message names the state of every step, so a step that has started is not started again', () => {
  const contract = contractOf()
  const text = textOf(leadContinuation({ contract, steps: [{ id: 'first', state: 'started' }, { id: 'second', state: 'pending' }] }))
  assert.ok(text.split('\n').includes('Step states: first started, second pending.'))
  // A step the journal has no record of yet is still waiting to be started.
  assert.ok(textOf(leadContinuation({ contract, steps: [] })).split('\n').includes('Step states: first pending, second pending.'))
})

test('a contract longer than one block is split into well-formed blocks that carry all of it', () => {
  // The cut falls between the two halves of a character that takes two UTF-16 units, wherever a naive cut would put it.
  const offset = textOf(leadContinuation({ contract: contractOf([step('first', { title: '\u{1F600}' })]), steps: [] })).indexOf('\u{1F600}')
  const contract = contractOf([step('first', { title: `${'a'.repeat(15_999 - offset)}\u{1F600}` }), step('second', { title: 'b'.repeat(16_000) })])
  const blocks = leadContinuation({ contract, steps: pending(contract) })
  assert.ok(blocks.length > 1, 'one block cannot hold it')
  for (const block of blocks) {
    assert.equal(block.type, 'text')
    assert.ok(block.text.length > 0 && block.text.length <= 16_384, 'each block is within the text bound')
    assert.doesNotThrow(() => encodeURIComponent(block.text), 'no block ends inside a character')
  }
  assert.ok(textOf(blocks).includes(JSON.stringify(contract)), 'the blocks join back to the whole contract')
})

test('a contract that needs more than the 64 blocks a message may have is refused, and the largest that fits is carried whole', () => {
  const titled = (length: number) => contractOf(Array.from({ length: 64 }, (_, index) => step(`s${index}`, { title: 'y'.repeat(length) })))
  const carry = (length: number) => leadContinuation({ contract: titled(length), steps: [] })
  assert.throws(() => carry(16_384), /lead-continuation-too-large/)
  let low = 0, high = 16_384
  while (low < high) {
    const middle = (low + high + 1) >> 1
    try { carry(middle); low = middle } catch { high = middle - 1 }
  }
  assert.ok(low > 15_000, 'the search found the edge of the bound, not a smaller failure')
  assert.equal(carry(low).length, 64)
  assert.ok(textOf(carry(low)).includes(JSON.stringify(titled(low))))
  assert.throws(() => carry(low + 1), /lead-continuation-too-large/)
})

test('the standing instructions keep desk call names out of what the person reads, and the plan sentence off the steps', () => {
  const caps = { usdMicros: 5_000_000, rounds: 12 }
  const seats = { implement: [{ runtime: 'writer' }], review: [{ runtime: 'reviewer' }] }
  const text = leadInstructions({ name: 'Dex', project, policyRevision: 1, caps, seats } as Parameters<typeof leadInstructions>[0])
  assert.match(text, /Never name a tool, method or field of the desk API in your text/)
  assert.match(text, /never restates the steps/)
})
test('the desk message says a required check counts only when the person runs it, so the Lead asks for that run', () => {
  const contract = contractOf(); const text = leadContinuation({ contract, steps: pending(contract) }).map(block => block.text).join('')
  assert.match(text, /a required check counts only when the person runs it on the Team/)
  assert.match(text, /never say the step waits only for their decision/)
})

test('instructions and continuation permit a fresh plan after settled runs leave no result', () => {
  const contract = contractOf()
  const standing = leadInstructions({ name: 'Dex', project, policyRevision: 1, caps: contract.caps })
  const continuation = textOf(leadContinuation({ contract, steps: contract.steps.map(step => ({ id: step.id, state: 'started' })) }))
  for (const text of [standing, continuation]) {
    assert.match(text, /settled.*no result/)
    assert.match(text, /new plan/)
    assert.match(text, /new step ids/)
    assert.match(text, /approv/)
  }
})
