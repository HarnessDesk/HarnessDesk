import { expect, it } from 'vitest'
import type { FlowExecution, Intent } from '@harnessdesk/protocol'
import { flowGraphDocument } from '../preview/flow-graph-fixture'
import { flowModel } from './flow-model'
import { flowOverlay, flowOverlayLabels, stepForRow, rowsForStep } from './flow-overlay'
import { flowLayout, FLOW_LABEL_H } from './flow-layout'
import { runTimeline } from './run-timeline'

const round = (n: number, role: string, cause: string, closed = true, seats: string[] = []): FlowExecution['rounds'][number] =>
  ({ n, role, cause, state: closed ? 'closed' : 'running', cards: [n], seats, evidence: [] })
const run = (rounds: FlowExecution['rounds'], over: Partial<FlowExecution> = {}): FlowExecution => ({
  version: 2, id: 'run', goal: 'goal', document: flowGraphDocument('blueprint'), rounds,
  operations: [], state: 'running', legacyRun: null, reason: null, ...over,
})
const card = (id: number, outcome: string | null = 'published'): Intent => ({
  id, title: 'Build the change', detail: '', state: outcome ? 'done' : 'claimed', createdAt: id * 1000,
  updatedAt: id * 1000 + 600, outcome, files: [], dependsOn: [], claim: null,
}) as Intent
const draw = (execution: FlowExecution, cards: Intent[] = [], extra: Partial<Parameters<typeof flowOverlay>[0]> = {}) =>
  flowOverlay({ execution, cards, model: flowModel(execution.document.flow), ...extra })

it('reads the travelled rules from the host causes, including a loop and its incoming baton', () => {
  const execution = run([round(1, 'write', 'seed', true, ['writer']), round(2, 'check', 'after:1:written'),
    round(3, 'review', 'after:2:checked', true, ['beta', 'gamma']), round(4, 'fix', 'after:3:changes', false, ['fixer'])])
  const overlay = draw(execution, [card(1), card(2, 'passes'), card(3, 'request-changes'), card(4, null)])
  expect(overlay.steps.get('write')).toMatchObject({ state: 'done', runs: 1, durationMs: 600, line: 'published', seats: ['writer'] })
  expect(overlay.steps.get('review')?.seats).toEqual(['beta', 'gamma'])
  expect(overlay.steps.get('fix')).toMatchObject({ state: 'working', since: 4000 })
  expect(overlay.steps.get('land')).toMatchObject({ state: 'future', runs: 0 })
  expect(overlay.rules.get('changes')).toEqual({ count: 1, current: true })
  expect(overlay.rules.get('approved')).toEqual({ count: 0, current: false })
})

it('counts recorded check results without guessing whether an unfinished operation already kept its result', () => {
  const execution = run([round(1, 'check', 'seed', false)], { operations: [{ key: 'check:1:0', kind: 'check', state: 'started', card: 1, seat: null }] })
  const first = { id: 'first', at: 2000 }
  expect(draw(execution, [card(1, null)], { attempts: new Map([[1, { attempts: [first], complete: true }]]) }).steps.get('check')?.runs).toBe(1)
  // A result can reach the separate read before the host finishes its operation.
  const results = new Map([[1, { attempts: [first, { id: 'second', at: 3000 }], complete: true }]])
  expect(draw(execution, [card(1, null)], { attempts: results }).steps.get('check')?.runs).toBe(2)
  expect(draw({ ...execution, operations: execution.operations.map(one => ({ ...one, state: 'finished' as const })) }, [card(1)], { attempts: results }).steps.get('check')?.runs).toBe(2)
  expect(draw(execution, [card(1, null)]).steps.get('check')?.runs).toBeNull()
  expect(draw(execution, [card(1, null)], { attempts: new Map([[1, { attempts: [{ id: 'first', at: 2000 }], complete: false }]]) }).steps.get('check')?.runs).toBeNull()
})

