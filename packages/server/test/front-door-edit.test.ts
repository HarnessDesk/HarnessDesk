import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import type { AgentEntry } from '@harnessdesk/protocol'
import { Agents } from '../src/agents.js'
import { chooseSeat, sentenceOf, type SeatOffer } from '../src/agent-seating.js'
import { compileFlowPolicy, parseFlowPolicy } from '../src/flow-policy.js'
import { builtinAgentRoot, builtinFlowRoot } from '../src/host.js'
import { tempDir } from './scratch.js'

// Shipping controls: native read/edit, bridged read with its read hook,
// and no native control. No fake publish control masks the fresh-desk bug.
const offers: readonly SeatOffer[] = ([
  { runtime: 'claude-code', holds: ['read'] },
  { runtime: 'codex', holds: ['read', 'edit'] },
  { runtime: 'cursor', holds: [] },
] as const).map(one => ({ ...one, models: [], efforts: [], signedIn: true, spent: false }))

const agents = async (): Promise<AgentEntry[]> => {
  const reader = new Agents({ user: tempDir('hd-edit-agents-'), builtin: builtinAgentRoot() })
  const entries: AgentEntry[] = []
  for (const id of await readdir(builtinAgentRoot())) {
    const entry = await reader.read(id)
    if (entry) entries.push(entry)
  }
  return entries
}

test('every shipped Agent skips preferences that cannot enforce its default edit-or-read access', async () => {
  for (const entry of await agents()) {
    assert.ok(entry.definition, entry.id)
    const level = entry.definition.ceiling === 'read' ? 'read' : 'edit'
    const chosen = chooseSeat(entry.definition.prefer, offers, { level, unheld: 'refuse', required: true })
    assert.ok(chosen.seat, entry.id)
    assert.ok(offers.find(one => one.runtime === chosen.seat?.runtime)?.holds?.includes(level), entry.id)
    if (level === 'edit') assert.equal(chosen.seat.runtime, 'codex', entry.id)
  }
})

test('Write and review writes and repairs at edit, reviews committed work, then asks the person to publish the reviewed revision', async () => {
  const source = await readFile(join(builtinFlowRoot(), 'fix-and-review.yml'), 'utf8')
  const parsed = parseFlowPolicy(source)
  assert.ok(parsed.document?.format === 'agents')
  const compiled = compileFlowPolicy(parsed.document, await agents())
  assert.deepEqual(compiled.problems, [])
  const flow = parsed.document.flow
  const writer = flow.roles.find(one => one.id === 'fixer')
  assert.ok(writer?.kind === 'agent')
  assert.equal(writer.grant, 'edit')
  assert.deepEqual(flow.rules.find(one => one.id === 'review-it')?.when?.every, ['committed'])
  assert.match(flow.seed.detail ?? '', /hand over its branch and revision/i)
  assert.doesNotMatch(flow.rules.find(one => one.id === 'fix-again')?.then.detail ?? '', /push|publish/i)
  const handoff = flow.rules.find(one => one.id === 'hand-to-the-person')!
  assert.equal(flow.roles.find(one => one.id === handoff.then.role)?.kind, 'person')
  assert.match(handoff.then.title, /publish/i)
  assert.match(handoff.then.detail ?? '', /\{\{evidence.review.at\}\}/)
  assert.match(handoff.then.detail ?? '', /branch/i)
  assert.match(handoff.then.detail ?? '', /approve/i)
})

test('required access refusals say what to change without internal seating vocabulary', () => {
  for (const level of ['read', 'edit', 'publish', 'merge'] as const) {
    const words = sentenceOf('Runtime Alpha', { kind: 'unheld', level, required: true, detail: null })
    assert.doesNotMatch(words, /\bhold\b|\bSeat\b|\bceiling\b|front door/i)
    assert.match(words, /choose another agent/i)
  }
})
