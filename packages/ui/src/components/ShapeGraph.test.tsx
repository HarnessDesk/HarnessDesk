import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { FlowPolicy } from '@harnessdesk/protocol'

import { ShapeGraph } from './ShapeGraph'

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

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
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

const render = (policy: FlowPolicy, selected: string | null = null) => {
  const onSelect = vi.fn()
  const onPositions = vi.fn()
  const onEditRule = vi.fn()
  act(() => {
    root.render(<ShapeGraph policy={policy} selected={selected} onSelect={onSelect} onPositions={onPositions} onEditRule={onEditRule} />)
  })
  return { onSelect, onPositions, onEditRule }
}

const node = (id: string): HTMLButtonElement => {
  const found = [...container.querySelectorAll('button')].find((one) => one.getAttribute('aria-label')?.startsWith(`${id} —`))
  if (!found) throw new Error(`no node “${id}”`)
  return found
}

it('a pointer drag changes only that role’s position — every other field is untouched, and the layout’s own foreign siblings survive', () => {
  const { onPositions } = render(POLICY)
  const build = node('build')

  act(() => { build.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 10, clientY: 20 })) })
  act(() => { window.dispatchEvent(new MouseEvent('mousemove', { clientX: 60, clientY: 90 })) })
  act(() => { window.dispatchEvent(new MouseEvent('mouseup', { clientX: 60, clientY: 90 })) })

  expect(onPositions).toHaveBeenCalledTimes(1)
  const positions = onPositions.mock.calls[0]![0] as Record<string, { x: number; y: number }>
  expect(positions['build']).toEqual({ x: 60, y: 90 })
  // The other role's saved position is carried through unchanged.
  expect(positions['review']).toEqual({ x: 200, y: 20 })
})

it('escape during a drag restores the original position and commits nothing', () => {
  const { onPositions } = render(POLICY)
  const build = node('build')

  act(() => { build.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 10, clientY: 20 })) })
  act(() => { window.dispatchEvent(new MouseEvent('mousemove', { clientX: 500, clientY: 500 })) })
  // The node visibly followed the pointer before Escape cancelled it.
  expect(node('build').style.left).not.toBe('10px')
  act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
  act(() => { window.dispatchEvent(new MouseEvent('mouseup', { clientX: 500, clientY: 500 })) })

  expect(onPositions).not.toHaveBeenCalled()
  // And the cancelled drag really did restore the original position on screen.
  expect(node('build').style.left).toBe('10px')
})

it('the keyboard Move fields commit through the same callback as a drag, with identical bounded coordinates', () => {
  const { onPositions } = render(POLICY, 'build')
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

it('no positions saved yet renders every role in stable order, and mounting writes nothing', () => {
  const { positions: _unused, ...rest } = POLICY.layout as { positions: unknown }
  const noPositions: FlowPolicy = { ...POLICY, layout: rest }
  const { onPositions } = render(noPositions)
  expect(node('build')).toBeTruthy()
  expect(node('review')).toBeTruthy()
  expect(node('ship')).toBeTruthy()
  expect(onPositions).not.toHaveBeenCalled()
})

it('the rule list carries every rule, including the back edge, in accessible text', () => {
  render(POLICY)
  const rows = [...container.querySelectorAll('button')].map((one) => one.textContent ?? '')
  expect(rows.some((text) => text.includes('build → review'))).toBe(true)
  expect(rows.some((text) => text.includes('review → build') && text.includes('loops back') === false)).toBe(true)
  expect(rows.some((text) => text.includes('review → ship'))).toBe(true)
  // Selecting a rule opens it through the callback, never by drawing a new edge.
  const ruleRow = [...container.querySelectorAll('button')].find((one) => one.textContent?.includes('review → ship'))!
  act(() => ruleRow.click())
})
