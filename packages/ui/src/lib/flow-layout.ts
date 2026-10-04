import type { FlowModel } from './flow-model'
import { defaultGraphPosition, type GraphPoint } from './shapes'

/**
 * Where a Flow's drawing puts things: one card for each step, one line for
 * each pair of steps a rule joins. Pure numbers, so a label sitting on a card is
 * a failing test and not something a person finds, and so the drawing, its
 * list and its frames all come from the same place.
 *
 * Left to right is the order the rules reach the steps in, along the longest
 * road the Flow has. Whatever hangs off that road sits on the row below: a
 * step only a loop reaches goes midway between where it is left and where it
 * is returned to, and a person who closes the Flow waits under the step that
 * hands over. A loop that goes back along the line falls under it, with a
 * retry mark on its word. A Flow whose file carries its own `layout.positions`
 * is drawn where its author put the cards; only the lines are ours, and they are
 * worked out from wherever the cards ended up.
 */

export type FlowPoint = GraphPoint
export interface FlowBox { readonly x: number; readonly y: number; readonly w: number; readonly h: number }

/** The front card; `fan` more sit behind it when a round opens several seats. */
export interface FlowNode { readonly id: string; readonly box: FlowBox; readonly fan: number }

/** The word above an edge. `x`/`y` are its centre; `retry` marks a loop's word. */
export interface FlowLabel {
  readonly text: string
  readonly retry: boolean
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export type FlowEdgeKind = 'forward' | 'loop'

export interface FlowEdge {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly rules: readonly string[]
  readonly kind: FlowEdgeKind
  /** On the edge of the card it leaves. */
  readonly start: FlowPoint
  /** On the edge of the card it reaches: the tip of the arrowhead. */
  readonly end: FlowPoint
  /** Stops where the arrowhead begins. */
  readonly path: string
  /** Tip first. */
  readonly head: readonly [FlowPoint, FlowPoint, FlowPoint]
  readonly label: FlowLabel | null
  readonly bounds: FlowBox
}

export interface FlowLayout {
  readonly width: number
  readonly height: number
  readonly nodes: readonly FlowNode[]
  readonly edges: readonly FlowEdge[]
}

export const FLOW_CARD_W = 176
export const FLOW_CARD_H = 68
export const FLOW_GAP = 64
export const FLOW_ROW_GAP = 88
export const FLOW_MARGIN = 32
/** The pitch of the faint dots behind the cards. */
export const FLOW_GRID = 18
/** How far each card behind the front one shows above it, and how far it is drawn in from either side. */
export const FLOW_FAN_RISE = 5
export const FLOW_FAN_INSET = 6
export const FLOW_LABEL_H = 20
export const FLOW_HEAD_LENGTH = 9
export const FLOW_HEAD_HALF = 4.5

const LABEL_CHAR = 6.8
const LABEL_PAD = 12
const LABEL_RETRY = 14
const LABEL_CLEAR = 8
const ARC_RISE = 52
const LOOP_DROP = 40
const LOOP_LANE = 22
const SELF_DROP = 30
const SIDE_CLEAR = 24
const NEAREST_EDGE = FLOW_MARGIN / 2
const FAN_MOST = 2
/** A closing person hangs under the line only when the line is longer than this. */
const HANG_AFTER = 3

type Side = 'l' | 'r' | 't' | 'b'
const NORMALS: Readonly<Record<Side, FlowPoint>> = { l: { x: -1, y: 0 }, r: { x: 1, y: 0 }, t: { x: 0, y: -1 }, b: { x: 0, y: 1 } }

/** All the rules that go from one step to another, drawn as one line. */
interface Link {
  readonly from: string
  readonly to: string
  readonly rules: string[]
  readonly words: string[]
  back: boolean
  kind: FlowEdgeKind
}

interface Shape {
  readonly links: readonly Link[]
  readonly out: ReadonlyMap<string, readonly Link[]>
  readonly into: ReadonlyMap<string, readonly Link[]>
  /** Steps in the order the walk from the seed met them; the ones it never met come last. */
  readonly order: readonly string[]
  readonly reached: ReadonlySet<string>
  /** The longest road from the seed, without the person who closes it. */
  readonly main: readonly string[]
}

const labelWidth = (link: Link): number => (link.words.length === 0
  ? 0
  : Math.ceil(link.words.join(' / ').length * LABEL_CHAR) + LABEL_PAD + (link.kind === 'loop' ? LABEL_RETRY : 0))

const analyse = (model: FlowModel): Shape => {
  const ids = model.steps.map((step) => step.id)
  const known = new Set(ids)
  const merged = new Map<string, Link>()
  for (const rule of model.rules) {
    // A rule to a step the file does not have is the file's mistake; the rest still draws.
    if (!known.has(rule.on) || !known.has(rule.to)) continue
    const key = `${rule.on}\u0000${rule.to}`
    let link = merged.get(key)
    if (!link) {
      link = { from: rule.on, to: rule.to, rules: [], words: [], back: false, kind: 'forward' }
      merged.set(key, link)
    }
    link.rules.push(rule.id)
    if (rule.word !== null && !link.words.includes(rule.word)) link.words.push(rule.word)
  }
  const links = [...merged.values()]
  const out = new Map<string, Link[]>(ids.map((id) => [id, []]))
  const into = new Map<string, Link[]>(ids.map((id) => [id, []]))
  for (const link of links) {
    out.get(link.from)!.push(link)
    into.get(link.to)!.push(link)
  }

  // Walk from the seed in the order the rules were written: a rule that comes
  // back to a step still being walked is a loop, whichever way it is drawn.
  const state = new Map<string, 'open' | 'done'>()
  const order: string[] = []
  const finished: string[] = []
  const visit = (id: string): void => {
    state.set(id, 'open')
    order.push(id)
    for (const link of out.get(id)!) {
      const seen = state.get(link.to)
      if (seen === 'open') link.back = true
      else if (seen === undefined) visit(link.to)
    }
    state.set(id, 'done')
    finished.push(id)
  }
  const seed = known.has(model.seed) ? model.seed : ids[0]
  if (seed !== undefined) visit(seed)
  const reached = new Set(order)
  for (const id of ids) if (!state.has(id)) visit(id)

  // The longest road, counting only the way forward. A step finishes before
  // anything that can reach it without a loop, so one pass in that order settles it.
  const depth = new Map<string, number>()
  for (const id of finished) {
    let longest = 0
    for (const link of out.get(id)!) if (!link.back) longest = Math.max(longest, 1 + (depth.get(link.to) ?? 0))
    depth.set(id, longest)
  }
  const main: string[] = []
  const onRoad = new Set<string>()
  for (let at = seed; at !== undefined && !onRoad.has(at);) {
    onRoad.add(at)
    main.push(at)
    let next: Link | undefined
    for (const link of out.get(at)!) {
      if (!link.back && (!next || (depth.get(link.to) ?? 0) > (depth.get(next.to) ?? 0))) next = link
    }
    at = next?.to
  }

  // A rule that goes round a cycle through something off the road is a loop;
  // one that only skips ahead along the road is not.
  const reaches = new Map<string, Set<string>>()
  const reachFrom = (id: string): Set<string> => {
    const cached = reaches.get(id)
    if (cached) return cached
    const seen = new Set<string>()
    const stack = [id]
    while (stack.length > 0) {
      for (const link of out.get(stack.pop()!)!) {
        if (!seen.has(link.to)) {
          seen.add(link.to)
          stack.push(link.to)
        }
      }
    }
    reaches.set(id, seen)
    return seen
  }
  const road = new Set(main)
  for (const link of links) {
    const cycle = link.back || reachFrom(link.to).has(link.from)
    link.kind = link.back || (cycle && !(road.has(link.from) && road.has(link.to))) ? 'loop' : 'forward'
  }

  // A person who closes a long Flow waits under the step that hands over, so
  // the line stays short. Not when that step also has a loop going back along
  // the line: the loop needs the floor under it, and the person would sit on it.
  const closing = main[main.length - 1]
  const handing = main[main.length - 2]
  if (
    closing !== undefined && handing !== undefined && main.length > HANG_AFTER
    && model.steps.find((step) => step.id === closing)?.kind === 'person'
    && !links.some((link) => link.kind === 'loop' && road.has(link.from) && road.has(link.to) && (link.from === handing || link.to === handing))
  ) {
    main.pop()
  }
  return { links, out, into, order, reached, main }
}

const centreOf = (box: FlowBox): FlowPoint => ({ x: box.x + box.w / 2, y: box.y + box.h / 2 })
const rightOf = (box: FlowBox): number => box.x + box.w
const bottomOf = (box: FlowBox): number => box.y + box.h
const clashes = (a: FlowBox, b: FlowBox): boolean => a.x < rightOf(b) && b.x < rightOf(a) && a.y < bottomOf(b) && b.y < bottomOf(a)
const inflate = (box: FlowBox, by: number): FlowBox => ({ x: box.x - by, y: box.y - by, w: box.w + 2 * by, h: box.h + 2 * by })
const holds = (box: FlowBox, point: FlowPoint): boolean => point.x >= box.x && point.x <= rightOf(box) && point.y >= box.y && point.y <= bottomOf(box)

/** The cards as the drawing makes them: the front card and the ones behind it. */
const withFan = (node: FlowNode): FlowBox => ({ ...node.box, y: node.box.y - node.fan * FLOW_FAN_RISE, h: node.box.h + node.fan * FLOW_FAN_RISE })

const unionOf = (boxes: readonly FlowBox[]): FlowBox => {
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let low = -Infinity
  for (const box of boxes) {
    left = Math.min(left, box.x)
    top = Math.min(top, box.y)
    right = Math.max(right, rightOf(box))
    low = Math.max(low, bottomOf(box))
  }
  return { x: left, y: top, w: right - left, h: low - top }
}

// ── cards ───────────────────────────────────────────────────────────────────

/** Where the steps go when the file has not said: the road along a row, the rest below it. */
const arrange = (model: FlowModel, shape: Shape): Map<string, FlowBox> => {
  const slot = new Map<string, number>()
  const row = new Map<string, number>()
  shape.main.forEach((id, index) => {
    slot.set(id, index)
    row.set(id, 0)
  })

  // A column is as far from the one before as the word between them needs.
  const columns: number[] = []
  let at = FLOW_MARGIN
  shape.main.forEach((id, index) => {
    columns.push(at)
    const next = shape.main[index + 1]
    if (next === undefined) return
    const link = shape.out.get(id)!.find((one) => one.to === next)
    at += FLOW_CARD_W + Math.max(FLOW_GAP, link ? labelWidth(link) + 2 * LABEL_CLEAR : 0)
  })
  const pitch = FLOW_CARD_W + FLOW_GAP
  const xOf = (position: number): number => {
    const last = columns.length - 1
    if (position <= 0) return columns[0]! + position * pitch
    if (position >= last) return columns[last]! + (position - last) * pitch
    const low = Math.floor(position)
    return columns[low]! + (position - low) * (columns[low + 1]! - columns[low]!)
  }

  const put = (id: string, wanted: number, level: number): void => {
    for (let r = level; ; r += 1) {
      for (let aside = 0; aside <= 4; aside += 1) {
        const x = xOf(wanted + aside)
        const taken = [...slot].some(([other, where]) => row.get(other) === r && Math.abs(xOf(where) - x) < FLOW_CARD_W + SIDE_CLEAR)
        if (!taken) {
          slot.set(id, wanted + aside)
          row.set(id, r)
          return
        }
      }
    }
  }

  const strays: string[] = []
  for (const id of shape.order) {
    if (slot.has(id)) continue
    const from = shape.reached.has(id) ? shape.into.get(id)!.find((link) => !link.back && slot.has(link.from))?.from : undefined
    if (from === undefined) {
      strays.push(id)
      continue
    }
    const back = shape.out.get(id)!.find((link) => link.to !== from && link.to !== id && slot.has(link.to))?.to
    if (back === undefined) put(id, slot.get(from)!, row.get(from)! + 1)
    else put(id, (slot.get(from)! + slot.get(back)!) / 2, Math.max(row.get(from)!, row.get(back)!) + 1)
  }
  // A step nothing reaches is still in the Flow: it gets a band of its own.
  const lowest = Math.max(0, ...row.values())
  strays.forEach((id, index) => {
    slot.set(id, index)
    row.set(id, lowest + 1)
  })

  const boxes = new Map<string, FlowBox>()
  for (const step of model.steps) {
    const level = row.get(step.id) ?? 0
    boxes.set(step.id, { x: xOf(slot.get(step.id) ?? 0), y: FLOW_MARGIN + level * (FLOW_CARD_H + FLOW_ROW_GAP), w: FLOW_CARD_W, h: FLOW_CARD_H })
  }
  return boxes
}

/** Where the file's own positions put them, exactly as the editor reads them. */
const placed = (model: FlowModel): Map<string, FlowBox> => {
  const raw = model.steps.map((step, index) => model.positions[step.id] ?? defaultGraphPosition(index))
  const left = Math.min(...raw.map((one) => one.x))
  const top = Math.min(...raw.map((one) => one.y))
  return new Map(model.steps.map((step, index) => [
    step.id,
    { x: raw[index]!.x - left + FLOW_MARGIN, y: raw[index]!.y - top + FLOW_MARGIN, w: FLOW_CARD_W, h: FLOW_CARD_H },
  ]))
}

// ── lines ───────────────────────────────────────────────────────────────────

interface Curve {
  readonly start: FlowPoint
  readonly c1: FlowPoint
  readonly c2: FlowPoint
  readonly stop: FlowPoint
  readonly straight: boolean
}

const along = (curve: Curve, t: number): FlowPoint => {
  const u = 1 - t
  const [a, b, c, d] = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t]
  return {
    x: a * curve.start.x + b * curve.c1.x + c * curve.c2.x + d * curve.stop.x,
    y: a * curve.start.y + b * curve.c1.y + c * curve.c2.y + d * curve.stop.y,
  }
}

