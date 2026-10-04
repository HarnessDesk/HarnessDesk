import { describe, expect, it } from 'vitest'

import type { CeilingLevel, FlowAgentRole, FlowPolicy, FlowPolicyRole, FlowPolicyRule } from '@harnessdesk/protocol'

import { flowModel } from './flow-model'
import {
  FLOW_CARD_H, FLOW_CARD_W, FLOW_FAN_RISE, FLOW_GAP, FLOW_MARGIN,
  flowLayout, type FlowBox, type FlowEdge, type FlowLayout, type FlowNode, type FlowPoint,
} from './flow-layout'

/**
 * The drawing's geometry, with no DOM in it: where each step's card goes, and
 * the line each rule draws between two of them. Everything here is read off the
 * returned numbers, so a layout that put a label on a card fails here and not
 * in front of a person.
 */

const agent = (id: string, over: Partial<FlowAgentRole> & { grant?: CeilingLevel } = {}): FlowAgentRole => ({
  id, kind: 'agent', uses: [`${id}-agent`], seats: [], isolate: false, grant: 'read', independentOf: [], ...over,
})
const check = (id: string): FlowPolicyRole => ({ id, kind: 'check', check: { run: 'pnpm verify', timeout: 300, exits: { 0: 'pass' }, otherwise: 'fail' } })
const person = (id: string): FlowPolicyRole => ({ id, kind: 'person', outcomes: ['merged', 'dropped'] })
const rule = (on: string, to: string, word?: string): FlowPolicyRule => ({
  id: `${on}-${to}`, on, ...(word ? { when: { every: [word] } } : {}), then: { role: to, title: `Open ${to}` },
})
const draw = (
  roles: readonly FlowPolicyRole[], rules: readonly FlowPolicyRule[], over: Partial<FlowPolicy> = {},
): FlowLayout => flowLayout(flowModel({
  version: 2, name: 'Flow', inputs: [], roles, rules, seed: { role: roles[0]!.id, title: 'Go' }, messaging: 'board-only', wait: 240, ...over,
}))

const node = (layout: FlowLayout, id: string): FlowNode => layout.nodes.find((one) => one.id === id)!
const edge = (layout: FlowLayout, from: string, to: string): FlowEdge => layout.edges.find((one) => one.from === from && one.to === to)!
const right = (box: FlowBox): number => box.x + box.w
const bottom = (box: FlowBox): number => box.y + box.h
const centre = (box: FlowBox): FlowPoint => ({ x: box.x + box.w / 2, y: box.y + box.h / 2 })

/** The blueprint: a straight line with a detour below it and a person at the end. */
const blueprint = () => draw(
  [agent('write'), check('check'), agent('review'), check('land'), agent('fix'), person('you')],
  [
    rule('write', 'check'),
    rule('check', 'review', 'passes'),
    rule('review', 'land', 'approve'),
    rule('review', 'fix', 'request-changes'),
    rule('fix', 'check'),
    rule('land', 'you', 'landed'),
  ],
)

