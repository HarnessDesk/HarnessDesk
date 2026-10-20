import { useMemo, type ReactNode } from 'react'


import {
  FLOW_FAN_INSET, FLOW_FAN_RISE, FLOW_CARD_W, FLOW_CARD_H, FLOW_GAP, FLOW_ROW_GAP, FLOW_MARGIN, flowLayout,
} from '../../lib/flow-layout'
import { stepName, type FlowModel, type FlowStep } from '../../lib/flow-model'
import { ROLE_KIND_WORDS } from '../../lib/shapes'
import { useNarrowLayout } from '../../lib/use-narrow-layout'
import { Card } from '../ui/card'
import { FlowStepSurface, FlowDoingLine } from '../ui/flow-step'
import { type FlowOverlay, type FlowStepRun } from '../../lib/flow-overlay'
import { sanitizeText } from '../../lib/sanitize'

import { formatDuration } from '../../components/TurnTail'
import { AgentIcon } from '../../components/Icons'
import type { Tint } from '../ui/tone'
import { EmptyState } from '../ui/empty-state'
import { ListRows } from '../ui/list-row'
import { FLOW_STEP_KINDS, FlowStepRow, words } from './FlowStepRow'
import { Chip, Row, RowButton, Rows, SectionHead, Text } from './Settings'
import { IssueMark } from './Menu'
import { FlowCanvas, FLOW_CANVAS_CARD_WIDTH, FLOW_CANVAS_RUN_CARD_HEIGHT, type FlowCanvasNodeProps } from './FlowCanvas'


const durationOf = (run: FlowStepRun | undefined, now: number): string | null => {
  if (!run || run.durationMs === null) return null
  const elapsed = run.since !== null && (run.state === 'working' || run.state === 'waiting') ? Math.max(0, now - run.since) : 0
  const total = run.durationMs + elapsed
  return total > 0 ? formatDuration(total) : null
}
const statusOf = (run: FlowStepRun): string => ({ future: 'Not reached', done: 'Done', working: 'Working', waiting: 'Needs you', blocked: 'Waiting', stopping: 'Stopping', stopped: 'Stopped' })[run.state]

/** Sanitize once for both views, then take file objects only from file activity. */
const activityOf = (run: FlowStepRun | undefined, doing: FlowGraphProps['doing']): { text: string; object: string } => {
  const lines = run?.state === 'working' ? [...new Set(run.seats.flatMap(id => {
    const line = doing?.get(id)
    return line ? [words(line)] : []
  }).filter(Boolean))] : []
  const objects = lines.flatMap(line => {
    const target = /^(?:Read|Reading|Edited|Editing|Wrote|Writing|Created|Creating)\s+(.+)$/i.exec(line)?.[1]
    return target && target !== 'a file' && target !== 'files' ? [target.split(/[/\\]/).at(-1)!] : []
  })
  return { text: lines.join(' · '), object: [...new Set(objects)].join(' · ') }
}
const lineOf = (step: FlowStep, run: FlowStepRun | undefined, object: string): string =>
  run?.state === 'working' ? object || ROLE_KIND_WORDS[step.kind] : run?.state === 'stopped' || run?.state === 'stopping' ? statusOf(run) : words(run?.line ?? step.line)

/** A working Agent shows an activity object; otherwise its line keeps the command or ceiling title. */
const titleOf = (step: FlowStep, run: FlowStepRun | undefined, object: string): string =>
  step.kind === 'agent' && run?.state === 'working' ? lineOf(step, run, object) : sanitizeText(step.title ?? lineOf(step, run, object))