const heading = (curve: Curve, t: number): FlowPoint => {
  const u = 1 - t
  const dx = 3 * u * u * (curve.c1.x - curve.start.x) + 6 * u * t * (curve.c2.x - curve.c1.x) + 3 * t * t * (curve.stop.x - curve.c2.x)
  const dy = 3 * u * u * (curve.c1.y - curve.start.y) + 6 * u * t * (curve.c2.y - curve.c1.y) + 3 * t * t * (curve.stop.y - curve.c2.y)
  const length = Math.hypot(dx, dy) || 1
  return { x: dx / length, y: dy / length }
}

const SAMPLES = 40
const sampled = (curve: Curve): FlowPoint[] => Array.from({ length: SAMPLES + 1 }, (_, i) => along(curve, i / SAMPLES))

const round = (value: number): number => Math.round(value * 10) / 10
const pathOf = (curve: Curve): string => (curve.straight
  ? `M${round(curve.start.x)} ${round(curve.start.y)}L${round(curve.stop.x)} ${round(curve.stop.y)}`
  : `M${round(curve.start.x)} ${round(curve.start.y)}C${round(curve.c1.x)} ${round(curve.c1.y)} ${round(curve.c2.x)} ${round(curve.c2.y)} ${round(curve.stop.x)} ${round(curve.stop.y)}`)