describe('the order of the steps', () => {
  it('runs left to right in the order the rules reach them, not the order the file wrote them', () => {
    const layout = draw(
      [agent('review'), agent('write'), check('check')],
      [rule('write', 'check'), rule('check', 'review')],
      { seed: { role: 'write', title: 'Go' } },
    )
    const [write, verify, review] = ['write', 'check', 'review'].map((id) => node(layout, id).box)
    expect(write!.x).toBeLessThan(verify!.x)
    expect(verify!.x).toBeLessThan(review!.x)
    expect(new Set([write!.y, verify!.y, review!.y]).size).toBe(1)
  })

  it('leaves a gap between neighbours, and the margin around the first', () => {
    const layout = draw([agent('a'), agent('b'), agent('c')], [rule('a', 'b'), rule('b', 'c')])
    expect(node(layout, 'a').box.x).toBe(FLOW_MARGIN)
    expect(node(layout, 'b').box.x - right(node(layout, 'a').box)).toBeGreaterThanOrEqual(FLOW_GAP)
    expect(node(layout, 'c').box.x - right(node(layout, 'b').box)).toBeGreaterThanOrEqual(FLOW_GAP)
    expect(node(layout, 'a').box.w).toBe(FLOW_CARD_W)
    expect(node(layout, 'a').box.h).toBe(FLOW_CARD_H)
  })

  it('widens a gap to fit the word above its edge', () => {
    const layout = draw([agent('a'), agent('b')], [rule('a', 'b', 'request-changes')])
    const label = edge(layout, 'a', 'b').label!
    expect(label.text).toBe('request-changes')
    expect(label.x - label.w / 2).toBeGreaterThanOrEqual(right(node(layout, 'a').box))
    expect(label.x + label.w / 2).toBeLessThanOrEqual(node(layout, 'b').box.x)
  })

  it('follows the longest road when a step is reached two ways', () => {
    const layout = draw(
      [agent('a'), agent('b'), agent('c'), agent('d')],
      [rule('a', 'b'), rule('a', 'd'), rule('b', 'c'), rule('c', 'd')],
    )
    const xs = ['a', 'b', 'c', 'd'].map((id) => node(layout, id).box.x)
    expect(xs).toEqual([...xs].sort((one, other) => one - other))
    expect(new Set(['a', 'b', 'c', 'd'].map((id) => node(layout, id).box.y)).size).toBe(1)
  })

  it('still draws a step no rule reaches, apart from the line', () => {
    const layout = draw([agent('a'), agent('b'), agent('stray')], [rule('a', 'b')])
    const stray = node(layout, 'stray').box
    expect(stray.y).toBeGreaterThan(bottom(node(layout, 'a').box))
    for (const other of layout.nodes.filter((one) => one.id !== 'stray')) expect(overlaps(stray, other.box)).toBe(false)
  })

  it('draws every step of a Flow that has no rules', () => {
    const layout = draw([agent('only')], [])
    expect(layout.nodes.map((one) => one.id)).toEqual(['only'])
    expect(layout.edges).toEqual([])
    expect(layout.width).toBeGreaterThan(FLOW_CARD_W)
  })
})

describe('a loop', () => {
  it('goes back under the line and says so with a retry mark', () => {
    const layout = draw(
      [agent('fixer'), agent('reviewer'), person('referee')],
      [rule('fixer', 'reviewer'), rule('reviewer', 'referee', 'approve'), rule('reviewer', 'fixer', 'request-changes')],
    )
    const back = edge(layout, 'reviewer', 'fixer')
    expect(back.kind).toBe('loop')
    expect(back.label).toMatchObject({ text: 'request-changes', retry: true })
    expect(back.bounds.y + back.bounds.h).toBeGreaterThan(bottom(node(layout, 'reviewer').box))
    // The steps themselves stay on one line: only the way back falls.
    expect(node(layout, 'fixer').box.y).toBe(node(layout, 'reviewer').box.y)
    expect(edge(layout, 'fixer', 'reviewer').kind).toBe('forward')
    expect(edge(layout, 'fixer', 'reviewer').label).toBeNull()
  })

  it('starts below the step it leaves and ends below the step it returns to', () => {
    const layout = draw([agent('a'), agent('b')], [rule('a', 'b'), rule('b', 'a', 'again')])
    const back = edge(layout, 'b', 'a')
    expect(back.start.y).toBe(bottom(node(layout, 'b').box))
    expect(back.end.y).toBe(bottom(node(layout, 'a').box))
  })

  it('turns back on a step that sends work to itself', () => {
    const layout = draw([agent('a')], [rule('a', 'a', 'again')])
    const loop = edge(layout, 'a', 'a')
    expect(loop.kind).toBe('loop')
    expect(loop.start.y).toBe(bottom(node(layout, 'a').box))
    expect(loop.end.y).toBe(bottom(node(layout, 'a').box))
    expect(loop.start.x).not.toBe(loop.end.x)
    expect(loop.bounds.y + loop.bounds.h).toBeGreaterThan(bottom(node(layout, 'a').box))
  })

  it('hangs a step only a loop reaches below the line, midway between where it leaves and where it returns', () => {
    const layout = blueprint()
    const [check, review, fix] = ['check', 'review', 'fix'].map((id) => node(layout, id))
    expect(fix!.box.y).toBeGreaterThan(bottom(review!.box))
    expect(centre(fix!.box).x).toBeCloseTo((centre(check!.box).x + centre(review!.box).x) / 2, 5)
    expect(edge(layout, 'review', 'fix').kind).toBe('loop')
    expect(edge(layout, 'fix', 'check').kind).toBe('loop')
    expect(edge(layout, 'review', 'fix').label).toMatchObject({ text: 'request-changes', retry: true })
    expect(edge(layout, 'check', 'review').kind).toBe('forward')
    expect(edge(layout, 'check', 'review').label).toMatchObject({ text: 'passes', retry: false })
  })

  it('keeps the main line straight, with the detour not on it', () => {
    const layout = blueprint()
    const main = ['write', 'check', 'review', 'land'].map((id) => node(layout, id))
    expect(new Set(main.map((one) => one.box.y)).size).toBe(1)
    expect(node(layout, 'fix').box.y).not.toBe(main[0]!.box.y)
  })
})

