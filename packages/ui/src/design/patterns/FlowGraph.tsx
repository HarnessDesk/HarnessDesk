import { useMemo, type ReactNode } from 'react'


import {
  FLOW_FAN_INSET, FLOW_FAN_RISE, FLOW_CARD_W, FLOW_CARD_H, FLOW_GAP, FLOW_ROW_GAP, FLOW_MARGIN, flowLayout,
  type FlowNode,
} from '../../lib/flow-layout'
import { stepName, type FlowModel, type FlowStep } from '../../lib/flow-model'
import { ROLE_KIND_WORDS } from '../../lib/shapes'
import { useNarrowLayout } from '../../lib/use-narrow-layout'
import { Card } from '../ui/card'
import { FlowStepSurface, FlowFaces, FlowDoingLine } from '../ui/flow-step'
import { type FlowOverlay, type FlowStepRun } from '../../lib/flow-overlay'
import { sanitizeText } from '../../lib/sanitize'

import { formatDuration } from '../../components/TurnTail'
import { IconTile } from '../ui/icon-tile'
import type { Tint } from '../ui/tone'
import { EmptyState } from '../ui/empty-state'
import { ListRows } from '../ui/list-row'
import { FLOW_STEP_KINDS, FlowStepRow, words } from './FlowStepRow'
import { Chip, Row, Rows, SectionHead, Text } from './Settings'
import { FlowCanvas, FLOW_CANVAS_CARD_WIDTH, FLOW_CANVAS_RUN_CARD_HEIGHT, type FlowCanvasNodeProps } from './FlowCanvas'


const durationOf = (run: FlowStepRun | undefined, now: number): string | null => {
  if (!run || run.durationMs === null) return null
  const elapsed = run.since !== null && (run.state === 'working' || run.state === 'waiting') ? Math.max(0, now - run.since) : 0
  return formatDuration(run.durationMs + elapsed)
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

const StepCard = ({ node, step, run, selected, faces, faceTints, activity, now }: {
  node: FlowNode; step: FlowStep; run?: FlowStepRun; selected: boolean; faces?: ReadonlyMap<string, ReactNode>
  faceTints?: ReadonlyMap<string, Tint>; activity: { text: string; object: string }; now: number
}) => {
  const { tint, Mark } = FLOW_STEP_KINDS[step.kind]
  return (
    <div
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
          style={{ left: depth * FLOW_FAN_INSET, right: depth * FLOW_FAN_INSET, top: -depth * FLOW_FAN_RISE, height: node.box.h }}
        />
      ))}
      <FlowStepSurface state={run?.state} selected={selected} duration={durationOf(run, now)} runs={run?.runs}>
        <FlowFaces seats={step.kind === 'agent' ? run?.seats : undefined} faces={faces} tints={faceTints} fallback={<IconTile tint={tint}><Mark /></IconTile>} />
        <Text role="row" ink={run?.state === 'future' ? 'secondary' : undefined} truncate className={run?.state === 'working' || run?.state === 'blocked' ? 'max-w-12' : run?.state === 'waiting' ? 'max-w-10' : undefined} title={step.name}>{step.name}</Text>
        <Text role="meta" className="col-start-2" ink={run?.state === 'future' ? 'muted' : undefined} truncate={step.kind !== 'agent' || run?.state === 'working'} title={titleOf(step, run, activity.object)}>{lineOf(step, run, activity.object)}</Text>
      </FlowStepSurface>
      {activity.text &&
        <span data-slot="flow-doing" className="absolute bottom-4 left-3 right-3 whitespace-nowrap text-center pointer-events-none"><FlowDoingLine text={activity.text} /></span>}

    </div>
  )
}

export interface FlowGraphProps {
  readonly model: FlowModel
  readonly overlay?: FlowOverlay
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
   * `dock` leaves it to the Team's Steps dock at every width: the drawing keeps the whole pane and the list stays here only as the text alternative.
   * `responsive` is for a Run outside the dock: the text alternative in a wide pane, and under a drawing fitted to the pane once it is narrow.
   */
  readonly listPlacement?: 'below' | 'dock' | 'responsive'
}

