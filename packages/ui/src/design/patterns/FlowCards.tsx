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

  // Fit geometry into a constant thumbnail, never fitting the SVG viewport to
  // the graph: that made a two-step Flow's labels twice the size of four steps.
  // Labels sit outside the geometry transform so every topology uses 12px ink.
  const width = 320, height = 72, inset = 4
  const scaleX = (width - inset * 2) / layout.width
  const scaleY = (height - inset * 2) / layout.height
  const names = new Map(model.steps.map(step => [step.id, step.name]))
  const rules = new Map(model.rules.map(rule => [rule.id, rule]))
  const edgeWords = (edge: (typeof layout.edges)[number]): string =>
    `${names.get(edge.from)} → ${names.get(edge.to)}${edge.kind === 'loop' ? ' (loops back)' : ''}: ${edge.rules.map(rule => rules.get(rule)?.when).filter(Boolean).join('; ')}`
  const description = `Flow graph: ${model.steps.map(step => step.name).join(', ')}. ${layout.edges.map(edgeWords).join('. ')}`
  return <svg data-slot="flow-mini-graph" role="img" aria-label={description}
    viewBox={`0 0 ${width} ${height}`} className={styles.graph}>
    {layout.edges.map(edge => <g key={edge.id} data-edge={edge.id} data-kind={edge.kind} className={styles.edge}>
      <title>{edgeWords(edge)}</title>
      <g transform={`translate(${inset} ${inset}) scale(${scaleX} ${scaleY})`}>
        <path d={edge.path} vectorEffect="non-scaling-stroke" />
        <polygon points={edge.head.map(point => `${point.x},${point.y}`).join(' ')} />
      </g>
    </g>)}
    {layout.nodes.map(node => <g key={node.id} data-step={node.id} className={styles.node}>
      <title>{names.get(node.id)}</title>
      <rect x={inset + node.box.x * scaleX} y={inset + node.box.y * scaleY} width={node.box.w * scaleX} height={node.box.h * scaleY} />
      <foreignObject x={inset + node.box.x * scaleX} y={inset + node.box.y * scaleY} width={node.box.w * scaleX} height={node.box.h * scaleY}>
        <div className={styles.nodeLabel} data-slot="flow-mini-label"><span>{names.get(node.id)}</span></div>
      </foreignObject>
    </g>)}
  </svg>
}

/** Flow destinations and New Team pickers share one content-sized, responsive card grid. */
export const FlowCardGrid = ({ children }: { readonly children: ReactNode }) =>
  <div data-slot="flow-card-grid" className={styles.grid}>{children}</div>