describe('a person at the end', () => {
  it('waits under the step that hands over to them', () => {
    const layout = blueprint()
    const land = node(layout, 'land').box
    const you = node(layout, 'you')
    expect(you.box.x).toBe(land.x)
    expect(you.box.y).toBeGreaterThan(bottom(land))
    const handover = edge(layout, 'land', 'you')
    expect(handover.start).toEqual({ x: centre(land).x, y: bottom(land) })
    expect(handover.end).toEqual({ x: centre(you.box).x, y: you.box.y })
    expect(handover.label?.text).toBe('landed')
  })

  it('stays on the line in a short Flow, where there is no line to save', () => {
    const layout = draw([agent('write'), agent('review'), person('you')], [rule('write', 'review'), rule('review', 'you', 'approve')])
    expect(new Set(['write', 'review', 'you'].map((id) => node(layout, id).box.y)).size).toBe(1)
  })

  it('stays on the line when the step before them has a loop back along it, which needs the floor', () => {
    const layout = draw(
      [agent('write'), check('check'), agent('review'), person('referee')],
      [rule('write', 'check'), rule('check', 'review'), rule('review', 'referee', 'approve'), rule('review', 'write', 'request-changes')],
    )
    expect(node(layout, 'referee').box.y).toBe(node(layout, 'review').box.y)
    expect(edge(layout, 'review', 'write').bounds.y + edge(layout, 'review', 'write').bounds.h).toBeGreaterThan(bottom(node(layout, 'review').box))
  })

  it('stays on the line when the Flow starts with them', () => {
    const layout = draw([person('you'), agent('write')], [rule('you', 'write')])
    expect(node(layout, 'you').box.y).toBe(node(layout, 'write').box.y)
    expect(node(layout, 'you').box.x).toBeLessThan(node(layout, 'write').box.x)
  })
})

describe('several seats at once', () => {
  it('is a stack of cards behind the first, as many as the round is wide, up to three', () => {
    const layout = draw(
      [agent('one'), agent('two', { count: 2 }), agent('many', { count: 7 })],
      [rule('one', 'two'), rule('two', 'many')],
    )
    expect(['one', 'two', 'many'].map((id) => node(layout, id).fan)).toEqual([0, 1, 2])
  })

  it('leaves room above the first row for the stack', () => {
    const layout = draw([agent('many', { count: 9 })], [])
    expect(node(layout, 'many').box.y - 2 * FLOW_FAN_RISE).toBeGreaterThanOrEqual(0)
  })
})

