import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { FlowPolicy } from '@harnessdesk/protocol'

import * as design from '../index'
// The host parser is used only by this test; the renderer never imports it.
import { parseFlowPolicy } from '../../../../server/dist/src/flow-policy.js'

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

it('keeps a selected Flow compact with its actual graph, origin and Change action', () => {
  expect(design.SelectedFlow).toBeTypeOf('function')
  const change = vi.fn()
  act(() => root.render(<design.SelectedFlow name={policy.name} origin="Project" policy={policy} onChange={change} />))
  const summary = host.querySelector('[data-slot="selected-flow"]')!
  expect(summary.textContent).toContain(policy.name)
  expect(summary.textContent).toContain('Project')
  expect(summary.querySelectorAll('[data-step]')).toHaveLength(policy.roles.length)
  const button = summary.querySelector<HTMLButtonElement>('button')!
  expect(button.textContent).toBe('Change')
  act(() => button.click())
  expect(change).toHaveBeenCalledOnce()
  act(() => root.render(<design.SelectedFlow name="Just a Team" origin="Built in" empty disabled onChange={change} />))
  expect(host.querySelector('[data-step]')).toBeNull()
  expect(host.textContent).toContain('No steps')
  expect(host.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true)
})

it('keeps a selected Flow reading state distinct from a settled unavailable graph', () => {
  const change = vi.fn()
  act(() => root.render(<design.SelectedFlow name={policy.name} origin="Project" loading onChange={change} />))
  const selection = host.querySelector('[data-slot="selected-flow"]')!
  expect(selection.getAttribute('aria-busy')).toBe('true')
  const thumbnail = selection.querySelector('[data-slot="flow-mini-graph"]')!
  expect(thumbnail.getAttribute('role')).toBe('status')
  expect(thumbnail.textContent).toBe('Reading Flow…')
  expect(selection.textContent).not.toContain('Graph unavailable')
  expect(selection.querySelector('[data-step]')).toBeNull()

  act(() => root.render(<design.SelectedFlow name={policy.name} origin="Project" policy={policy} onChange={change} />))
  expect(host.querySelector('[data-slot="selected-flow"]')?.hasAttribute('aria-busy')).toBe(false)
  expect(host.querySelector('[role="status"]')).toBeNull()
  expect(host.querySelectorAll('[data-step]')).toHaveLength(policy.roles.length)
  expect(host.textContent).not.toContain('Graph unavailable')

  act(() => root.render(<design.SelectedFlow name={policy.name} origin="Project" onChange={change} />))
  expect(host.textContent).toContain('Graph unavailable')
  expect(host.querySelector('[data-slot="selected-flow"]')?.hasAttribute('aria-busy')).toBe(false)
  expect(host.querySelector('[data-slot="flow-mini-graph"]')?.className).toBe(thumbnail.className)
})

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
    expect(host.querySelector('[data-slot="flow-card-runs"]')?.textContent).toBe(runs === undefined || runs === 0 ? undefined : '1 matching Run')
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
    const boxes = [...host.querySelectorAll('[data-step] > rect')].map(rect => ({
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

/** A Flow of `count` agents in a line, then whatever extra rules and positions the case adds. */
const flowOf = (count: number, rules: readonly [string, string][] = [], positions?: Record<string, { x: number; y: number }>, extra: readonly string[] = []): FlowPolicy => {
  const ids = [...Array.from({ length: count }, (_, index) => `s${index}`), ...extra]
  return {
    version: 2, name: 'Shape', inputs: [], messaging: 'board-only', wait: 240,
    roles: ids.map(id => ({ id, kind: 'agent' as const, uses: [`${id}-agent`], seats: [], isolate: false, grant: 'read' as const, independentOf: [] })),
    seed: { role: 's0', title: 'Go' },
    rules: [
      ...Array.from({ length: count - 1 }, (_, index) => ({ id: `line${index}`, on: `s${index}`, then: { role: `s${index + 1}`, title: 'Next' } })),
      ...rules.map(([on, to], index) => ({ id: `extra${index}`, on, then: { role: to, title: 'Then' } })),
    ],
    ...(positions ? { layout: { positions } } : {}),
  }
}

/** What the thumbnail draws, in the viewport's own units: every card and every sampled point of every line, after any fit-scaling. */
const drawn = (topology: FlowPolicy, previewSize: 'compact' | 'large' = 'compact') => {
  act(() => root.render(<design.FlowMiniGraph policy={topology} previewSize={previewSize} />))
  const svg = host.querySelector('svg')!
  const transform = svg.querySelector(':scope > g')!.getAttribute('transform')
  const scale = transform ? Number(/scale\(([\d.]+)\)/.exec(transform)![1]) : 1
  const centre = previewSize === 'large' ? { x: 224, y: 40 } : { x: 160, y: 36 }
  const fit = (x: number, y: number) => ({ x: centre.x + (x - centre.x) * scale, y: centre.y + (y - centre.y) * scale })
  const points: { x: number; y: number }[] = [], boxes: { x: number; y: number; w: number; h: number }[] = []
  for (const rect of svg.querySelectorAll('[data-step] > rect')) {
    const [x, y, w, h] = ['x', 'y', 'width', 'height'].map(name => Number(rect.getAttribute(name)))
    boxes.push({ x: x!, y: y!, w: w!, h: h! })
    points.push(fit(x!, y!), fit(x! + w!, y! + h!))
  }
  for (const path of svg.querySelectorAll('[data-edge] path')) {
    let at = { x: 0, y: 0 }
    for (const [, command, rest] of path.getAttribute('d')!.matchAll(/([MCHV])([^MCHV]*)/g)) {
      const n = rest!.trim().split(/[\s,]+/).map(Number)
      if (command === 'M') { at = { x: n[0]!, y: n[1]! }; points.push(fit(at.x, at.y)) }
      else if (command === 'H') { at = { x: n[0]!, y: at.y }; points.push(fit(at.x, at.y)) }
      else if (command === 'V') { at = { x: at.x, y: n[0]! }; points.push(fit(at.x, at.y)) }
      else {
        const [a, b, c, d, e, f] = n as [number, number, number, number, number, number]
        for (let t = 0; t <= 1; t += 0.1) {
          const u = 1 - t
          points.push(fit(u ** 3 * at.x + 3 * u * u * t * a + 3 * u * t * t * c + t ** 3 * e, u ** 3 * at.y + 3 * u * u * t * b + 3 * u * t * t * d + t ** 3 * f))
        }
        at = { x: e, y: f }
      }
    }
  }
  return { boxes, points, scale, width: svg.querySelector('[data-step] > rect')!.getAttribute('width') }
}
const within = (points: readonly { x: number; y: number }[], width = 320, height = 72) => {
  for (const point of points) {
    expect(point.x).toBeGreaterThanOrEqual(0); expect(point.x).toBeLessThanOrEqual(width)
    expect(point.y).toBeGreaterThanOrEqual(0); expect(point.y).toBeLessThanOrEqual(height)
  }
}
const apart = (boxes: readonly { x: number; y: number; w: number; h: number }[]) => {
  for (const [index, a] of boxes.entries()) for (const b of boxes.slice(index + 1)) {
    expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).toBe(false)
  }
}

it('keeps a Flow whose cards were dragged inside the thumbnail, one row where they are level to within half a card', () => {
  const level = drawn(flowOf(4, [], { s0: { x: 40, y: 40 }, s1: { x: 270, y: 52 }, s2: { x: 520, y: 30 }, s3: { x: 760, y: 61 } }))
  expect(new Set(level.boxes.map(box => box.y)).size).toBe(1)
  within(level.points); apart(level.boxes)
  // Cards dragged to three bands of their own still fit, drawn apart.
  const three = drawn(flowOf(4, [], { s0: { x: 40, y: 40 }, s1: { x: 270, y: 240 }, s2: { x: 520, y: 440 }, s3: { x: 760, y: 40 } }))
  expect(new Set(three.boxes.map(box => box.y)).size).toBe(3)
  within(three.points); apart(three.boxes)
})

it('draws a branch and a step nothing reaches in three rows without cutting any off', () => {
  const branched = drawn(flowOf(3, [['s0', 'b'], ['b', 's2']], undefined, ['b', 'c']))
  within(branched.points); apart(branched.boxes)
})

it('puts a step only a loop reaches between the main road\'s columns, with no empty column and every line in view', () => {
  const loop = flowOf(4, [['s2', 'fix'], ['fix', 's1']], undefined, ['fix'])
  const { boxes, points } = drawn(loop)
  const top = boxes.filter(box => box.y === Math.min(...boxes.map(one => one.y))).sort((a, b) => a.x - b.x)
  expect(top).toHaveLength(4)
  expect(new Set(top.slice(1).map((box, index) => box.x - (top[index]!.x + top[index]!.w))).size).toBe(1)
  const fix = boxes.find(box => box.y > top[0]!.y)!
  expect(fix.x + fix.w / 2).toBeGreaterThan(top[1]!.x + top[1]!.w / 2)
  expect(fix.x + fix.w / 2).toBeLessThan(top[2]!.x + top[2]!.w / 2)
  within(points); apart(boxes)
  // A loop along a lower row that dips under it stays in view too.
  within(drawn(flowOf(3, [['b', 'a'], ['s1', 'a'], ['a', 'b']], undefined, ['a', 'b'])).points)
})

it('never draws a step with a width below its floor: a long Flow is scaled to fit rather than overlapped', () => {
  const long = drawn(flowOf(16))
  expect(Number(long.width)).toBeGreaterThanOrEqual(40)
  expect(long.scale).toBeLessThan(1)
  within(long.points); apart(long.boxes)
})

it('draws a step that returns to itself as an arc beside it, not a tick', () => {
  drawn(flowOf(3, [['s1', 's1']]))
  const loop = host.querySelector<SVGPathElement>('[data-edge="s1>s1"] path')!
  const numbers = loop.getAttribute('d')!.match(/-?\d+(\.\d+)?/g)!.map(Number)
  const ys = numbers.filter((_, index) => index % 2 === 1), xs = numbers.filter((_, index) => index % 2 === 0)
  expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThanOrEqual(8)
  expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(3)
  within(drawn(flowOf(3, [['s1', 's1']])).points)
})

it('keeps a self-loop and its arrowhead clear of the adjacent forward arrow and inside the viewport', () => {
  const positions = { s0: { x: 40, y: 40 }, s1: { x: 270, y: 40 }, s2: { x: 520, y: 40 },
    a: { x: 40, y: 240 }, b: { x: 270, y: 440 } }
  for (const size of ['compact', 'large'] as const) for (const multirow of [false, true]) {
    const topology = flowOf(3, [['s1', 's1']], multirow ? positions : undefined, multirow ? ['a', 'b'] : [])
    const { points, scale } = drawn(topology, size)
    const svg = host.querySelector('svg')!
    const loop = svg.querySelector('[data-edge="s1>s1"] path')!.getAttribute('d')!
    const coords = loop.match(/-?\d+(?:\.\d+)?/g)!.map(Number)
    expect(coords).toHaveLength(8) // one cubic, sampled below in rendered coordinates
    const [x0, y0, x1, y1, x2, y2, x3, y3] = coords as [number, number, number, number, number, number, number, number]
    const forward = svg.querySelector('[data-edge="s1>s2"] path')!.getAttribute('d')!
    const forwardY = Number(/^M[-\d.]+ ([-\d.]+)H/.exec(forward)![1])
    const head = svg.querySelector('[data-edge="s1>s1"] polygon')!.getAttribute('points')!.trim().split(/[\s,]+/).map(Number)
    const centre = size === 'large' ? { x: 224, y: 40 } : { x: 160, y: 36 }
    const fit = (x: number, y: number) => ({ x: centre.x + (x - centre.x) * scale, y: centre.y + (y - centre.y) * scale })
    const loopPoints = []
    for (let i = 0; i <= 100; i++) {
      const t = i / 100, u = 1 - t
      loopPoints.push({ x: u ** 3 * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t ** 3 * x3,
        y: u ** 3 * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t ** 3 * y3 })
    }
    for (let i = 0; i < head.length; i += 2) loopPoints.push({ x: head[i]!, y: head[i + 1]! })
    // Include the arrowhead, and leave space for the strokes on both routes.
    expect(Math.max(...loopPoints.map(point => point.y))).toBeLessThan(forwardY - 1)
    within([...points, ...loopPoints.map(point => fit(point.x, point.y))], size === 'large' ? 448 : 320, size === 'large' ? 80 : 72)
    if (multirow) expect(Number(svg.querySelector('[data-step="s1"] rect')!.getAttribute('height'))).toBe(size === 'large' ? 36 : 16)
  }
})

it('fits lower-row loops in their own row gap without reserving empty space above the graph', () => {
  for (const size of ['compact', 'large'] as const) for (const rows of [2, 3] as const) {
    const positions = { s0: { x: 270, y: 40 }, s1: { x: 270, y: 240 }, s2: { x: 520, y: 240 },
      s3: { x: 760, y: rows === 3 ? 440 : 240 } }
    const { points, scale, boxes } = drawn(flowOf(4, [['s1', 's1']], positions), size)
    const svg = host.querySelector('svg')!
    const lower = svg.querySelector('[data-step="s1"] rect')!, upper = svg.querySelector('[data-step="s0"] rect')!
    const y = (rect: Element) => Number(rect.getAttribute('y'))
    const h = (rect: Element) => Number(rect.getAttribute('height'))
    const path = svg.querySelector('[data-edge="s1>s1"] path')!.getAttribute('d')!
    const n = path.match(/-?\d+(?:\.\d+)?/g)!.map(Number)
    expect(n).toHaveLength(8)
    const sampled = Array.from({ length: 1001 }, (_, i) => {
      const t = i / 1000, u = 1 - t
      return { x: u ** 3 * n[0]! + 3 * u * u * t * n[2]! + 3 * u * t * t * n[4]! + t ** 3 * n[6]!,
        y: u ** 3 * n[1]! + 3 * u * u * t * n[3]! + 3 * u * t * t * n[5]! + t ** 3 * n[7]! }
    })
    const head = svg.querySelector('[data-edge="s1>s1"] polygon')!.getAttribute('points')!.trim().split(/[\s,]+/).map(Number)
    for (let i = 0; i < head.length; i += 2) sampled.push({ x: head[i]!, y: head[i + 1]! })
    const forward = svg.querySelector('[data-edge="s1>s2"] path')!.getAttribute('d')!
    const forwardY = Number(/^M[-\d.]+ ([-\d.]+)H/.exec(forward)![1])
    expect(Math.max(...sampled.map(point => point.y))).toBeLessThan(forwardY - 1)
    // One unit clears the two half-unit strokes of the upper card and loop.
    expect(Math.min(...sampled.map(point => point.y)) - (y(upper) + h(upper))).toBeGreaterThanOrEqual(1)
    const centre = size === 'large' ? { x: 224, y: 40 } : { x: 160, y: 36 }
    within([...points, ...sampled.map(point => ({ x: centre.x + (point.x - centre.x) * scale, y: centre.y + (point.y - centre.y) * scale }))], size === 'large' ? 448 : 320, size === 'large' ? 80 : 72)
    apart(boxes)
    expect(y(lower)).toBeGreaterThan(y(upper))
    // The graph fits its actual rows and gaps, without a top margin for a lower loop.
    const height = rows * h(lower) + (rows - 1) * (rows === 2 ? 16 : 8)
    expect(scale).toBeCloseTo(Math.min(1, (size === 'large' ? 72 : 64) / height), 8)
  }
})

type Point = { x: number; y: number }
const cubicPoints = (path: string): Point[] => {
  const n = path.match(/-?\d+(?:\.\d+)?/g)!.map(Number)
  expect(n).toHaveLength(8)
  return Array.from({ length: 401 }, (_, i) => {
    const t = i / 400, u = 1 - t
    return { x: u ** 3 * n[0]! + 3 * u * u * t * n[2]! + 3 * u * t * t * n[4]! + t ** 3 * n[6]!,
      y: u ** 3 * n[1]! + 3 * u * u * t * n[3]! + 3 * u * t * t * n[5]! + t ** 3 * n[7]! }
  })
}
const polygonPoints = (points: string): Point[] => {
  const n = points.trim().split(/[\s,]+/).map(Number)
  const vertices = Array.from({ length: n.length / 2 }, (_, i) => ({ x: n[i * 2]!, y: n[i * 2 + 1]! }))
  return [...vertices, vertices[0]!]
}
const pointSegment = (p: Point, a: Point, b: Point): number => {
  const dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy
  const t = length ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy)
}
const segmentDistance = (a: Point, b: Point, c: Point, d: Point): number => {
  const cross = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
  const a1 = cross(a, b, c), a2 = cross(a, b, d), b1 = cross(c, d, a), b2 = cross(c, d, b)
  if (a1 * a2 < 0 && b1 * b2 < 0) return 0
  return Math.min(pointSegment(a, c, d), pointSegment(b, c, d), pointSegment(c, a, b), pointSegment(d, a, b))
}
const lineDistance = (a: Point[], b: Point[]): number => {
  let distance = Infinity
  for (let i = 1; i < a.length; i++) for (let j = 1; j < b.length; j++) distance = Math.min(distance, segmentDistance(a[i - 1]!, a[i]!, b[j - 1]!, b[j]!))
  return distance
}
const routePoints = (path: string): Point[] => {
  if (path.includes('C')) return cubicPoints(path)
  let at: Point = { x: 0, y: 0 }
  const points: Point[] = []
  for (const [, command, rest] of path.matchAll(/([MHV])([^MHV]*)/g)) {
    const n = rest!.trim().split(/[\s,]+/).map(Number)
    at = command === 'M' ? { x: n[0]!, y: n[1]! } : command === 'H' ? { x: n[0]!, y: at.y } : { x: at.x, y: n[0]! }
    points.push(at)
  }
  return points
}

it('starts the self-loop inside the rounded card and carries it across the visible outline', () => {
  for (const size of ['compact', 'large'] as const) for (const rows of [1, 2, 3] as const) {
    const positions = rows === 1 ? undefined : { s0: { x: 270, y: 40 }, s1: { x: 270, y: 240 }, s2: { x: 520, y: 240 },
      s3: { x: 760, y: rows === 3 ? 440 : 240 } }
    drawn(flowOf(4, [['s1', 's1']], positions), size)
    const rect = host.querySelector('[data-step="s1"] rect')!, path = host.querySelector('[data-edge="s1>s1"] path')!
    const x = Number(rect.getAttribute('x')), y = Number(rect.getAttribute('y'))
    const w = Number(rect.getAttribute('width')), h = Number(rect.getAttribute('height'))
    // The product's --hd-radius is 10px; SVG clamps each radius to half the corresponding dimension.
    const rx = Math.min(10, w / 2), ry = Math.min(10, h / 2)
    const inside = (point: Point) => {
      if (point.x < x || point.x > x + w || point.y < y || point.y > y + h) return false
      const cx = Math.max(x + rx, Math.min(x + w - rx, point.x))
      const cy = Math.max(y + ry, Math.min(y + h - ry, point.y))
      return ((point.x - cx) / rx) ** 2 + ((point.y - cy) / ry) ** 2 <= 1
    }
    const curve = cubicPoints(path.getAttribute('d')!)
    expect(inside(curve[0]!)).toBe(true)
    expect(curve.some(point => !inside(point))).toBe(true)
    // The card masks the internal part; the visible curve meets its outline.
    expect(path.compareDocumentPosition(rect) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  }
})

it('separates a self-loop and an outgoing skip including both arrowheads', () => {
  for (const size of ['compact', 'large'] as const) for (const lower of [false, true]) for (const count of [4, 8]) {
    const positions = lower ? Object.fromEntries(Array.from({ length: count }, (_, i) => [`s${i}`, { x: 40 + i * 250, y: i === 0 ? 40 : 240 }])) : undefined
    const { points, scale } = drawn(flowOf(count, [['s1', 's1'], ['s1', 's3']], positions), size)
    const svg = host.querySelector('svg')!
    const edge = (id: string) => {
      const group = svg.querySelector(`[data-edge="${id}"]`)!
      return [cubicPoints(group.querySelector('path')!.getAttribute('d')!), polygonPoints(group.querySelector('polygon')!.getAttribute('points')!)]
    }
    const loop = edge('s1>s1'), skip = edge('s1>s3')
    const distance = Math.min(...loop.flatMap(a => skip.map(b => lineDistance(a!, b!))))
    expect(distance).toBeGreaterThanOrEqual(1)
    const centre = size === 'large' ? { x: 224, y: 40 } : { x: 160, y: 36 }
    const scaled = [...loop, ...skip].flat().map(point => ({ x: centre.x + (point.x - centre.x) * scale, y: centre.y + (point.y - centre.y) * scale }))
    within([...points, ...scaled], size === 'large' ? 448 : 320, size === 'large' ? 80 : 72)
  }
})

it('keeps the self-loop clear of neighboring, skip, reverse and between-row routes', () => {
  const positions = { s0: { x: 250, y: 40 }, up: { x: 500, y: 40 }, upRight: { x: 750, y: 40 },
    farleft: { x: 0, y: 240 }, left: { x: 250, y: 240 }, loop: { x: 500, y: 240 }, right: { x: 750, y: 240 },
    farright: { x: 1000, y: 240 }, down: { x: 500, y: 440 }, downRight: { x: 750, y: 440 } }
  const others: [string, string][] = [['loop', 'right'], ['loop', 'farright'], ['farleft', 'loop'], ['loop', 'left'], ['right', 'loop'],
    ['loop', 'up'], ['down', 'loop'], ['up', 'loop'], ['loop', 'down'], ['loop', 'upRight'], ['downRight', 'loop'], ['upRight', 'loop'], ['loop', 'downRight']]
  for (const size of ['compact', 'large'] as const) {
    const { points } = drawn(flowOf(1, [['loop', 'loop'], ...others], positions, Object.keys(positions).filter(id => id !== 's0')), size)
    const edge = (id: string) => {
      const group = host.querySelector(`[data-edge="${id}"]`)!
      expect(group).not.toBeNull()
      return [routePoints(group.querySelector('path')!.getAttribute('d')!), polygonPoints(group.querySelector('polygon')!.getAttribute('points')!)]
    }
    const loop = edge('loop>loop')
    const distances = others.map(([from, to]) => {
      const route = edge(`${from}>${to}`)
      return [`${from}>${to}`, Math.min(...loop.flatMap(a => route.map(b => lineDistance(a!, b!))))] as const
    })
    for (const [, distance] of distances) expect(distance).toBeGreaterThanOrEqual(1)
    within(points, size === 'large' ? 448 : 320, size === 'large' ? 80 : 72)
    const originalRoutes = new Map(others.map(([from, to]) => {
      const group = host.querySelector(`[data-edge="${from}>${to}"]`)!
      return [`${from}>${to}`, [group.querySelector('path')!.getAttribute('d'), group.querySelector('polygon')!.getAttribute('points')]] as const
    }))
    // Moving the self-loop to another cell leaves every unrelated route intact.
    drawn(flowOf(1, [['left', 'left'], ...others], positions, Object.keys(positions).filter(id => id !== 's0')), size)
    for (const [id, original] of originalRoutes) {
      const group = host.querySelector(`[data-edge="${id}"]`)!
      const current = [group.querySelector('path')!.getAttribute('d'), group.querySelector('polygon')!.getAttribute('points')]
      if (id === 'downRight>loop' || id === 'upRight>loop') expect(current).not.toEqual(original)
      else expect(current).toEqual(original)
    }
  }
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
  expect(cards?.sizes).toEqual(['compact', 'large'])
  expect(cards?.symbolAxes?.FlowCardGrid?.size).toEqual(['compact', 'large'])
  expect(cards?.symbols).toEqual(['FlowCard', 'FlowMiniGraph', 'FlowCardGrid', 'SelectedFlow'])
  expect(cards?.states).toEqual(expect.arrayContaining(['selected', 'disabled', 'empty', 'long-title', 'loading']))
  const toolbar = CATALOG_ENTRIES.find(entry => entry.id === 'pattern.FlowCanvasToolbar')
  expect(toolbar?.exampleId).toBe('flow-canvas-toolbar')
  expect(toolbar?.symbols).toEqual(['FlowCanvasToolbar'])
})

it('gives thumbnail roles their canonical agent, person and command marks without losing their names', () => {
  const kinds: FlowPolicy = {
    ...policy,
    roles: [policy.roles[0]!, { id: 'decide', kind: 'person', outcomes: ['approve'] }, { id: 'verify', kind: 'check', check: { run: 'pnpm test', timeout: 60, exits: { '0': 'pass' }, otherwise: 'fail' } }],
    rules: [],
  }
  act(() => root.render(<design.FlowMiniGraph policy={kinds} />))
  expect(host.querySelector('[data-slot="icon-tile"], [data-tint]')).toBeNull()
  for (const [id, kind, icon] of [['review', 'agent', 'bot'], ['decide', 'person', 'user'], ['verify', 'check', 'square-terminal']]) {
    const step = host.querySelector(`[data-step="${id}"]`)!
    expect(step.getAttribute('data-kind')).toBe(kind)
    expect(step.querySelector(`[data-slot="flow-mini-mark"] .lucide-${icon}`)).not.toBeNull()
    expect(step.querySelector('[data-slot="flow-mini-label"]')?.textContent).toBe(step.querySelector('title')?.textContent)
  }
})

it('offers a roomy gallery poster while leaving the quick picker compact by default', () => {
  for (const previewSize of [undefined, 'large'] as const) {
    act(() => root.render(<design.FlowCardGrid size={previewSize}><design.FlowCard previewSize={previewSize} name="Review" origin="Built in" policy={policy} summary="Review the work." onClick={() => {}} /></design.FlowCardGrid>))
    const size = previewSize ?? 'compact'
    expect(host.querySelector('[data-slot="flow-card-grid"]')?.getAttribute('data-size')).toBe(size)
    expect(host.querySelector('[data-slot="flow-card"]')?.getAttribute('data-preview-size')).toBe(size)
    const graph = host.querySelector('[data-slot="flow-mini-graph"]')!
    expect(graph.getAttribute('data-preview-size')).toBe(size)
    expect(graph.getAttribute('viewBox')).toBe(size === 'large' ? '0 0 448 80' : '0 0 320 72')
    expect(graph.querySelectorAll('[data-step]')).toHaveLength(policy.roles.length)
    expect(graph.querySelectorAll('[data-slot="flow-mini-mark"] > svg')).toHaveLength(policy.roles.length)
    expect(graph.querySelector('[data-slot="icon-tile"], [data-tint]')).toBeNull()
    for (const rect of graph.querySelectorAll('[data-step] > rect')) {
      expect(Number(rect.getAttribute('height'))).toBe(size === 'large' ? 44 : 24)
      expect(Number(rect.getAttribute('width'))).toBe(size === 'large' ? 128 : 84)
    }
  }
})

it('keeps all ten shipped gallery policies and their routes inside the roomy poster', () => {
  const shipped = import.meta.glob('../../../../server/flows/*.yml', { eager: true, query: '?raw', import: 'default' })
  expect(Object.keys(shipped)).toHaveLength(10)
  for (const source of Object.values(shipped)) {
    const parsed = parseFlowPolicy(String(source))
    expect(parsed.problems.filter(problem => problem.level === 'error')).toEqual([])
    if (parsed.document?.format !== 'agents') throw new Error('Expected an Agent-routed Flow')
    const policy = parsed.document.flow
    const { points, boxes } = drawn(policy, 'large')
    within(points, 448, 80)
    apart(boxes)
    expect(host.querySelectorAll('[data-step]')).toHaveLength(policy.roles.length)
  }
})