const portAt = (box: FlowBox, side: Side, fraction: number): FlowPoint => {
  switch (side) {
    case 'l': return { x: box.x, y: box.y + box.h * fraction }
    case 'r': return { x: rightOf(box), y: box.y + box.h * fraction }
    case 't': return { x: box.x + box.w * fraction, y: box.y }
    case 'b': return { x: box.x + box.w * fraction, y: bottomOf(box) }
  }
}

/** Short of the tip by the arrowhead's length, so the line does not poke through it. */
const baseOf = (tip: FlowPoint, normal: FlowPoint): FlowPoint => ({ x: tip.x + normal.x * FLOW_HEAD_LENGTH, y: tip.y + normal.y * FLOW_HEAD_LENGTH })

const headOf = (tip: FlowPoint, normal: FlowPoint): readonly [FlowPoint, FlowPoint, FlowPoint] => {
  const base = baseOf(tip, normal)
  const wing = { x: -normal.y * FLOW_HEAD_HALF, y: normal.x * FLOW_HEAD_HALF }
  return [tip, { x: base.x + wing.x, y: base.y + wing.y }, { x: base.x - wing.x, y: base.y - wing.y }]
}

/** Out of one card the way its side faces, into the next the way its side faces. */
const bend = (start: FlowPoint, leaving: FlowPoint, tip: FlowPoint, arriving: FlowPoint): Curve => {
  const stop = baseOf(tip, arriving)
  if ((leaving.x === 0 ? start.x === stop.x : start.y === stop.y) && leaving.x * arriving.x + leaving.y * arriving.y === -1) {
    return { start, c1: start, c2: stop, stop, straight: true }
  }
  const reach = Math.min(Math.max(Math.hypot(stop.x - start.x, stop.y - start.y) * 0.45, 24), 110)
  return {
    start,
    c1: { x: start.x + leaving.x * reach, y: start.y + leaving.y * reach },
    c2: { x: stop.x + arriving.x * reach, y: stop.y + arriving.y * reach },
    stop,
    straight: false,
  }
}

