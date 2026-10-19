import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { FlowPolicy } from '@harnessdesk/protocol'

import * as design from '../index'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const policy: FlowPolicy = {
  version: 2, name: 'Review and fix', inputs: [], messaging: 'board-only', wait: 240,
  roles: [
    { id: 'review', kind: 'agent', uses: ['reviewer'], seats: [], isolate: false, grant: 'read', independentOf: [] },
    { id: 'fix', kind: 'agent', uses: ['builder'], seats: [], isolate: false, grant: 'edit', independentOf: [] },
    { id: 'report', kind: 'person', outcomes: ['done'] },
  ],
  seed: { role: 'review', title: 'Review the change' },
  rules: [
    { id: 'changes', on: 'review', when: { every: ['changes'] }, then: { role: 'fix', title: 'Fix the change' } },
    { id: 'retry', on: 'fix', then: { role: 'review', title: 'Review again' } },
    { id: 'approved', on: 'review', when: { every: ['approve'] }, then: { role: 'report', title: 'Report' } },
  ],
}

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

it('opens a named selectable card while keeping its origin, complete summary and Run count', () => {
  expect(design.FlowCard).toBeTypeOf('function')
  const open = vi.fn()
  const summary = 'Review and Fix repeat up to three rounds, then ask the person to confirm.'
  act(() => root.render(<design.FlowCard name={policy.name} origin="Built in" policy={policy} summary={summary} runs={4} selected onClick={open} />))
  const card = host.querySelector<HTMLButtonElement>('button')!
  expect(card.getAttribute('aria-label')).toBe('Open Review and fix')
  expect(card.getAttribute('aria-pressed')).toBe('true')
  expect(card.dataset.selected).toBe('true')
  expect(card.textContent).toContain('Built in')
  expect(card.textContent).toContain(summary)
  expect(card.textContent).toContain('4 matching Runs')
  expect(card.querySelector('[data-slot="flow-card-summary"]')?.getAttribute('title')).toBeNull()
  act(() => card.click())
  expect(open).toHaveBeenCalledOnce()
})

it('refuses disabled cards and distinguishes omitted, zero and singular Run counts', () => {
  expect(design.FlowCard).toBeTypeOf('function')
  const open = vi.fn()
  for (const runs of [undefined, 0, 1]) {
    act(() => root.render(<design.FlowCard name="Just a Team" origin="Built in" summary="A board and a chat." disabled runs={runs} onClick={open} />))
    const card = host.querySelector<HTMLButtonElement>('button')!
    expect(card.disabled).toBe(true)
    expect(card.getAttribute('aria-pressed')).toBe('false')
    expect(host.querySelector('[data-slot="flow-card-runs"]')?.textContent).toBe(runs === undefined ? undefined : runs === 1 ? '1 matching Run' : '0 matching Runs')
    act(() => card.click())
  }
  expect(open).not.toHaveBeenCalled()
})

it('keeps an unavailable Run count distinct from a known zero', () => {
  act(() => root.render(<design.FlowCard name="Review" origin="Built in" summary="Review the change." runs={null} onClick={() => {}} />))
  const count = host.querySelector('[data-slot="flow-card-runs"]')!
  expect(count.textContent).toBe('— matching Runs')
  expect(count.getAttribute('title')).toBe('The recorded Runs could not all be read yet.')
})

it('draws each policy role and the actual branching and loop rules with descriptive alternatives', () => {
  expect(design.FlowMiniGraph).toBeTypeOf('function')
  act(() => root.render(<design.FlowMiniGraph policy={policy} />))
  const graph = host.querySelector('svg[role="img"]')!
  expect([...graph.querySelectorAll('[data-step]')].map(step => step.getAttribute('data-step'))).toEqual(['review', 'fix', 'report'])
  expect([...graph.querySelectorAll('[data-edge]')].map(edge => edge.getAttribute('data-edge'))).toEqual(expect.arrayContaining(['review>fix', 'fix>review', 'review>report']))
  expect(graph.querySelector('[data-edge="fix>review"]')?.getAttribute('data-kind')).toBe('loop')
  expect(graph.getAttribute('aria-label')).toContain('Review')
  expect(graph.getAttribute('aria-label')).toContain('Fix')
  expect(graph.getAttribute('aria-label')).toContain('loops back')
  expect(graph.textContent).toContain('Review → Fix')
})

it('leaves an explicitly empty Team without invented Start or other steps', () => {
  expect(design.FlowMiniGraph).toBeTypeOf('function')
  for (const empty of [undefined, null, { ...policy, roles: [], rules: [] }]) {
    act(() => root.render(<design.FlowMiniGraph policy={empty} empty />))
    expect(host.querySelector('[data-step], [data-edge]')).toBeNull()
    expect(host.textContent).toContain('No steps')
    expect(host.querySelector('[role="img"]')?.getAttribute('aria-label')).toContain('No steps')
    expect(host.textContent).not.toContain('Start')
  }
})