export interface FlowGraphProps {
  readonly model: FlowModel
  readonly overlay?: FlowOverlay
  readonly stepContent?: ReadonlyMap<string, ReactNode>
  readonly cardHeight?: number
  readonly selectedRule?: string | null
  readonly onSelectRule?: (rule: string) => void
  readonly selectedStep?: string | null
  readonly onSelectStep?: (step: string) => void
  readonly faces?: ReadonlyMap<string, ReactNode>
  readonly faceTints?: ReadonlyMap<string, Tint>
  readonly doing?: ReadonlyMap<string, string | null>
  readonly now?: number
  readonly title?: ReactNode
  readonly actions?: ReactNode
  readonly showControls?: boolean
  readonly inert?: boolean
  /**
   * Where the Steps and Rules list is read. `below`, the default, puts it under the drawing at every width.
   * `inline` keeps a finite 360px canvas above an inline activity record; the page owns vertical scrolling.
   * `summary` keeps the measured drawing height with the list as a text alternative.
   * `dock` leaves it to the Team's Steps dock at every width: the drawing keeps the whole pane and the list stays here only as the text alternative.
   * `responsive` is for a Run outside the dock: the text alternative in a wide pane, and under a drawing fitted to the pane once it is narrow.
   */
  readonly listPlacement?: 'below' | 'dock' | 'responsive' | 'summary' | 'inline'
}