describe("a Flow's own positions", () => {
  const positioned = (positions: Record<string, FlowPoint>) => draw(
    [agent('write'), agent('review'), agent('land')],
    [rule('write', 'review'), rule('review', 'land')],
    { layout: { positions } },
  )

  it('win over the order the rules reach the steps in', () => {
    const layout = positioned({ write: { x: 300, y: 200 }, review: { x: 40, y: 40 }, land: { x: 560, y: 360 } })
    const [write, review, land] = ['write', 'review', 'land'].map((id) => node(layout, id).box)
    expect([review!.x, review!.y]).toEqual([FLOW_MARGIN, FLOW_MARGIN])
    // Shifted as a whole, so the hand layout keeps its shape and loses only its empty corner.
    expect([write!.x - review!.x, write!.y - review!.y]).toEqual([260, 160])
    expect([land!.x - review!.x, land!.y - review!.y]).toEqual([520, 320])
  })

  it('reroute the edges from where the cards went', () => {
    const layout = positioned({ write: { x: 40, y: 40 }, review: { x: 40, y: 260 }, land: { x: 300, y: 260 } })
    const down = edge(layout, 'write', 'review')
    expect(down.start).toEqual({ x: centre(node(layout, 'write').box).x, y: bottom(node(layout, 'write').box) })
    expect(down.end).toEqual({ x: centre(node(layout, 'review').box).x, y: node(layout, 'review').box.y })
  })

  it('leave a step the file did not place where the editor would put it', () => {
    const layout = positioned({ write: { x: 40, y: 40 } })
    expect(node(layout, 'write').box).toMatchObject({ x: FLOW_MARGIN, y: FLOW_MARGIN })
    expect(node(layout, 'review').box.y).toBeGreaterThan(node(layout, 'write').box.y)
  })

  it('are looked up as the file’s own entries, so a step called like a built-in of any object is not placed by one', () => {
    // A step id is free text. `toString` is a legal one, and a plain object
    // answers a lookup under it with a function, whose x and y are nothing.
    const ids = ['constructor', 'toString', 'valueOf', 'hasOwnProperty']
    const layout = draw(
      [agent('write'), ...ids.map((id) => agent(id))],
      ids.map((id, index) => rule(index === 0 ? 'write' : ids[index - 1]!, id)),
      { layout: { positions: { write: { x: 40, y: 40 } } } },
    )
    for (const one of layout.nodes) expect(Object.values(one.box).every(Number.isFinite), `the card of ${one.id}`).toBe(true)
    expect([layout.width, layout.height].every(Number.isFinite)).toBe(true)
    const rows = ['write', ...ids].map((id) => node(layout, id).box.y)
    expect(rows).toEqual([...rows].sort((a, b) => a - b))
    expect(new Set(rows).size).toBe(rows.length)
  })

  it('are ignored when the file carries none the Flow can use', () => {
    const plain = draw([agent('write'), agent('review')], [rule('write', 'review')])
    const unusable = draw([agent('write'), agent('review')], [rule('write', 'review')], { layout: { positions: { ghost: { x: 5, y: 5 } } } })
    expect(unusable.nodes.map((one) => one.box)).toEqual(plain.nodes.map((one) => one.box))
  })
})

describe('a rule', () => {
  it('to a step the Flow does not have is skipped, without losing the rest', () => {
    const layout = draw([agent('a'), agent('b')], [rule('a', 'b'), rule('a', 'ghost'), rule('ghost', 'b')])
    expect(layout.edges.map((one) => `${one.from}>${one.to}`)).toEqual(['a>b'])
    expect(layout.nodes.map((one) => one.id)).toEqual(['a', 'b'])
  })

  it('draws two rules between the same steps as one edge with both words', () => {
    const layout = draw([agent('a'), agent('b')], [rule('a', 'b', 'approve'), rule('a', 'b', 'comment')])
    expect(layout.edges).toHaveLength(1)
    expect(layout.edges[0]!.rules).toEqual(['a-b', 'a-b'])
    expect(layout.edges[0]!.label?.text).toBe('approve / comment')
  })

  it('has no word to draw when nothing guards it', () => {
    expect(draw([agent('a'), agent('b')], [rule('a', 'b')]).edges[0]!.label).toBeNull()
  })
})

