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

const REVIEW = `
name: Fix and review
inputs:
  work: What to fix
roles:
  fixer:
    kind: agent
    seat: cursor=gpt-codex/xhigh
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

const model = (id: string, levels: readonly string[]): ModelInfo => ({
  id,
  displayName: id,
  reasoningLevels: levels.map((level) => ({ id: level, label: level })),
  supportsImages: false,
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

const dry = async (ctx: HostContext) => flowMethods['flow/dry'](ctx, { root: '/repo', source: REVIEW })

test('a Seat preference naming an effort its model does not offer is refused by the dry run, before any Seat opens', async () => {
  const result = await dry(ctxFor([model('gpt-codex', ['low', 'high'])]))
  const problem = result.problems.find((one) => one.at === 'roles.fixer.seat')
  assert.ok(problem, 'expected a problem on the fixer seat')
  assert.equal(problem?.level, 'error')
  assert.match(problem?.text ?? '', /does not offer "xhigh" effort/)
  assert.match(problem?.text ?? '', /it offers low, high/)
})

test('a Seat preference is unrefused when its model actually offers that effort', async () => {
  const result = await dry(ctxFor([model('gpt-codex', ['low', 'xhigh'])]))
  assert.equal(result.problems.some((one) => one.at === 'roles.fixer.seat'), false)
})

test('a model with no effort levels at all refuses any named effort, worded as having none', async () => {
  const result = await dry(ctxFor([model('gpt-codex', [])]))
  const problem = result.problems.find((one) => one.at === 'roles.fixer.seat')
  assert.match(problem?.text ?? '', /has no effort levels, so "xhigh" is refused/)
})

test('an unread catalogue is not guessed at: no problem when the runtime could not list its models', async () => {
  const runtime = {
    info: { presentation: { name: 'Cursor' } } as RuntimeInfo,
    listModels: async () => {
      throw new Error('cursor is not running')
    },
  } as unknown as AgentRuntime
  const ctx = {
    runtimes: {
      get: () => runtime,
      infoOf: () => ({ capabilities: { pluginTools: true } }) as RuntimeInfo,
      ids: () => new Set(['cursor']),
    },
  } as unknown as HostContext
  const result = await dry(ctx)
  assert.equal(result.problems.some((one) => one.at === 'roles.fixer.seat'), false)
})
