import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import type { CeilingLevel, FlowAgentRole, FlowPolicy, FlowPolicyRole, FlowPolicyRule } from '@harnessdesk/protocol'

import { flowLayout } from '../../lib/flow-layout'
import { flowModel } from '../../lib/flow-model'
import { FlowGraph } from './FlowGraph'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const agent = (id: string, grant: CeilingLevel = 'read', over: Partial<FlowAgentRole> = {}): FlowAgentRole => ({
  id, kind: 'agent', uses: [`${id}-agent`], seats: [], isolate: false, grant, independentOf: [], ...over,
})
const check = (id: string, run: string): FlowPolicyRole => ({ id, kind: 'check', check: { run, timeout: 300, exits: { 0: 'pass' }, otherwise: 'fail' } })
const person = (id: string, outcomes: readonly string[]): FlowPolicyRole => ({ id, kind: 'person', outcomes })
const rule = (id: string, on: string, to: string, every?: readonly string[]): FlowPolicyRule => ({
  id, on, ...(every ? { when: { every } } : {}), then: { role: to, title: `Open ${to}` },
})
const policy = (roles: readonly FlowPolicyRole[], rules: readonly FlowPolicyRule[], over: Partial<FlowPolicy> = {}): FlowPolicy => ({
  version: 2, name: 'Write, review, land', inputs: [], roles, rules, seed: { role: roles[0]!.id, title: 'Go' }, messaging: 'board-only', wait: 240, ...over,
})

const blueprint = () => policy(
  [agent('write', 'edit'), check('check', 'pnpm verify'), agent('review', 'read', { count: 3 }), check('land', 'gh pr merge'), agent('fix', 'edit'), person('you', ['merged', 'dropped'])],
  [
    rule('r1', 'write', 'check'),
    rule('r2', 'check', 'review', ['passes']),
    rule('r3', 'review', 'land', ['approve']),
    rule('r4', 'review', 'fix', ['request-changes']),
    rule('r5', 'fix', 'check'),
    rule('r6', 'land', 'you', ['landed']),
  ],
)

const draw = (flow: FlowPolicy, holds?: ReadonlyMap<string, 'held' | 'asked'>) => {
  const model = flowModel(flow, holds ? { holds } : {})
  act(() => root.render(<FlowGraph model={model} />))
  return model
}
const stepsOf = () => [...container.querySelectorAll<HTMLElement>('[data-slot="flow-step"]')]

it('draws a card for each step, in the model\'s order, each saying what it is, its name and its one line', () => {
  draw(blueprint(), new Map([['write', 'asked']]))
  const steps = stepsOf()
  expect(steps.map((step) => step.dataset['step'])).toEqual(['write', 'check', 'review', 'land', 'fix', 'you'])
  expect(steps.map((step) => step.dataset['kind'])).toEqual(['agent', 'check', 'agent', 'check', 'agent', 'person'])
  expect(steps[0]!.textContent).toContain('Write')
  expect(steps[0]!.textContent).toContain('Edit · asked')
  expect(steps[1]!.textContent).toContain('pnpm verify')
  expect(steps[5]!.textContent).toContain('merged · dropped')
})

it('tints a step by its kind and draws every mark as the thing it is, not a face', () => {
  draw(blueprint())
  const tiles = stepsOf().map((step) => step.querySelector('[data-slot="icon-tile"]'))
  expect(tiles.map((tile) => tile?.getAttribute('data-tint'))).toEqual(['violet', 'sky', 'violet', 'sky', 'violet', 'amber'])
  expect(tiles.every((tile) => tile?.getAttribute('data-shape') === 'square')).toBe(true)
})

it('places each card where the layout puts it, in the drawing\'s own pixels', () => {
  const model = draw(blueprint())
  const layout = flowLayout(model)
  const stage = container.querySelector<HTMLElement>('[data-slot="flow-stage"]')!
  expect(stage.style.width).toBe(`${layout.width}px`)
  expect(stage.style.height).toBe(`${layout.height}px`)
  for (const node of layout.nodes) {
    const step = container.querySelector<HTMLElement>(`[data-step="${node.id}"]`)!
    expect([step.style.left, step.style.top, step.style.width, step.style.height])
      .toEqual([`${node.box.x}px`, `${node.box.y}px`, `${node.box.w}px`, `${node.box.h}px`])
  }
})

it('fans a step that opens several seats into cards behind the front one, which assistive technology skips', () => {
  draw(blueprint())
  const review = container.querySelector<HTMLElement>('[data-step="review"]')!
  const behind = review.querySelectorAll('[data-behind]')
  expect(behind).toHaveLength(2)
  expect([...behind].every((one) => one.getAttribute('aria-hidden') === 'true')).toBe(true)
  expect(container.querySelector('[data-step="write"]')!.querySelectorAll('[data-behind]')).toHaveLength(0)
})

it('draws a line with an arrowhead for each rule, and says a loop is one', () => {
  draw(blueprint())
  const edges = [...container.querySelectorAll<SVGGElement>('[data-slot="flow-edge"]')]
  expect(edges.map((edge) => `${edge.dataset['edge']}:${edge.dataset['kind']}`)).toEqual([
    'write>check:forward', 'check>review:forward', 'review>land:forward', 'review>fix:loop', 'fix>check:loop', 'land>you:forward',
  ])
  for (const edge of edges) {
    expect(edge.querySelector('path')?.getAttribute('d')).toMatch(/^M/)
    expect(edge.querySelector('polygon')?.getAttribute('points')?.split(' ')).toHaveLength(3)
  }
})