/** The frozen Flow on the shared read-only canvas, with recorded state and an accessible Steps seam for the Team dock. */
export const FlowGraph = ({ model, overlay, selectedStep, onSelectStep, stepContent, cardHeight = FLOW_CANVAS_RUN_CARD_HEIGHT, selectedRule, onSelectRule, faces, faceTints, doing, now = Date.now(), title, actions, showControls, inert, listPlacement = 'below' }: FlowGraphProps) => {
  const { ref, narrow } = useNarrowLayout<HTMLDivElement>(608)
  const listDocked = listPlacement === 'inline' || listPlacement === 'dock' || (listPlacement === 'responsive' && narrow !== true)
  const listHidden = listDocked || listPlacement === 'summary'
  const layout = useMemo(() => (model.steps.length === 0 ? null : flowLayout(model)), [model])
  if (layout === null) {
    return <Text role="muted" as="p" data-slot="flow-graph">This Flow has no steps.</Text>
  }
  const stepsById = new Map(model.steps.map((step) => [step.id, step]))
  const activities = new Map(model.steps.map(step => [step.id, activityOf(overlay?.steps.get(step.id), doing)]))
  const kindOfRule = new Map(layout.edges.flatMap((edge) => edge.rules.map((id) => [id, edge.kind] as const)))
  const xScale = (FLOW_CANVAS_CARD_WIDTH + FLOW_GAP) / (FLOW_CARD_W + FLOW_GAP)
  const yScale = (cardHeight + FLOW_ROW_GAP) / (FLOW_CARD_H + FLOW_ROW_GAP)
  const extent = Math.ceil(layout.height * yScale + FLOW_MARGIN)
  const controlsSpace = showControls !== false && !inert ? stepContent ? ' + var(--hd-space-8)' : ' + var(--hd-space-16)' : ''
  const readingHeight = controlsSpace ? `calc(${extent}px${controlsSpace})` : extent
  const nodes = layout.nodes.map(node => {
    const step = stepsById.get(node.id)!
    const run = overlay?.steps.get(node.id), selected = selectedStep === node.id, activity = activities.get(node.id)!
    const { Mark } = FLOW_STEP_KINDS[step.kind]
    const seats = step.kind === 'agent' ? run?.seats : undefined
    return {
      id: node.id, position: { x: node.box.x * xScale, y: node.box.y * yScale },
      size: { width: FLOW_CANVAS_CARD_WIDTH, height: cardHeight },
      data: { name: step.name, kind: step.kind }, state: overlay?.steps.get(node.id)?.state,
      selected: selectedStep === node.id,
      stateSlot: <><div
      data-slot="flow-step"
      data-step={step.id}
      data-kind={step.kind}
      data-state={run?.state}
      data-selected={selected || undefined}
      className="relative h-full w-full"
    >
      {/* The cards behind the front one, farthest first, so a count reads without a number. */}
      {Array.from({ length: node.fan }, (_, index) => node.fan - index).map((depth) => (
        <Card
          key={depth}
          spacing="flush"
          aria-hidden="true"
          data-behind=""
          className="absolute"
          style={{ left: depth * FLOW_FAN_INSET, right: depth * FLOW_FAN_INSET, top: -depth * FLOW_FAN_RISE, height: cardHeight }}
        />
      ))}
      <FlowStepSurface custom={stepContent?.has(step.id)} state={run?.state} selected={selected} duration={durationOf(run, now)} runs={run?.runs}>
        {stepContent?.has(step.id) ? <div className="nodrag nopan nowheel min-w-0 h-full" onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>{stepContent.get(step.id)}</div> : <>
        <span data-slot="flow-node-mark" className="inline-flex size-8 shrink-0 items-center justify-center text-(--hd-muted-foreground) [&_svg]:size-5 [&_svg]:shrink-0"
          role={seats?.length ? 'img' : undefined} aria-label={seats?.length ? `${seats.length} ${seats.length === 1 ? 'seat' : 'seats'}` : undefined} aria-hidden={seats?.length ? undefined : true}>
          {seats?.length === 1 ? faces?.get(seats[0]!) ?? <AgentIcon size={20} /> : <Mark size={20} />}
        </span>
        <Text role="row" ink={run?.state === 'future' ? 'secondary' : undefined} truncate title={step.name}>{step.name}</Text>
        <Text role="meta" className="col-start-2" ink={run?.state === 'future' ? 'muted' : undefined} truncate={step.kind !== 'agent' || run?.state === 'working'} title={titleOf(step, run, activity.object)}>{lineOf(step, run, activity.object)}</Text>
        </>}
      </FlowStepSurface>
    </div>{activity.text &&
        <span data-slot="flow-doing" className="absolute top-full mt-2 whitespace-nowrap text-center pointer-events-none" style={{ left: 'calc(var(--hd-space-3) + var(--hd-border-width))', right: 'calc(var(--hd-space-3) + var(--hd-border-width))' }}><FlowDoingLine text={activity.text} /></span>}

    </>,
    }
  })
  const edges = layout.edges.map(edge => {
    const count = edge.rules.reduce((sum, id) => sum + (overlay?.rules.get(id)?.count ?? 0), 0)
    return { id: edge.id, selected: selectedRule != null && edge.rules.includes(selectedRule), source: edge.from, target: edge.to, loop: edge.kind === 'loop',
      label: edge.label ? `${edge.label.text}${edge.kind === 'loop' && count ? ` ×${count}` : ''}` : undefined,
      state: overlay ? count ? 'travelled' as const : 'future' as const : undefined,
      current: edge.rules.some(id => overlay?.rules.get(id)?.current),
    }
  })
  return (
    <div ref={ref} data-slot="flow-graph" style={{ containerType: 'inline-size' }} className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
      <div data-slot="flow-drawing" className="min-h-0 flex-1" style={listPlacement === 'inline' ? { height: 360, flex: 'none' } : listDocked ? undefined : narrow ? {
        minHeight: readingHeight,
        height: `calc(100cqw * ${(layout.height * yScale + FLOW_MARGIN) / (layout.width * xScale + FLOW_MARGIN)}${controlsSpace})`, flex: 'none',
      } : { height: readingHeight, flex: 'none' }}>
        <FlowCanvas nodes={nodes} edges={edges} minZoom={stepContent ? 0.8 : undefined} readOnly title={title} actions={actions} showControls={showControls} inert={inert} NodeComponent={RunStep}
          onEdgesChange={changes => {
            const selection = changes.find(change => change.type === 'select' && change.selected)
            const edge = selection && layout.edges.find(edge => edge.id === selection.id)
            const rule = edge && (selectedRule && edge.rules.includes(selectedRule) ? selectedRule : edge.rules[0])
            if (rule) onSelectRule?.(rule)
          }}
          onNodesChange={changes => { const selection = changes.find(change => change.type === 'select' && change.selected); if (selection && selection.id !== selectedStep) onSelectStep?.(selection.id) }} />
      </div>
      <div data-slot="flow-list" data-placement={listDocked ? 'dock' : listPlacement === 'summary' ? 'summary' : 'below'} className={listHidden ? 'sr-only' : 'flex min-w-0 flex-col gap-4'}>
        <section aria-label="Steps">
          <SectionHead name="Steps" />
          <ListRows>
            {model.steps.map((step) => {
              const run = overlay?.steps.get(step.id)
              const activity = activities.get(step.id)!
              const more = [...(step.count > 1 ? [`${step.count} at once`] : []), ...step.agents]
              return <FlowStepRow key={step.id} step={step} run={run} selected={selectedStep === step.id}
                onSelect={onSelectStep} faces={faces} faceTints={faceTints} now={now}
                tabIndex={onSelectStep && listHidden ? -1 : undefined}
                subtitle={<span title={titleOf(step, run, activity.object)}>{[step.kind === 'agent' && (run?.state === 'stopped' || run?.state === 'stopping') ? step.line : lineOf(step, run, activity.object), activity.text, ...more].filter(Boolean).join(' · ')}</span>}
              />
            })}
          </ListRows>
        </section>

        <section aria-label="Rules">
          <SectionHead name="Rules" />
          <Rows>
            {model.rules.length === 0 && <EmptyState variant="row" title="No rules" description="The first round runs, then the Run ends." />}
            {model.rules.map((rule) => {
              const title = (
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate">{`${stepsById.get(rule.on)?.name ?? stepName(rule.on)} → ${stepsById.get(rule.to)?.name ?? stepName(rule.to)}`}</span>
                    {kindOfRule.get(rule.id) === 'loop' && <Chip size="sm" tone="neutral">Loops back{overlay?.rules.get(rule.id)?.count ? ` ×${overlay.rules.get(rule.id)!.count}` : ''}</Chip>}
                  </span>
                )
              return onSelectRule
                ? <RowButton key={rule.id} data-rule={rule.id} title={title} desc={rule.when}
                    onClick={() => onSelectRule(rule.id)} chevron={false} aria-pressed={selectedRule === rule.id} tabIndex={listHidden ? -1 : undefined} />
                : <Row key={rule.id} title={title} desc={rule.when} />
            })}
          </Rows>
        </section>
      </div>
    </div>
  )
}