describe('an edge', () => {
  it('runs straight from the right of one card to the left of the next, ending in its arrowhead', () => {
    const layout = draw([agent('a'), agent('b')], [rule('a', 'b', 'approve')])
    const a = node(layout, 'a').box
    const b = node(layout, 'b').box
    const line = edge(layout, 'a', 'b')
    expect(line.start).toEqual({ x: right(a), y: centre(a).y })
    expect(line.end).toEqual({ x: b.x, y: centre(b).y })
    expect(line.path).not.toContain('C')
    expect(line.head).toHaveLength(3)
    expect(line.head[0]).toEqual(line.end)
    // The line stops where the arrowhead begins, so it does not poke through the tip.
    expect(line.head[1]!.x).toBeLessThan(line.end.x)
    expect(line.head[2]!.x).toBeLessThan(line.end.x)
  })

  it('arches over the cards in between when it skips a step', () => {
    const layout = draw([agent('a'), agent('b'), agent('c')], [rule('a', 'b'), rule('b', 'c'), rule('a', 'c', 'skip')])
    const skip = edge(layout, 'a', 'c')
    expect(skip.kind).toBe('forward')
    expect(skip.start.y).toBe(node(layout, 'a').box.y)
    expect(skip.end.y).toBe(node(layout, 'c').box.y)
    expect(skip.bounds.y).toBeLessThan(node(layout, 'a').box.y)
    expect(skip.bounds.y).toBeGreaterThanOrEqual(0)
  })

  it('starts and ends on the edge of the cards it joins, whatever the Flow', () => {
    for (const layout of everyFlow()) {
      for (const one of layout.edges) {
        expect(onBorder(one.start, node(layout, one.from).box), `${one.from}>${one.to} start`).toBe(true)
        expect(onBorder(one.end, node(layout, one.to).box), `${one.from}>${one.to} end`).toBe(true)
        expect(one.head[0]).toEqual(one.end)
      }
    }
  })

  it('is inside the canvas, with the margin around it', () => {
    for (const layout of everyFlow()) {
      for (const one of layout.edges) {
        expect(one.bounds.x).toBeGreaterThanOrEqual(0)
        expect(one.bounds.y).toBeGreaterThanOrEqual(0)
        expect(right(one.bounds)).toBeLessThanOrEqual(layout.width)
        expect(bottom(one.bounds)).toBeLessThanOrEqual(layout.height)
      }
      for (const one of layout.nodes) {
        expect(right(one.box) + FLOW_MARGIN).toBeLessThanOrEqual(layout.width)
        expect(bottom(one.box) + FLOW_MARGIN).toBeLessThanOrEqual(layout.height)
      }
    }
  })
})

describe('the words above the edges', () => {
  it('never sit on a card or on each other', () => {
    for (const layout of everyFlow()) {
      const labels = layout.edges.flatMap((one) => (one.label ? [{ edge: one, rect: labelRect(one) }] : []))
      for (const { edge: one, rect } of labels) {
        expect(rect.x, `${one.from}>${one.to} left`).toBeGreaterThanOrEqual(0)
        expect(rect.y, `${one.from}>${one.to} top`).toBeGreaterThanOrEqual(0)
        for (const card of layout.nodes) {
          expect(overlaps(rect, withFan(card)), `${one.from}>${one.to} over ${card.id}`).toBe(false)
        }
      }
      for (let i = 0; i < labels.length; i += 1) {
        for (let j = i + 1; j < labels.length; j += 1) {
          expect(overlaps(labels[i]!.rect, labels[j]!.rect), `${labels[i]!.edge.id} over ${labels[j]!.edge.id}`).toBe(false)
        }
      }
    }
  })

  it('never put two cards on one another', () => {
    for (const layout of everyFlow()) {
      for (let i = 0; i < layout.nodes.length; i += 1) {
        for (let j = i + 1; j < layout.nodes.length; j += 1) {
          expect(overlaps(withFan(layout.nodes[i]!), withFan(layout.nodes[j]!)), `${layout.nodes[i]!.id} over ${layout.nodes[j]!.id}`).toBe(false)
        }
      }
    }
  })
})