/** A line out of a card's edge that goes as far as `apex` and comes back to a card's edge. */
const loopOver = (start: FlowPoint, tip: FlowPoint, arriving: FlowPoint, apex: number): Curve => {
  const stop = baseOf(tip, arriving)
  // A cubic reaches (start + 3c + 3c + stop) / 8 midway, so this puts its far point at `apex`.
  const lean = (8 * apex - start.y - stop.y) / 6
  return { start, c1: { x: start.x, y: lean }, c2: { x: stop.x, y: lean }, stop, straight: false }
}

const TRIES = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74]
/** How many times further from its line a word may go, once nowhere beside it is clear. */
const FAR_TRIES = [2, 3]
/** What sitting on a card or another word costs a place, against the one point a crossed line costs. */
const SITS_ON = 1000

/**
 * Where the word for a line goes: beside it, above where the line runs flat and
 * to the right where it runs upright, at the middle if there is room and
 * nearer an end if not; failing that, on the line itself, which the word's own
 * backing then hides; failing that, further from it. `clash` scores a place by
 * what it would sit on (zero is clear): a card or another word counts for far
 * more than a line, so a crowded drawing puts a word across a line before it
 * puts it across a card, and a line's own place is never counted against it.
 */
const spotFor = (curve: Curve, w: number, clash: (rect: FlowBox, onOwn: boolean) => number): FlowPoint => {
  const rectAt = (centre: FlowPoint): FlowBox => ({ x: centre.x - w / 2, y: centre.y - FLOW_LABEL_H / 2, w, h: FLOW_LABEL_H })
  const beside = (t: number, far = 1): FlowPoint[] => {
    const point = along(curve, t)
    const toward = heading(curve, t)
    return [{ x: toward.y, y: -toward.x }, { x: -toward.y, y: toward.x }]
      .sort((p, q) => (p.y - q.y) || (q.x - p.x))
      .map((normal) => {
        const reach = (Math.abs(normal.x) * w / 2 + Math.abs(normal.y) * FLOW_LABEL_H / 2 + LABEL_CLEAR) * far
        return { x: point.x + normal.x * reach, y: point.y + normal.y * reach }
      })
  }
  const places: { readonly at: FlowPoint; readonly onOwn: boolean }[] = []
  const off = (centres: FlowPoint[]): void => { for (const at of centres) places.push({ at, onOwn: false }) }
  const on = (t: number): void => { if (!curve.straight) places.push({ at: along(curve, t), onOwn: true }) }
  off(beside(TRIES[0]!))
  on(0.5)
  for (const t of TRIES.slice(1)) off(beside(t))
  for (const t of TRIES.slice(1)) on(t)
  for (const far of FAR_TRIES) for (const t of TRIES) off(beside(t, far))
  let best = places[0]!
  let least = Infinity
  for (const place of places) {
    const score = clash(rectAt(place.at), place.onOwn)
    if (score === 0) return place.at
    if (score < least) {
      least = score
      best = place
    }
  }
  return best.at
}

