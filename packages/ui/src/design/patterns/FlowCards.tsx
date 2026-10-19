import { useId, useMemo, type ReactNode } from 'react'
import type { FlowPolicy } from '@harnessdesk/protocol'

import { flowLayout } from '../../lib/flow-layout'
import { flowModel } from '../../lib/flow-model'
import { Button } from '../ui/button'
import { Chip, Text } from './Settings'
import styles from './FlowCards.module.css'

export interface FlowCardProps {
  readonly name: string
  readonly origin: string
  readonly policy?: FlowPolicy | null
  /** A plain Team is known to have no fixed steps; a missing policy alone means the graph is unavailable. */
  readonly empty?: boolean
  readonly summary: string
  readonly runs?: number | null
  readonly selected?: boolean
  readonly disabled?: boolean
  readonly onClick: () => void
  readonly 'aria-label'?: string
  readonly title?: string
}

/** A Flow in a destination or picker: its source, actual shape, earned summary and optional Run count. */
export const FlowCard = ({ name, origin, policy, empty, summary, runs, selected = false, disabled, onClick, 'aria-label': label, title }: FlowCardProps) => {
  const summaryId = useId()
  return <Button variant="row" size="pattern" className={styles.card} data-slot="flow-card"
    data-selected={selected || undefined} aria-pressed={selected} disabled={disabled}
    aria-label={label ?? `Open ${name}`} aria-describedby={summary ? summaryId : undefined} title={title ?? name} onClick={onClick}>
    <span className={styles.head}>
      <Text as="span" role="subject" truncate title={name}>{name}</Text>
      <Chip size="sm" tone="neutral">{origin}</Chip>
    </span>
    <FlowMiniGraph policy={policy} empty={empty} />
    <span className={styles.foot}>
      <span id={summaryId} data-slot="flow-card-summary" className={styles.summary}><Text as="span" role="meta" ink="secondary">{summary}</Text></span>
      {runs !== undefined && <span data-slot="flow-card-runs" className={styles.runs} title={runs === null ? 'The recorded Runs could not all be read yet.' : 'Recorded Runs with this exact policy, including identical copies. Edited starts may have a different policy.'}><Text as="span" role="meta" ink="muted">{runs ?? '—'} {runs === 1 ? 'matching Run' : 'matching Runs'}</Text></span>}
    </span>
  </Button>
}

/** A policy thumbnail reads the full canvas's topology, with one fixed viewport and unscaled, end-truncated role labels. */
export const FlowMiniGraph = ({ policy, empty = false }: { readonly policy?: FlowPolicy | null; readonly empty?: boolean }) => {
  const model = useMemo(() => policy ? flowModel(policy) : null, [policy])
  const layout = useMemo(() => model ? flowLayout(model) : null, [model])
  if (empty || !model?.steps.length || !layout) {
    const knownEmpty = empty || !!model && model.steps.length === 0
    const description = knownEmpty ? 'No steps: a board and a chat.' : 'Graph unavailable'
    return <span data-slot="flow-mini-graph" data-empty={knownEmpty || undefined} role="img" aria-label={description} className={styles.empty}>
      <Text as="span" role="meta" ink="secondary">{description}</Text>
    </span>
  }

  // The thumbnail is one centred grid, not the full canvas scaled down: the
  // canvas widens a step to fit its label, which made one card's steps wide and
  // the next one's narrow, and its margins moved every diagram off the centre.
  // Here a step's column and row come from the canvas layout, and every step in
  // a card is the same width, every gap the same, the whole drawn about one
  // centre line. Labels sit outside any transform so each uses 12px ink.
  const { width, height } = MINI
  const xs = distinct(layout.nodes.map(node => node.box.x)), ys = distinct(layout.nodes.map(node => node.box.y))
  const stepW = Math.min(MINI.stepW, Math.floor((width - MINI.inset * 2 - (xs.length - 1) * MINI.gap) / xs.length))
  const startX = (width - (xs.length * stepW + (xs.length - 1) * MINI.gap)) / 2
  const bandH = ys.length * MINI.stepH + (ys.length - 1) * MINI.rowGap
  const startY = (height - bandH) / 2
  const cells = new Map(layout.nodes.map(node => {
    const col = xs.findIndex(x => Math.abs(x - node.box.x) < 1), row = ys.findIndex(y => Math.abs(y - node.box.y) < 1)
    const x = startX + col * (stepW + MINI.gap), y = startY + row * (MINI.stepH + MINI.rowGap)
    return [node.id, { col, row, x, y, w: stepW, h: MINI.stepH, cx: x + stepW / 2, cy: y + MINI.stepH / 2 }] as const
  }))
  const names = new Map(model.steps.map(step => [step.id, step.name]))
  const rules = new Map(model.rules.map(rule => [rule.id, rule]))
  const edgeWords = (edge: (typeof layout.edges)[number]): string =>
    `${names.get(edge.from)} → ${names.get(edge.to)}${edge.kind === 'loop' ? ' (loops back)' : ''}: ${edge.rules.map(rule => rules.get(rule)?.when).filter(Boolean).join('; ')}`
  const description = `Flow graph: ${model.steps.map(step => step.name).join(', ')}. ${layout.edges.map(edgeWords).join('. ')}`
  return <svg data-slot="flow-mini-graph" role="img" aria-label={description}
    viewBox={`0 0 ${width} ${height}`} className={styles.graph}>
    {layout.edges.map(edge => {
      const from = cells.get(edge.from), to = cells.get(edge.to)
      const route = from && to ? miniRoute(from, to) : null
      return <g key={edge.id} data-edge={edge.id} data-kind={edge.kind} className={styles.edge}>
        <title>{edgeWords(edge)}</title>
        {route && <><path d={route.path} /><polygon points={route.head} /></>}
      </g>
    })}
    {layout.nodes.map(node => {
      const cell = cells.get(node.id)!
      return <g key={node.id} data-step={node.id} className={styles.node}>
        <title>{names.get(node.id)}</title>
        <rect x={cell.x} y={cell.y} width={cell.w} height={cell.h} />
        <foreignObject x={cell.x} y={cell.y} width={cell.w} height={cell.h}>
          <div className={styles.nodeLabel} data-slot="flow-mini-label"><span>{names.get(node.id)}</span></div>
        </foreignObject>
      </g>
    })}
  </svg>
}