const withFan = (one: FlowNode): FlowBox => ({ ...one.box, y: one.box.y - one.fan * FLOW_FAN_RISE, h: one.box.h + one.fan * FLOW_FAN_RISE })
const labelRect = (one: FlowEdge): FlowBox => ({ x: one.label!.x - one.label!.w / 2, y: one.label!.y - one.label!.h / 2, w: one.label!.w, h: one.label!.h })
const overlaps = (a: FlowBox, b: FlowBox): boolean => a.x < right(b) && b.x < right(a) && a.y < bottom(b) && b.y < bottom(a)
const onBorder = (point: FlowPoint, box: FlowBox): boolean => {
  const inside = point.x >= box.x - 0.001 && point.x <= right(box) + 0.001 && point.y >= box.y - 0.001 && point.y <= bottom(box) + 0.001
  const edgeHit = Math.abs(point.x - box.x) < 0.001 || Math.abs(point.x - right(box)) < 0.001 || Math.abs(point.y - box.y) < 0.001 || Math.abs(point.y - bottom(box)) < 0.001
  return inside && edgeHit
}

/** The shapes a Flow takes, so a property is checked on all of them. */
const everyFlow = (): FlowLayout[] => [
  blueprint(),
  draw([agent('a'), agent('b'), agent('c')], [rule('a', 'b', 'pass'), rule('b', 'c', 'approve')]),
  draw(
    [agent('fixer'), agent('reviewer', { count: 3 }), check('gate'), person('referee')],
    [rule('fixer', 'reviewer'), rule('reviewer', 'fixer', 'request-changes'), rule('reviewer', 'gate', 'approve'), rule('gate', 'referee', 'passed')],
  ),
  draw([agent('a')], [rule('a', 'a', 'again')]),
  draw(
    [agent('analyze'), agent('build'), agent('test_review'), person('ship')],
    [rule('analyze', 'build', 'agreed'), rule('build', 'test_review'), rule('test_review', 'ship', 'approve'), rule('test_review', 'build', 'request-changes')],
  ),
  draw(
    [agent('a'), agent('b'), agent('c'), agent('d'), agent('e'), agent('f'), agent('g')],
    [rule('a', 'b'), rule('b', 'c', 'ok'), rule('c', 'd'), rule('d', 'e', 'approve'), rule('e', 'f'), rule('f', 'g'), rule('a', 'c', 'skip'), rule('g', 'b', 'again')],
  ),
  draw(
    [agent('write'), agent('review'), agent('fix'), agent('polish'), check('land'), person('you')],
    [rule('write', 'review'), rule('review', 'land', 'approve'), rule('review', 'fix', 'request-changes'), rule('fix', 'polish', 'done'), rule('polish', 'review'), rule('land', 'you', 'landed')],
  ),
  draw(
    [agent('a'), agent('b'), person('p'), person('q')],
    [rule('a', 'b', 'x'), rule('b', 'p', 'merged'), rule('b', 'q', 'dropped')],
  ),
  // Crowded: steps off the line joined to each other, a step that sends work to
  // itself under two long words, and a person reached from two sides.
  draw(
    [check('c0'), agent('a1'), agent('a2'), check('c3'), person('p4'), check('c5')],
    [
      rule('a1', 'a2'), rule('c3', 'a2'), { ...rule('a2', 'a2'), when: { every: ['approve', 'a-rather-long-outcome-word'] } },
      rule('c0', 'c0', 'request-changes'), rule('c0', 'c5', 'approve'), rule('p4', 'a1'), rule('c5', 'a2', 'a-rather-long-outcome-word'),
      rule('c0', 'p4'), rule('c5', 'p4'),
    ],
    { seed: { role: 'c3', title: 'Go' } },
  ),
]
