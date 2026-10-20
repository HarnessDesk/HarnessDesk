import { useId, useMemo, type ReactNode } from 'react'
import type { FlowPolicy } from '@harnessdesk/protocol'

import { FLOW_CARD_H, FLOW_CARD_W, FLOW_GAP, flowLayout } from '../../lib/flow-layout'
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

/** The chosen policy stays inspectable while its full catalogue is folded away. */
export const SelectedFlow = ({ name, origin, policy, empty, loading = false, disabled, onChange }: {
  readonly name: string
  readonly origin: string
  readonly policy?: FlowPolicy | null
  readonly empty?: boolean
  /** The selected source is still being read; absence of a policy is not yet a graph failure. */
  readonly loading?: boolean
  readonly disabled?: boolean
  readonly onChange: () => void
}) => <section data-slot="selected-flow" aria-label="Selected Flow" aria-busy={loading || undefined} className={styles.selection}>
  <div className={styles.selectionHead}>
    <div className={styles.selectionName}><Text as="span" role="subject" truncate title={name}>{name}</Text><Chip size="sm" tone="neutral">{origin}</Chip></div>
    <Button variant="outline" size="sm" disabled={disabled} onClick={onChange}>Change</Button>
  </div>
  <div className={styles.selectionGraph}>{loading
    ? <span data-slot="flow-mini-graph" role="status" className={styles.empty}><Text as="span" role="meta" ink="secondary">Reading Flow…</Text></span>
    : <FlowMiniGraph policy={policy} empty={empty} />}</div>