/** The frozen Flow on the shared read-only canvas, with recorded state and an accessible Steps seam for the Team dock. */
export const FlowGraph = ({ model, overlay, selectedStep, onSelectStep, faces, faceTints, doing, now = Date.now(), title, actions, showControls, inert, listPlacement = 'below' }: FlowGraphProps) => {
  const { ref, narrow } = useNarrowLayout<HTMLDivElement>(608)
  const listDocked = listPlacement === 'dock' || (listPlacement === 'responsive' && narrow !== true)
  const layout = useMemo(() => (model.steps.length === 0 ? null : flowLayout(model)), [model])
  if (layout === null) {
    return <Text role="muted" as="p" data-slot="flow-graph">This Flow has no steps.</Text>
  }
  const stepsById = new Map(model.steps.map((step) => [step.id, step]))
  const activities = new Map(model.steps.map(step => [step.id, activityOf(overlay?.steps.get(step.id), doing)]))
  const kindOfRule = new Map(layout.edges.flatMap((edge) => edge.rules.map((id) => [id, edge.kind] as const)))
  const xScale = (FLOW_CANVAS_CARD_WIDTH + FLOW_GAP) / (FLOW_CARD_W + FLOW_GAP)
  const yScale = (FLOW_CANVAS_RUN_CARD_HEIGHT + FLOW_ROW_GAP) / (FLOW_CARD_H + FLOW_ROW_GAP)
  const nodes = layout.nodes.map(node => {
    const step = stepsById.get(node.id)!
    return {
      id: node.id, position: { x: node.box.x * xScale, y: node.box.y * yScale },
      size: { width: FLOW_CANVAS_CARD_WIDTH, height: FLOW_CANVAS_RUN_CARD_HEIGHT },
      data: { name: step.name, kind: step.kind }, state: overlay?.steps.get(node.id)?.state,
      selected: selectedStep === node.id,
      stateSlot: <StepCard node={node} step={step} run={overlay?.steps.get(node.id)} selected={selectedStep === node.id}
        faces={faces} faceTints={faceTints} activity={activities.get(node.id)!} now={now} />,
    }
  })
  const edges = layout.edges.map(edge => {
    const count = edge.rules.reduce((sum, id) => sum + (overlay?.rules.get(id)?.count ?? 0), 0)
    return { id: edge.id, source: edge.from, target: edge.to, loop: edge.kind === 'loop',
      label: edge.label ? `${edge.label.text}${edge.kind === 'loop' && count ? ` ×${count}` : ''}` : undefined,
      state: overlay ? count ? 'travelled' as const : 'future' as const : undefined,
      current: edge.rules.some(id => overlay?.rules.get(id)?.current),
    }
  })
  return (
    <div ref={ref} data-slot="flow-graph" style={{ containerType: 'inline-size' }} className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
      <div data-slot="flow-drawing" className="min-h-0 flex-1" style={listDocked ? undefined : narrow ? {
        height: `calc(100cqw * ${(layout.height * yScale + FLOW_MARGIN) / (layout.width * xScale + FLOW_MARGIN)}${showControls !== false && !inert ? ' + var(--hd-space-16)' : ''})`, flex: 'none',
      } : { height: Math.ceil(layout.height * yScale + FLOW_MARGIN), flex: 'none' }}>
        <FlowCanvas nodes={nodes} edges={edges} readOnly title={title} actions={actions} showControls={showControls} inert={inert} NodeComponent={RunStep}
          onNodesChange={changes => { const selection = changes.find(change => change.type === 'select' && change.selected); if (selection && selection.id !== selectedStep) onSelectStep?.(selection.id) }} />
      </div>
      <div data-slot="flow-list" data-placement={listDocked ? 'dock' : 'below'} className={listDocked ? 'sr-only' : 'flex min-w-0 flex-col gap-4'}>
        <section aria-label="Steps">
          <SectionHead name="Steps" />
          <ListRows>
            {model.steps.map((step) => {
              const run = overlay?.steps.get(step.id)
              const activity = activities.get(step.id)!
              const more = [...(step.count > 1 ? [`${step.count} at once`] : []), ...step.agents]
              return <FlowStepRow key={step.id} step={step} run={run} selected={selectedStep === step.id}
                onSelect={onSelectStep} faces={faces} faceTints={faceTints} now={now}
                tabIndex={onSelectStep && listDocked ? -1 : undefined}
                subtitle={<span title={titleOf(step, run, activity.object)}>{[step.kind === 'agent' && (run?.state === 'stopped' || run?.state === 'stopping') ? step.line : lineOf(step, run, activity.object), activity.text, ...more].filter(Boolean).join(' · ')}</span>}
              />
            })}
          </ListRows>
        </section>

        <section aria-label="Rules">
          <SectionHead name="Rules" />
          <Rows>
            {model.rules.length === 0 && <EmptyState variant="row" title="No rules" description="The first round runs, then the Run ends." />}
            {model.rules.map((rule) => (
              <Row
                key={rule.id}
                title={
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate">{`${stepsById.get(rule.on)?.name ?? stepName(rule.on)} → ${stepsById.get(rule.to)?.name ?? stepName(rule.to)}`}</span>
                    {kindOfRule.get(rule.id) === 'loop' && <Chip size="sm" tone="neutral">Loops back{overlay?.rules.get(rule.id)?.count ? ` ×${overlay.rules.get(rule.id)!.count}` : ''}</Chip>}
                  </span>
                }
                desc={rule.when}
              />
            ))}
          </Rows>
        </section>
      </div>
    </div>
  )
}

const RunStep = ({ node }: FlowCanvasNodeProps) => <>{node.stateSlot}</>
