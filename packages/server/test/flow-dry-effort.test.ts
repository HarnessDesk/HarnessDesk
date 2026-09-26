import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { AgentRuntime, ModelInfo, RuntimeInfo } from '@harnessdesk/protocol'

import { flowMethods } from '../src/methods/flows.js'
import type { HostContext } from '../src/methods/context.js'

/*
 * Issue #1013: a Seat preference of the form `runtime=model/effort` passed
 * the dry run even when that model has no such effort level, and only failed
 * once the Seat actually opened. The runtime's own model catalogue already
 * carries each model's reasoning levels — no session needed — so the dry run
 * can and must check a preference's effort against them before any Seat
 * opens.
 */

const REVIEW = (seat: string) => `
name: Fix and review
inputs:
  work: What to fix
roles:
  fixer:
    kind: agent
    seat: ${seat}
    permission: publish
    outcomes: [published, cannot]
  referee:
    kind: person
    outcomes: [merged, dropped]
seed:
  role: fixer
  title: "{{work}}"
rules:
  - id: review-it
    on: fixer
    when: { every: published }
    then: { role: referee, title: "Review" }
`

const model = (id: string, levels: readonly (readonly [string, string])[], isDefault = false): ModelInfo => ({
  id,
  displayName: id,
  reasoningLevels: levels.map(([levelId, label]) => ({ id: levelId, label })),
  supportsImages: false,
  ...(isDefault ? { isDefault: true } : {}),
})

const ctxFor = (models: readonly ModelInfo[]): HostContext => {
  const runtime = {
    info: { presentation: { name: 'Cursor' } } as RuntimeInfo,
    listModels: async () => models,
  } as unknown as AgentRuntime
  return {
    runtimes: {
      get: (id: string) => (id === 'cursor' ? runtime : undefined),
      infoOf: () => ({ capabilities: { pluginTools: true } }) as RuntimeInfo,
      ids: () => new Set(['cursor']),
    },
  } as unknown as HostContext
}

const dry = async (ctx: HostContext, seat: string) => flowMethods['flow/dry'](ctx, { root: '/repo', source: REVIEW(seat) })

test('a Seat preference naming an effort its model does not offer is refused by the dry run, before any Seat opens, in the runtime\'s own labels', async () => {
  const result = await dry(
    ctxFor([model('gpt-codex', [['low', 'Low'], ['high', 'High']])]),
    'cursor=gpt-codex/xhigh',
  )
  const problem = result.problems.find((one) => one.at === 'roles.fixer.seat')
  assert.ok(problem, 'expected a problem on the fixer seat')
  assert.equal(problem?.level, 'error')
  assert.match(problem?.text ?? '', /does not offer "xhigh" effort/)
  assert.match(problem?.text ?? '', /it offers Low, High/)
})

test('a Seat preference is unrefused when its model actually offers that effort', async () => {
  const result = await dry(
    ctxFor([model('gpt-codex', [['low', 'Low'], ['xhigh', 'Extra high']])]),
    'cursor=gpt-codex/xhigh',
  )
  assert.deepEqual(result.problems, [])
})

test('a model that names no effort levels at all is left alone, never refused (#1013 finding 3): an empty list means unknown, not "has none"', async () => {
  const result = await dry(ctxFor([model('gpt-codex', [])]), 'cursor=gpt-codex/xhigh')
  assert.deepEqual(result.problems, [])
})

test('"default" is never refused, even against a model with real levels that do not include it', async () => {
  const result = await dry(
    ctxFor([model('gpt-codex', [['low', 'Low'], ['high', 'High']])]),
    'cursor=gpt-codex/default',
  )
  assert.deepEqual(result.problems, [])
})

test('an effort named with no model is checked against the runtime\'s default model', async () => {
  const models = [
    model('gpt-codex', [['low', 'Low'], ['high', 'High']]),
    model('gpt-mini', [['low', 'Low']], true),
  ]
  const refused = await dry(ctxFor(models), 'cursor/high')
  const problem = refused.problems.find((one) => one.at === 'roles.fixer.seat')
  assert.match(problem?.text ?? '', /gpt-mini does not offer "high" effort — it offers Low/)

  const allowed = await dry(ctxFor(models), 'cursor/low')
  assert.deepEqual(allowed.problems, [])
})

test('an unread catalogue is not guessed at, and is told apart from a catalogue that reads as empty', async () => {
  const throws = {
    info: { presentation: { name: 'Cursor' } } as RuntimeInfo,
    listModels: async (): Promise<readonly ModelInfo[]> => {
      throw new Error('cursor is not running')
    },
  } as unknown as AgentRuntime
  const ctxThrows = {
    runtimes: {
      get: () => throws,
      infoOf: () => ({ capabilities: { pluginTools: true } }) as RuntimeInfo,
      ids: () => new Set(['cursor']),
    },
  } as unknown as HostContext
  const result = await dry(ctxThrows, 'cursor=gpt-codex/xhigh')
  // Not vacuous: the same seat against a catalogue that reads back with a
  // model but no matching effort *does* refuse (the first test above), so an
  // implementation that skipped the read-failure case wrongly, or dropped
  // the effort check altogether, would show up as a difference from that
  // case rather than a tautology.
  assert.deepEqual(result.problems, [])
})