it('distinguishes a missing or older-host graph from a Team known to have no steps', () => {
  for (const absent of [undefined, null]) {
    act(() => root.render(<design.FlowMiniGraph policy={absent} />))
    expect(host.textContent).toBe('Graph unavailable')
    expect(host.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Graph unavailable')
    expect(host.querySelector('[data-step], [data-edge]')).toBeNull()
  }
  act(() => root.render(<design.FlowCard name="Just a Team" origin="Built in" empty summary="Work together." onClick={() => {}} />))
  expect(host.textContent).toContain('No steps')
})

it('keeps one thumbnail viewport across topologies and gives long names an unclipped text alternative', () => {
  const long = 'competitor_accessibility_review'
  const wide: FlowPolicy = {
    ...policy, roles: [{ ...policy.roles[0]!, id: long }, policy.roles[1]!],
    seed: { role: long, title: 'Compare' },
    rules: [{ id: 'compare', on: long, then: { role: 'fix', title: 'Decide' } }],
  }
  const viewports = []
  for (const topology of [wide, policy]) {
    act(() => root.render(<design.FlowMiniGraph policy={topology} />))
    const graph = host.querySelector('svg')!
    viewports.push(graph.getAttribute('viewBox'))
    expect(graph.querySelector('clipPath')).toBeNull()
    for (const label of graph.querySelectorAll('[data-slot="flow-mini-label"]')) {
      expect(label.closest('[transform]')).toBeNull()
      expect(label.textContent).toBe(label.closest('[data-step]')?.querySelector('title')?.textContent)
    }
    expect(graph.querySelectorAll('[data-slot="flow-mini-label"]')).toHaveLength(topology.roles.length)
  }
  expect(viewports[0]).toBe(viewports[1])
})

it('draws every step the same width and gap on one centre line, whatever the labels or the topology', () => {
  const long = 'competitor_accessibility_review'
  const wide: FlowPolicy = {
    ...policy, roles: [{ ...policy.roles[0]!, id: long }, policy.roles[1]!],
    seed: { role: long, title: 'Compare' },
    rules: [{ id: 'compare', on: long, then: { role: 'fix', title: 'Decide' } }],
  }
  const read = (topology: FlowPolicy) => {
    act(() => root.render(<design.FlowMiniGraph policy={topology} />))
    const boxes = [...host.querySelectorAll('[data-step] rect')].map(rect => ({
      x: Number(rect.getAttribute('x')), y: Number(rect.getAttribute('y')), w: Number(rect.getAttribute('width')), h: Number(rect.getAttribute('height')) }))
    const left = Math.min(...boxes.map(box => box.x)), right = Math.max(...boxes.map(box => box.x + box.w))
    return { boxes, centre: (left + right) / 2 }
  }
  for (const topology of [wide, policy]) {
    const { boxes, centre } = read(topology)
    expect(new Set(boxes.map(box => box.w)).size).toBe(1)
    expect(new Set(boxes.map(box => box.h)).size).toBe(1)
    expect(centre).toBeCloseTo(160, 5)
  }
  // Steps on one row sit a single gap apart.
  const { boxes } = read(policy)
  const row = boxes.filter(box => box.y === boxes[0]!.y).sort((a, b) => a.x - b.x)
  expect(new Set(row.slice(1).map((box, index) => box.x - (row[index]!.x + row[index]!.w))).size).toBe(1)
})

it('keeps every card in the responsive card grid without imposing grid keyboard semantics', () => {
  expect(design.FlowCardGrid).toBeTypeOf('function')
  act(() => root.render(<design.FlowCardGrid><span>First</span><span>Second</span></design.FlowCardGrid>))
  const grid = host.querySelector('[data-slot="flow-card-grid"]')!
  expect(grid.textContent).toBe('FirstSecond')
  expect(grid.getAttribute('role')).toBeNull()
})

it('registers the shared Flow patterns with reachable examples and all public symbols', async () => {
  const { CATALOG_ENTRIES } = await import('../catalog/manifest')
  const cards = CATALOG_ENTRIES.find(entry => entry.id === 'pattern.FlowCards')
  expect(cards?.exampleId).toBe('flow-cards')
  expect(cards?.symbols).toEqual(['FlowCard', 'FlowMiniGraph', 'FlowCardGrid'])
  expect(cards?.states).toEqual(expect.arrayContaining(['selected', 'disabled', 'empty', 'long-title']))
  const toolbar = CATALOG_ENTRIES.find(entry => entry.id === 'pattern.FlowCanvasToolbar')
  expect(toolbar?.exampleId).toBe('flow-canvas-toolbar')
  expect(toolbar?.symbols).toEqual(['FlowCanvasToolbar'])
})