it('says the outcome word of a rule on its line, and marks a loop\'s word as a retry', () => {
  draw(blueprint())
  const words = [...container.querySelectorAll<HTMLElement>('[data-slot="flow-word"]')]
  expect(words.map((word) => word.textContent)).toEqual(['passes', 'approve', 'request-changes', 'landed'])
  expect(words.map((word) => word.hasAttribute('data-retry'))).toEqual([false, false, true, false])
  expect(words[2]!.querySelector('svg')).not.toBeNull()
  expect(words[0]!.querySelector('svg')).toBeNull()
})

it('draws no word for a rule nothing guards', () => {
  draw(policy([agent('write'), agent('review')], [rule('r1', 'write', 'review')]))
  expect(container.querySelectorAll('[data-slot="flow-word"]')).toHaveLength(0)
})

it('keeps the drawing out of the accessibility tree and gives the list to everyone, hidden by nothing but the width', () => {
  draw(blueprint())
  const drawing = container.querySelector<HTMLElement>('[data-slot="flow-drawing"]')!
  expect(drawing.getAttribute('aria-hidden')).toBe('true')
  expect(drawing.className).toContain('@max-[38rem]/flow:hidden')
  const list = container.querySelector<HTMLElement>('[data-slot="flow-list"]')!
  expect(list.closest('[aria-hidden="true"]')).toBeNull()
  expect(list.className).not.toContain('hidden')
  expect(container.querySelector('[data-slot="flow-graph"]')!.className).toContain('@container/flow')
})

it('lists every step and says what each is, so a screen reader reaches what the drawing shows', () => {
  draw(blueprint(), new Map([['write', 'held']]))
  const steps = container.querySelector<HTMLElement>('section[aria-label="Steps"]')!
  const rows = [...steps.querySelectorAll('[data-slot="row"]')]
  expect(rows).toHaveLength(6)
  expect(rows[0]!.textContent).toContain('Write')
  expect(rows[0]!.textContent).toContain('Agent')
  expect(rows[0]!.textContent).toContain('Edit · held')
  expect(rows[1]!.textContent).toContain('Check')
  expect(rows[1]!.textContent).toContain('pnpm verify')
  expect(rows[2]!.textContent).toContain('3 at once')
  expect(rows[5]!.textContent).toContain('Person')
})

it('lists every rule as a sentence, loops included, in the order the file wrote them', () => {
  draw(blueprint())
  const rules = container.querySelector<HTMLElement>('section[aria-label="Rules"]')!
  const rows = [...rules.querySelectorAll('[data-slot="row"]')]
  expect(rows.map((row) => row.querySelector('[data-slot="row-title"]')!.textContent)).toEqual([
    'Write → Check', 'Check → Review', 'Review → Land', 'Review → FixLoops back', 'Fix → CheckLoops back', 'Land → You',
  ])
  expect(rows[0]!.textContent).toContain('Whatever the outcome')
  expect(rows[1]!.textContent).toContain('When every answer says passes')
  expect(rows[3]!.textContent).toContain('When every answer says request-changes')
})

it('says so when a Flow has no rule, instead of an empty list', () => {
  draw(policy([agent('write')], []))
  const rules = container.querySelector<HTMLElement>('section[aria-label="Rules"]')!
  expect(rules.textContent).toContain('No rules')
})

it('draws a Flow with no steps as a sentence and nothing else', () => {
  act(() => root.render(<FlowGraph model={flowModel({ ...policy([agent('x')], []), roles: [] })} />))
  expect(container.querySelector('[data-slot="flow-step"]')).toBeNull()
  expect(container.textContent).toContain('This Flow has no steps')
})

it('keeps one dot grid for each drawing, so two on a page do not share a pattern', () => {
  act(() => root.render(<><FlowGraph model={flowModel(blueprint())} /><FlowGraph model={flowModel(blueprint())} /></>))
  const ids = [...container.querySelectorAll('pattern')].map((pattern) => pattern.id)
  expect(ids).toHaveLength(2)
  expect(new Set(ids).size).toBe(2)
  for (const id of ids) {
    expect(container.querySelector(`rect[fill="url(#${id})"]`)).not.toBeNull()
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/)
  }
})

it('takes every colour from a token', () => {
  draw(blueprint())
  // The drawing's own marks: the lines, the arrowheads and the dots. (A glyph inside a card is an icon's, and reads `currentColor`.)
  const colours = [...container.querySelectorAll('[data-slot="flow-stage"] > svg [stroke], [data-slot="flow-stage"] > svg [fill]')]
    .flatMap((node) => [node.getAttribute('stroke'), node.getAttribute('fill')])
    .filter((value): value is string => value !== null && value !== 'none' && !value.startsWith('url('))
  expect(colours.length).toBeGreaterThan(0)
  expect(colours.every((value) => value.startsWith('var(--hd-'))).toBe(true)
})

it('draws a Flow from the position its file gave, and says nothing about it', () => {
  const model = draw(policy(
    [agent('write'), agent('review')],
    [rule('r1', 'write', 'review')],
    { layout: { positions: { write: { x: 300, y: 40 }, review: { x: 40, y: 40 } } } },
  ))
  const write = container.querySelector<HTMLElement>('[data-step="write"]')!
  const review = container.querySelector<HTMLElement>('[data-step="review"]')!
  expect(parseFloat(write.style.left)).toBeGreaterThan(parseFloat(review.style.left))
  expect(container.textContent).not.toContain('layout')
  expect(model.positions['write']).toEqual({ x: 300, y: 40 })
})