type Route = 'straight' | 'curve' | 'under' | 'over' | 'self'

interface Run {
  readonly link: Link
  readonly a: FlowBox
  readonly b: FlowBox
  route: Route
  sa: Side
  sb: Side
  fa: number
  fb: number
}

const SIDES: readonly Side[] = ['r', 'l', 'b', 't']

const build = (model: FlowModel, shape: Shape, boxes: ReadonlyMap<string, FlowBox>) => {
  const nodes: FlowNode[] = model.steps.map((step) => ({
    id: step.id,
    box: boxes.get(step.id)!,
    fan: step.count > 1 ? Math.min(step.count - 1, FAN_MOST) : 0,
  }))
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const obstacles = (...except: string[]): FlowBox[] => nodes.filter((node) => !except.includes(node.id)).map((node) => withFan(node))

  const sameRow = (a: FlowBox, b: FlowBox): boolean => Math.abs(centreOf(a).y - centreOf(b).y) < FLOW_CARD_H / 2
  const runs: Run[] = shape.links.map((link) => {
    const a = byId.get(link.from)!.box
    const b = byId.get(link.to)!.box
    const run: Run = { link, a, b, route: 'curve', sa: 'r', sb: 'l', fa: 0.5, fb: 0.5 }
    const between = (): boolean => nodes.some((node) => node.id !== link.from && node.id !== link.to && sameRow(node.box, a)
      && centreOf(node.box).x > Math.min(centreOf(a).x, centreOf(b).x) && centreOf(node.box).x < Math.max(centreOf(a).x, centreOf(b).x))
    const blockedBelow = (box: FlowBox, id: string): boolean => nodes.some((node) => node.id !== id && node.box.y >= bottomOf(box) - 1
      && node.box.x < rightOf(box) && rightOf(node.box) > box.x)
    if (link.from === link.to) {
      Object.assign(run, { route: 'self', sa: 'b', sb: 'b', fa: 0.65, fb: 0.35 })
    } else if (sameRow(a, b) && b.x >= rightOf(a)) {
      if (between()) Object.assign(run, { route: 'over', sa: 't', sb: 't' })
      else Object.assign(run, { route: 'straight', sa: 'r', sb: 'l' })
    } else if (sameRow(a, b) && rightOf(b) <= a.x) {
      if (blockedBelow(a, link.from) || blockedBelow(b, link.to)) Object.assign(run, { route: 'over', sa: 't', sb: 't' })
      else Object.assign(run, { route: 'under', sa: 'b', sb: 'b' })
    } else {
      // Across rows: whichever pair of sides gives the shortest line that does
      // not turn back on itself or go through a card.
      const others = obstacles(link.from, link.to)
      let best = Infinity
      for (const sa of SIDES) {
        for (const sb of SIDES) {
          const p0 = portAt(a, sa, 0.5)
          const tip = portAt(b, sb, 0.5)
          const na = NORMALS[sa]
          const nb = NORMALS[sb]
          const gap = { x: tip.x - p0.x, y: tip.y - p0.y }
          let cost = Math.hypot(gap.x, gap.y)
          if (na.x * gap.x + na.y * gap.y <= 0) cost += 1000
          if (nb.x * -gap.x + nb.y * -gap.y <= 0) cost += 1000
          // Straight through a pair of facing sides is best, a right angle costs
          // something, and going out of the side the line came in by costs most.
          const turn = na.x * nb.x + na.y * nb.y
          cost += turn === -1 ? 0 : turn === 0 ? 60 : 160
          if (sa === 'l') cost += 80
          if (sb === 'r') cost += 80
          const trial = bend(p0, na, tip, nb)
          const path = sampled(trial)
          for (const other of others) if (path.some((point) => holds(inflate(other, 2), point))) cost += 500
          if (cost < best) {
            best = cost
            Object.assign(run, { route: 'curve', sa, sb })
          }
        }
      }
    }
    return run
  })

  // Several lines on one side of a card spread along it, in the order of the
  // cards they go to, so they do not cross on the way out.
  const users = new Map<string, { run: Run; end: 'a' | 'b'; other: FlowBox }[]>()
  for (const run of runs) {
    if (run.route === 'self') continue
    for (const [end, id, side, other] of [['a', run.link.from, run.sa, run.b], ['b', run.link.to, run.sb, run.a]] as const) {
      const key = `${id}:${side}`
      users.set(key, [...(users.get(key) ?? []), { run, end, other }])
    }
  }
  for (const [key, list] of users) {
    const side = key.slice(key.lastIndexOf(':') + 1) as Side
    const sorted = [...list].sort((p, q) => (side === 't' || side === 'b' ? centreOf(p.other).x - centreOf(q.other).x : centreOf(p.other).y - centreOf(q.other).y))
    sorted.forEach((use, index) => {
      const fraction = (index + 1) / (sorted.length + 1)
      if (use.end === 'a') use.run.fa = fraction
      else use.run.fb = fraction
    })
  }

  // Lines that go round under (or over) the cards each take a lane, deeper for
  // the ones that enclose another, so none lies on top of one it should clear.
  const lanes = new Map<Run, number>()
  for (const group of ['under', 'over'] as const) {
    const wanted = runs.filter((run) => run.route === group)
    const span = (run: Run): [number, number] => {
      const x = [portAt(run.a, run.sa, run.fa).x, portAt(run.b, run.sb, run.fb).x]
      return [Math.min(...x), Math.max(...x)]
    }
    const settled: Run[] = []
    for (const run of [...wanted].sort((p, q) => (span(p)[1] - span(p)[0]) - (span(q)[1] - span(q)[0]))) {
      const [low, high] = span(run)
      const lane = 1 + Math.max(-1, ...settled.filter((other) => span(other)[0] < high && span(other)[1] > low).map((other) => lanes.get(other)!))
      lanes.set(run, lane)
      settled.push(run)
    }
  }

  const curves = runs.map((run): { run: Run; curve: Curve; tip: FlowPoint; arriving: FlowPoint } => {
    const start = portAt(run.a, run.sa, run.fa)
    const tip = portAt(run.b, run.sb, run.fb)
    const leaving = NORMALS[run.sa]
    const arriving = NORMALS[run.sb]
    if (run.route === 'straight' || run.route === 'curve') return { run, curve: bend(start, leaving, tip, arriving), tip, arriving }
    if (run.route === 'self') return { run, curve: loopOver(start, tip, arriving, bottomOf(run.a) + SELF_DROP), tip, arriving }
    // Past every card the line goes over or under, so it clears the ones in its way.
    const low = Math.min(start.x, tip.x)
    const high = Math.max(start.x, tip.x)
    const passed = nodes.filter((node) => node.box.x < high && rightOf(node.box) > low)
    if (run.route === 'under') {
      const floor = Math.max(...passed.map((node) => bottomOf(node.box)))
      return { run, curve: loopOver(start, tip, arriving, floor + LOOP_DROP + lanes.get(run)! * LOOP_LANE), tip, arriving }
    }
    const ceiling = Math.min(...passed.map((node) => withFan(node).y))
    return { run, curve: loopOver(start, tip, arriving, ceiling - ARC_RISE - lanes.get(run)! * LOOP_LANE), tip, arriving }
  })

  // Words go last, once every card and line is where it is going to be.
  const blocks: FlowBox[] = nodes.map((node) => inflate(withFan(node), 4))
  const edges: FlowEdge[] = []
  const paths = curves.map(({ curve }) => sampled(curve))
  curves.forEach(({ run, curve, tip, arriving }, index) => {
    const { link } = run
    const text = link.words.join(' / ')
    let label: FlowLabel | null = null
    if (text !== '') {
      const w = labelWidth(link)
      const at = spotFor(curve, w, (rect, onOwn) => SITS_ON * blocks.filter((block) => clashes(rect, block)).length
        + paths.reduce((crossed, path, other) => (onOwn && other === index ? crossed : crossed + path.filter((point) => holds(inflate(rect, 2), point)).length), 0))
      label = { text, retry: link.kind === 'loop', x: at.x, y: at.y, w, h: FLOW_LABEL_H }
      blocks.push({ x: at.x - w / 2, y: at.y - FLOW_LABEL_H / 2, w, h: FLOW_LABEL_H })
    }
    const head = headOf(tip, arriving)
    const reach = unionOf([...paths[index]!.map((point) => ({ x: point.x, y: point.y, w: 0, h: 0 })), ...head.map((point) => ({ x: point.x, y: point.y, w: 0, h: 0 }))])
    edges.push({
      id: `${link.from}>${link.to}`,
      from: link.from,
      to: link.to,
      rules: link.rules,
      kind: link.kind,
      start: curve.start,
      end: tip,
      path: pathOf(curve),
      head,
      label,
      bounds: reach,
    })
  })

  const extent = unionOf([...nodes.map((node) => withFan(node)), ...edges.map((edge) => edge.bounds), ...edges.flatMap((edge) => (edge.label ? [{ x: edge.label.x - edge.label.w / 2, y: edge.label.y - edge.label.h / 2, w: edge.label.w, h: edge.label.h }] : []))])
  return { nodes, edges, extent }
}

export const flowLayout = (model: FlowModel): FlowLayout => {
  if (model.steps.length === 0) return { width: 2 * FLOW_MARGIN, height: 2 * FLOW_MARGIN, nodes: [], edges: [] }
  const shape = analyse(model)
  const boxes = Object.keys(model.positions).length > 0 ? placed(model) : arrange(model, shape)
  let drawn = build(model, shape, boxes)
  // Lines and words that went past the top or the left of the canvas pull the
  // whole drawing over, rather than being cut off by it.
  const dx = Math.max(0, NEAREST_EDGE - drawn.extent.x)
  const dy = Math.max(0, NEAREST_EDGE - drawn.extent.y)
  if (dx > 0 || dy > 0) {
    drawn = build(model, shape, new Map([...boxes].map(([id, box]) => [id, { ...box, x: box.x + dx, y: box.y + dy }])))
  }
  return {
    width: Math.ceil(rightOf(drawn.extent) + FLOW_MARGIN),
    height: Math.ceil(bottomOf(drawn.extent) + FLOW_MARGIN),
    nodes: drawn.nodes,
    edges: drawn.edges,
  }
}