it('a live retry of an earlier closed check draws as working alongside the current round', () => {
  const execution = run([round(1, 'check', 'seed'), round(2, 'review', 'after:1:checked', false)], {
    operations: [{ key: 'check:1:0', kind: 'check', state: 'started', card: 1, seat: null }],
  })
  expect(draw(execution, [card(1, null), card(2, null)]).steps.get('check')?.state).toBe('working')
  expect(draw(execution, [card(1, null), card(2, null)]).steps.get('check')).toMatchObject({ durationMs: null, since: null })
  expect(draw(execution).steps.get('review')?.state).toBe('working')
})

it('a waiting person needs you; a stopped Run has no working step; missing timing stays unknown', () => {
  const execution = run([round(1, 'you', 'seed', false)])
  expect(draw(execution, [card(1, null)]).steps.get('you')).toMatchObject({ state: 'waiting', line: 'merged · dropped' })
  expect(draw({ ...execution, state: 'stopped' }).steps.get('you')?.state).toBe('stopped')
  expect(draw(run([round(1, 'write', 'seed')])).steps.get('write')?.durationMs).toBeNull()
})

it('counts repeated rounds and does not guess a travelled edge for an externally opened round', () => {
  const execution = run([round(1, 'write', 'seed'), round(2, 'check', 'after:1:written'),
    round(3, 'write', 'cause:manual', false)])
  const overlay = draw(execution)
  expect(overlay.steps.get('write')?.runs).toBe(2)
  expect([...overlay.rules.values()].filter(rule => rule.current)).toHaveLength(0)
})

it('keeps arbitrary rule ids intact and refuses a cause for a different source or destination', () => {
  const base = flowGraphDocument('blueprint')
  const document = { ...base, flow: { ...base.flow, rules: base.flow.rules.map(rule => ({ ...rule, id: `${rule.id}:with:colon` })) } } as typeof base
  const execution = run([round(1, 'write', 'seed'), round(2, 'check', 'after:1:written:with:colon'), round(3, 'land', 'after:2:checked:with:colon', false)], { document })
  expect(draw(execution).rules.get('written:with:colon')?.count).toBe(1)
  expect(draw(execution).rules.get('checked:with:colon')?.count).toBe(0)
})

it('links every row of repeated step rounds in both directions without selecting global Run rows', () => {
  const execution = run([round(1, 'write', 'seed'), round(2, 'review', 'cause:manual'), round(3, 'write', 'cause:manual', false)])
  const rows = runTimeline({ execution, cards: [card(1), card(2), card(3, null)] }).rows
  expect(stepForRow(execution, rows, 'card-3-3')).toBe('write')
  expect(rowsForStep(execution, rows, 'write')).toEqual(['round-1', 'card-1-1', 'round-3', 'card-3-3'])
  expect(stepForRow(execution, rows, 'start')).toBeNull()
})

it('keeps labels clear of the current agent’s doing band without moving any card or route', () => {
  const execution = run([round(1, 'review', 'seed', false, ['beta'])])
  const layout = flowLayout(flowModel(execution.document.flow))
  const before = structuredClone(layout)
  const labels = flowOverlayLabels(layout, draw(execution, [card(1, null)]))
  const node = layout.nodes.find(node => node.id === 'review')!.box
  const centre = node.x + node.w / 2
  const width = Math.min(320, 2 * centre, 2 * (layout.width - centre))
  const band = { x: centre - width / 2, y: node.y + node.h + FLOW_LABEL_H, w: width, h: FLOW_LABEL_H }
  expect([...labels.values()].filter(label => label.x - label.w / 2 < band.x + band.w && band.x < label.x + label.w / 2 && label.y - label.h / 2 < band.y + band.h && band.y < label.y + label.h / 2)).toEqual([])
  expect(layout).toEqual(before)
  expect(flowOverlayLabels(layout, draw(run([])))).toEqual(new Map(layout.edges.flatMap(edge => edge.label ? [[edge.id, edge.label]] : [])))
})