/** The thumbnail's fixed geometry, in its own 320 × 72 viewport. */
const MINI = { width: 320, height: 72, inset: 4, stepW: 84, stepH: 24, gap: 24, rowGap: 16, lift: 12, head: 4 } as const

interface MiniCell { readonly col: number; readonly row: number; readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly cx: number; readonly cy: number }

const distinct = (values: readonly number[]): number[] => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.filter((value, index) => index === 0 || value - sorted[index - 1]! >= 1)
}

const arrow = (tipX: number, tipY: number, dx: number, dy: number): string => {
  const length = MINI.head, half = MINI.head * 0.6
  const base = { x: tipX - dx * length, y: tipY - dy * length }
  return `${tipX},${tipY} ${base.x - dy * half},${base.y + dx * half} ${base.x + dy * half},${base.y - dx * half}`
}

/** One line between two steps of the grid: straight along a row or a column, round the end of a row for a loop, and square-cornered between rows. */
const miniRoute = (from: MiniCell, to: MiniCell): { readonly path: string; readonly head: string } => {
  if (from.row === to.row) {
    const forward = to.col > from.col
    if (forward && to.col - from.col === 1) {
      const y = from.cy, x1 = from.x + from.w, x2 = to.x
      return { path: `M${x1} ${y}H${x2 - MINI.head}`, head: arrow(x2, y, 1, 0) }
    }
    // Over or under the steps in between, so the line never runs through one.
    const sign = forward ? -1 : 1
    const y1 = sign < 0 ? from.y : from.y + from.h, y2 = sign < 0 ? to.y : to.y + to.h
    const lift = sign * MINI.lift
    return { path: `M${from.cx} ${y1}C${from.cx} ${y1 + lift} ${to.cx} ${y2 + lift} ${to.cx} ${y2 + sign * MINI.head}`, head: arrow(to.cx, y2, 0, -sign) }
  }
  const down = to.row > from.row
  const y1 = down ? from.y + from.h : from.y
  if (from.col === to.col) {
    const y2 = down ? to.y : to.y + to.h
    return { path: `M${from.cx} ${y1}V${y2 - (down ? MINI.head : -MINI.head)}`, head: arrow(from.cx, y2, 0, down ? 1 : -1) }
  }
  const right = to.col > from.col
  const x2 = right ? to.x : to.x + to.w
  return { path: `M${from.cx} ${y1}V${to.cy}H${x2 - (right ? MINI.head : -MINI.head)}`, head: arrow(x2, to.cy, right ? 1 : -1, 0) }
}

/** Flow destinations and New Team pickers share one content-sized, responsive card grid. */
export const FlowCardGrid = ({ children }: { readonly children: ReactNode }) =>
  <div data-slot="flow-card-grid" className={styles.grid}>{children}</div>