const RunStep = ({ node }: FlowCanvasNodeProps) => <>{node.stateSlot}</>

/** Editable seats inside a measured Flow node, with the same header and control edges for every role. */
export const FlowRoleConfiguration = ({ label, seats }: {
  readonly label: string
  readonly seats: readonly {
    readonly key: string
    readonly title: ReactNode
    readonly mark: ReactNode
    readonly instructions: string
    readonly control: ReactNode
    readonly problem?: string | null
    readonly badge?: ReactNode
  }[]
}) => (
  <div data-slot="team-role-configuration" aria-label={label} className="flex h-full min-h-0 min-w-0 flex-col gap-3 overflow-auto">
    {seats.length === 0 && <Text role="meta">Reading agents…</Text>}
    {seats.map(seat => <div key={seat.key} data-slot="team-role-seat" className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span data-slot="team-role-mark" className="flex size-8 shrink-0 items-center justify-center">{seat.mark}</span>
        <Text role="row" truncate>{seat.title}</Text>
        {seat.badge}
      </div>
      <Text role="meta" truncate title={seat.instructions}>{seat.instructions}</Text>
      <div className="flex w-full min-w-0 flex-col gap-1">{seat.control}</div>
      {seat.problem && <IssueMark message={seat.problem} />}
    </div>)}
  </div>
)