</section>

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
  // canvas lays every step out at its own distance, which made one card's steps
  // loose and the next one's tight, and its margins moved every diagram off the
  // centre. Here the columns come from the steps on the main road (the top row),
  // a step hanging below sits at its own place between them, every step is the
  // same width, every gap the same, and the whole is drawn about one centre line.
  // A Flow whose cards were dragged is read with a tolerance of half a card, and
  // a drawing too big for the thumbnail is scaled about its centre to fit it.
  const grid = miniGrid(layout.nodes.map(node => ({ id: node.id, x: node.box.x, y: node.box.y })))
  const rowsOf = grid.rows, span = grid.span
  const selfs = layout.edges.some(edge => edge.from === edge.to)
  const lift = rowsOf > 2 ? MINI.lift - 4 : MINI.lift
  const over = layout.edges.some(edge => { const a = grid.cells.get(edge.from), b = grid.cells.get(edge.to); return a && b && a.row === 0 && b.row === 0 && b.pos - a.pos > 1 })
  const under = layout.edges.some(edge => { const a = grid.cells.get(edge.from), b = grid.cells.get(edge.to); return a && b && a.row === rowsOf - 1 && b.row === rowsOf - 1 && edge.from !== edge.to && b.pos <= a.pos })
  const stepH = rowsOf <= 2 ? MINI.stepH : MINI.stepH - 8, rowGap = rowsOf === 2 ? MINI.rowGap : rowsOf > 2 ? MINI.rowGap / 2 : 0
  const selfRoom = selfs ? MINI.selfOut : 0
  const stepW = Math.max(MINI.minW, Math.min(MINI.stepW, Math.floor((MINI.width - MINI.inset * 2 - selfRoom - span * MINI.gap) / (span + 1))))
  const pitch = stepW + MINI.gap
  const topClear = over ? lift * 0.75 : 0, bottomClear = under ? lift * 0.75 : 0
  const totalW = span * pitch + stepW + selfRoom, totalH = topClear + rowsOf * stepH + (rowsOf - 1) * rowGap + bottomClear
  const left = (MINI.width - totalW) / 2, top = (MINI.height - totalH) / 2 + topClear
  const fit = Math.min(1, (MINI.width - MINI.inset * 2) / totalW, (MINI.height - MINI.inset * 2) / totalH)
  const cells = new Map([...grid.cells].map(([id, cell]) => {
    const x = left + cell.pos * pitch, y = top + cell.row * (stepH + rowGap)
    return [id, { col: cell.pos, row: cell.row, x, y, w: stepW, h: stepH, cx: x + stepW / 2, cy: y + stepH / 2 }] as const
  }))
  const names = new Map(model.steps.map(step => [step.id, step.name]))
  const rules = new Map(model.rules.map(rule => [rule.id, rule]))
  const edgeWords = (edge: (typeof layout.edges)[number]): string =>
    `${names.get(edge.from)} → ${names.get(edge.to)}${edge.kind === 'loop' ? ' (loops back)' : ''}: ${edge.rules.map(rule => rules.get(rule)?.when).filter(Boolean).join('; ')}`
  const description = `Flow graph: ${model.steps.map(step => step.name).join(', ')}. ${layout.edges.map(edgeWords).join('. ')}`
  return <svg data-slot="flow-mini-graph" role="img" aria-label={description}
    viewBox={`0 0 ${MINI.width} ${MINI.height}`} className={styles.graph}>
    <g {...(fit < 1 ? { transform: `translate(${MINI.width / 2} ${MINI.height / 2}) scale(${fit}) translate(${-MINI.width / 2} ${-MINI.height / 2})` } : {})}>
      {layout.edges.map(edge => {
        const from = cells.get(edge.from), to = cells.get(edge.to)
        const route = from && to ? miniRoute(from, to, lift) : null
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
    </g>
  </svg>
}

/** The thumbnail's fixed geometry, in its own 320 × 72 viewport. */
const MINI = { width: 320, height: 72, inset: 4, stepW: 84, minW: 40, stepH: 24, gap: 24, rowGap: 16, lift: 12, head: 4, selfOut: 10 } as const

interface MiniCell { readonly col: number; readonly row: number; readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly cx: number; readonly cy: number }

const mean = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length

/** Values within `tolerance` of the one before them are one group; each group is named by its mean. */
const clusters = (values: readonly number[], tolerance: number): number[] => {
  const groups: number[][] = []
  for (const value of [...values].sort((a, b) => a - b)) {
    const last = groups[groups.length - 1]
    if (last && value - last[last.length - 1]! <= tolerance) last.push(value)
    else groups.push([value])
  }
  return groups.map(mean)
}
const nearest = (centres: readonly number[], value: number): number =>
  centres.reduce((best, centre, index) => Math.abs(centre - value) < Math.abs(centres[best]! - value) ? index : best, 0)

/**
 * Rows and columns of a Flow's cards. A row is a band of y; the columns are the
 * steps of the top row, where the main road runs, and a step in a lower row sits
 * between them, at the nearest half column, where the canvas put it. No two steps
 * of one row are closer than a whole column, so none is drawn over another.
 */
const miniGrid = (nodes: readonly { readonly id: string; readonly x: number; readonly y: number }[]): { readonly cells: Map<string, { readonly pos: number; readonly row: number }>; readonly rows: number; readonly span: number } => {
  const rowCentres = clusters(nodes.map(node => node.y), FLOW_CARD_H / 2)
  const rowOf = new Map(nodes.map(node => [node.id, nearest(rowCentres, node.y)] as const))
  const columns = clusters(nodes.filter(node => rowOf.get(node.id) === 0).map(node => node.x), FLOW_CARD_W / 2)
  const place = (x: number): number => {
    const k = Math.min(columns.reduce((last, centre, index) => centre <= x ? index : last, 0), Math.max(columns.length - 2, 0))
    const lo = columns[k]!, hi = columns[k + 1]
    const step = hi !== undefined && hi > lo ? hi - lo : FLOW_CARD_W + FLOW_GAP
    return Math.round((k + (x - lo) / step) * 2) / 2
  }
  const pos = new Map<string, number>()
  for (const node of nodes) pos.set(node.id, rowOf.get(node.id) === 0 ? nearest(columns, node.x) : place(node.x))
  for (let row = 0; row < rowCentres.length; row++) {
    const inRow = nodes.filter(node => rowOf.get(node.id) === row).sort((a, b) => a.x - b.x)
    inRow.forEach((node, index) => {
      const before = inRow[index - 1]
      if (before && pos.get(node.id)! < pos.get(before.id)! + 1) pos.set(node.id, pos.get(before.id)! + 1)
    })
  }
  const least = Math.min(...pos.values())
  const cells = new Map(nodes.map(node => [node.id, { pos: pos.get(node.id)! - least, row: rowOf.get(node.id)! }] as const))
  return { cells, rows: rowCentres.length, span: Math.max(...[...cells.values()].map(cell => cell.pos)) }
}

const arrow = (tipX: number, tipY: number, dx: number, dy: number): string => {
  const length = MINI.head, half = MINI.head * 0.6
  const base = { x: tipX - dx * length, y: tipY - dy * length }
  return `${tipX},${tipY} ${base.x - dy * half},${base.y + dx * half} ${base.x + dy * half},${base.y - dx * half}`
}

/** One line between two steps of the grid: straight to a neighbour, round the steps in between for a skip or a loop, and square-cornered between rows. */
const miniRoute = (from: MiniCell, to: MiniCell, lift: number): { readonly path: string; readonly head: string } => {
  if (from === to) {
    // A step that returns to itself: a small arc off its right edge.
    const x = from.x + from.w, out = MINI.selfOut, reach = from.h / 4
    return { path: `M${x} ${from.cy - reach}C${x + out} ${from.cy - reach - 2} ${x + out} ${from.cy + reach + 2} ${x + MINI.head} ${from.cy + reach}`, head: arrow(x, from.cy + reach, -1, 0) }
  }
  if (from.row === to.row) {
    const forward = to.col > from.col
    if (forward && Math.abs(to.col - from.col - 1) < 0.01) {
      const y = from.cy, x1 = from.x + from.w, x2 = to.x
      return { path: `M${x1} ${y}H${x2 - MINI.head}`, head: arrow(x2, y, 1, 0) }
    }
    // Over or under the steps in between, so the line never runs through one.
    const sign = forward ? -1 : 1
    const y1 = sign < 0 ? from.y : from.y + from.h, y2 = sign < 0 ? to.y : to.y + to.h
    const bow = sign * lift
    return { path: `M${from.cx} ${y1}C${from.cx} ${y1 + bow} ${to.cx} ${y2 + bow} ${to.cx} ${y2 + sign * MINI.head}`, head: arrow(to.cx, y2, 0, -sign) }
  }
  const down = to.row > from.row
  const y1 = down ? from.y + from.h : from.y
  if (Math.abs(from.col - to.col) < 0.01) {
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
