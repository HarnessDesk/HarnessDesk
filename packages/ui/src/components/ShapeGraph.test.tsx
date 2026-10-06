import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { FlowPolicy } from '@harnessdesk/protocol'

import { defaultGraphPosition } from '../lib/shapes'
import { ShapeGraph } from './ShapeGraph'
import { canvasDOM } from '../test/flow-canvas-dom'

/**
 * The graph: the same roles and rules the ordered editor holds, drawn
 * spatially. Moving a node edits `layout.positions` alone — never role
 * order, count, seed, grants, guards, messaging or budget — and a loop
 * (a rule whose target is its own source) stays visible rather than being
 * forced into a one-way diagram.
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(async () => {
  canvasDOM()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await import('../design/patterns/FlowCanvas/Engine')
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

const POLICY: FlowPolicy = {
  version: 2, name: 'Loop', inputs: [], messaging: 'board-only', wait: 240,
  roles: [
    { id: 'build', kind: 'agent', uses: ['implementer'], seats: [], isolate: false, grant: 'edit', independentOf: [] },
    { id: 'review', kind: 'agent', uses: ['reviewer'], seats: [], isolate: false, grant: 'read', independentOf: ['build'] },
    { id: 'ship', kind: 'person', outcomes: ['shipped'] },
  ],
  rules: [
    { id: 'to-review', on: 'build', then: { role: 'review', title: 'Review' } },
    { id: 'back-to-build', on: 'review', when: { every: ['request-changes'] }, then: { role: 'build', title: 'Fix it' } },
    { id: 'to-ship', on: 'review', when: { every: ['approve'] }, then: { role: 'ship', title: 'Ship it' } },
  ],
  seed: { role: 'build', title: 'Go' },
  layout: { positions: { build: { x: 10, y: 20 }, review: { x: 200, y: 20 } }, frontDoor: { order: 1 }, foreign: ['kept'] },
}

const render = async (policy: FlowPolicy, selected: string | null = null) => {
  const onSelect = vi.fn()
  const onPositions = vi.fn()
  const onEditRule = vi.fn()
  await act(async () => {
    root.render(<ShapeGraph policy={policy} selected={selected} onSelect={onSelect} onPositions={onPositions} onEditRule={onEditRule} />)
  })
  await act(async () => { await vi.waitFor(() => expect(container.querySelector('.react-flow__node')).not.toBeNull()) })
  return { onSelect, onPositions, onEditRule }
}

const node = (id: string): HTMLElement => container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!

it('keyboard movement changes only that role’s position and retains other saved roles', async () => {
  const { onPositions } = await render(POLICY, 'build')
  act(() => node('build').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
  expect(onPositions).toHaveBeenCalledTimes(1)
  expect(onPositions.mock.calls[0]![0]).toEqual({ build: { x: 26, y: 20 }, review: { x: 200, y: 20 } })
})
it('selects a canvas step but refuses deletion, removal and connection affordances', async () => {
  const { onSelect, onPositions, onEditRule } = await render(POLICY, 'build')
  act(() => node('ship').click())
  expect(onSelect).toHaveBeenCalledWith('ship')
  act(() => node('build').dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })))
  expect(onPositions).not.toHaveBeenCalled()
  expect(onEditRule).not.toHaveBeenCalled()
  expect(container.querySelector('.react-flow__handle.connectable')).toBeNull()
  expect(container.querySelectorAll('.react-flow__node')).toHaveLength(3)
})

it('the keyboard Move fields commit through the same callback as a drag, with identical bounded coordinates', async () => {
  const { onPositions } = await render(POLICY, 'build')
  const horizontal = [...container.querySelectorAll('input[type="number"]')][0] as HTMLInputElement
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    setter.call(horizontal, '9999999')
    horizontal.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(onPositions).toHaveBeenCalledTimes(1)
  const positions = onPositions.mock.calls[0]![0] as Record<string, { x: number; y: number }>
  // Bounded to SHAPE_POSITION_LIMIT, the same clamp a drag's own commit uses.
  expect(positions['build']!.x).toBe(10000)
})

it('no positions saved yet renders every role in stable order, and mounting writes nothing', async () => {
  const { positions: _unused, ...rest } = POLICY.layout as { positions: unknown }
  const noPositions: FlowPolicy = { ...POLICY, layout: rest }
  const { onPositions } = await render(noPositions)
  expect(node('build')).toBeTruthy()
  expect(node('review')).toBeTruthy()
  expect(node('ship')).toBeTruthy()
  expect(onPositions).not.toHaveBeenCalled()
})

it('uses a default position when a role id matches an inherited object key', async () => {
  const constructorOnly: FlowPolicy = {
    ...POLICY,
    roles: [{ id: 'constructor', kind: 'person', outcomes: ['done'] }],
    rules: [],
    seed: { role: 'constructor', title: 'Go' },
    layout: {},
  }
  await render(constructorOnly)

  const expected = defaultGraphPosition(0)
  expect(node('constructor').style.transform).toBe(`translate(${expected.x}px,${expected.y}px)`)
})

it('the rule list carries every rule, including the back edge, in accessible text', async () => {
  const { onEditRule } = await render(POLICY)
  const rows = [...container.querySelectorAll('button')].map((one) => one.textContent ?? '')
  expect(rows.some((text) => text.includes('build → review'))).toBe(true)
  expect(rows.some((text) => text.includes('review → build') && text.includes('loops back') === false)).toBe(true)
  expect(rows.some((text) => text.includes('review → ship'))).toBe(true)
  // Selecting a rule opens it through the callback, never by drawing a new edge.
  const ruleRow = [...container.querySelectorAll('button')].find((one) => one.textContent?.includes('review → ship'))!
  act(() => ruleRow.click())
  expect(onEditRule).toHaveBeenCalledWith('to-ship')
})

it('the accessible step list under the canvas carries no "Steps" heading of its own — the Graph tab above it already says so', async () => {
  await render(POLICY)
  const headings = [...container.querySelectorAll('[data-slot="section-name"]')].map((one) => one.textContent?.trim())
  expect(headings).not.toContain('Steps')
  // The list itself is unaffected — every role is still there for a reader whose node is off screen.
  expect(container.querySelector('section[aria-label="Every step, for when a node is off screen"]')).not.toBeNull()
})
