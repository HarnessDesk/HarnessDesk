import { useId, useMemo, type ReactNode } from 'react'

import { AgentIcon, TerminalIcon, RetryIcon, UserIcon } from '../../components/Icons'
import {
  FLOW_FAN_INSET, FLOW_FAN_RISE, FLOW_GRID, FLOW_MARGIN, flowLayout,
  type FlowEdge, type FlowLabel, type FlowNode,
} from '../../lib/flow-layout'
import { stepName, type FlowModel, type FlowStep, type StepKind } from '../../lib/flow-model'
import { ROLE_KIND_WORDS } from '../../lib/shapes'
import { Card } from '../ui/card'
import { FlowBaton, FlowStepSurface, FlowFaces, FlowRouteLabel, FlowDoingLine } from '../ui/flow-step'
import { flowOverlayLabels, type FlowOverlay, type FlowStepRun } from '../../lib/flow-overlay'
import { sanitizeHtml, sanitizeText } from '../../lib/sanitize'
import { formatDuration } from '../../components/TurnTail'
import { IconTile } from '../ui/icon-tile'
import type { Tint } from '../ui/tone'
import { Chip, Row, RowButton, Rows, SectionHead, Text } from './Settings'

/**
 * A Flow, drawn to be looked at and read from the list under it.
 *
 * A step is a card: a mark for what it is, its name in a word, and one earned
 * line. A rule is a line with an arrowhead and, if anything guards it, the
 * outcome word that takes it. Steps run left to right in the order their rules
 * reach them; a loop falls under the line with a retry mark on its word; a
 * Flow's own `layout.positions` win. Where everything goes is
 * `lib/flow-layout`'s, a pure function of the model, so this only draws it.
 *
 * Quiet by default: cards on a faint dot grid, hairline borders, one soft
 * shadow. Colour is for what a step is, never decoration, and every value is a
 * token, so a palette, density or faces change reaches the drawing. The kind
 * tints are the ones the rail already uses, and an Agent is a *thing* here, a
 * square tile: once a Run seats it, it becomes someone.
 *
 * The drawing is for the eye. It is `aria-hidden`, and the lists under it say
 * the same steps and rules in words, so a screen reader, a keyboard and a
 * window too narrow for the drawing all reach everything the lines show. Below
 * a narrow width the list is the view.
 *
 * Its curves and arrowheads are data geometry, as a chart's are: attributes on
 * SVG marks, taken from `--hd-*` tokens, and recorded as that in the design
 * audit's list rather than excused.
 *
 * With an overlay, the recorded route is bold, done nodes keep their badge and
 * time, and current work has the breathing ring and incoming baton. Seated
 * marks become faces, and a person waiting takes the warning ring. Reduced
 * motion stops both animations; without an overlay nothing moves. The list
 * says the same live state and supports the step selection shared with the
 * Timeline, so repeated steps keep all their history selected.
 */

const KIND: Readonly<Record<StepKind, { readonly tint: Tint; readonly Mark: typeof AgentIcon }>> = {
  agent: { tint: 'violet', Mark: AgentIcon },
  check: { tint: 'sky', Mark: TerminalIcon },
  person: { tint: 'amber', Mark: UserIcon },
}

/** Lines, arrowheads and the dots of the grid: tokens, never a colour of their own. */
const INK = 'var(--hd-muted-foreground)'
const INK_SOFT = 'var(--hd-border-strong)'
const LINE_WIDTH = 1.5
const LINE_OPACITY = 0.6

const points = (head: FlowEdge['head']): string => head.map((one) => `${Math.round(one.x * 10) / 10},${Math.round(one.y * 10) / 10}`).join(' ')

const words = (value: string): string => {
  const box = document.createElement('template')
  box.innerHTML = sanitizeHtml(value)
  return box.content.textContent ?? ''
}
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

const StepCard = ({ node, drawingWidth, step, run, selected, faces, faceTints, activity, now, onSelect }: {
  drawingWidth: number
  node: FlowNode; step: FlowStep; run?: FlowStepRun; selected: boolean; faces?: ReadonlyMap<string, ReactNode>
  faceTints?: ReadonlyMap<string, Tint>; activity: { text: string; object: string }; now: number; onSelect?: (step: string) => void
}) => {
  const { tint, Mark } = KIND[step.kind]
  return (
    <div
      data-slot="flow-step"
      data-step={step.id}
      data-kind={step.kind}
      data-state={run?.state}
      data-selected={selected || undefined}
      className="absolute"
      style={{ left: node.box.x, top: node.box.y, width: node.box.w, height: node.box.h }}
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
      <FlowStepSurface state={run?.state} selected={selected} duration={durationOf(run, now)} runs={run?.runs} onClick={onSelect ? () => onSelect(step.id) : undefined}>
        <FlowFaces seats={step.kind === 'agent' ? run?.seats : undefined} faces={faces} tints={faceTints} fallback={<IconTile tint={tint}><Mark /></IconTile>} />
        <span className="flex min-w-0 flex-1 flex-col">
          <Text role="row" truncate className={run?.state === 'working' || run?.state === 'blocked' ? 'max-w-12' : run?.state === 'waiting' ? 'max-w-10' : undefined} title={step.name}>{step.name}</Text>
          <Text role="meta" truncate={step.kind !== 'agent' || run?.state === 'working'} title={titleOf(step, run, activity.object)}>{lineOf(step, run, activity.object)}</Text>
        </span>
      </FlowStepSurface>
      {activity.text &&
        <span data-slot="flow-doing" className="absolute left-1/2 top-full mt-5 -translate-x-1/2 max-w-80 whitespace-nowrap text-center pointer-events-none"
          style={{ width: 2 * Math.min(node.box.x + node.box.w / 2, drawingWidth - node.box.x - node.box.w / 2) }}><FlowDoingLine text={activity.text} /></span>}

    </div>
  )
}

const EdgeLine = ({ edge, travelled, overlay, glow, active }: { edge: FlowEdge; travelled: boolean; overlay: boolean; glow: string; active: boolean }) => (
  <g data-slot="flow-edge" data-edge={edge.id} data-kind={edge.kind} data-state={overlay ? travelled ? 'travelled' : 'future' : undefined}>
    {travelled && active && <path d={edge.path} fill="none" stroke="var(--hd-accent)" strokeOpacity={0.12} strokeWidth={10} strokeLinecap="round" filter={`url(#${glow})`} />}
    <path d={edge.path} fill="none" stroke={travelled ? 'var(--hd-accent)' : INK} strokeOpacity={travelled ? 1 : overlay ? 0.3 : LINE_OPACITY} strokeWidth={travelled ? 3 : LINE_WIDTH} strokeDasharray={overlay && !travelled ? '5 5' : undefined} strokeLinecap="round" />
    <polygon points={points(edge.head)} fill={travelled ? 'var(--hd-accent)' : INK} fillOpacity={travelled ? 1 : overlay ? 0.3 : LINE_OPACITY} />
  </g>
)

/** The outcome word, on a ground of its own so the line it speaks for can pass behind it. */
const Word = ({ label, count = 0 }: { label: FlowLabel; count?: number }) => (
  <span
    data-slot="flow-word"
    {...(label.retry ? { 'data-retry': '' } : {})}
    className="absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap"
    style={{ left: label.x, top: label.y }}
  >
    <FlowRouteLabel travelled={label.retry && count > 0}>{label.retry && <RetryIcon size={11} aria-hidden="true" />}{label.text}{label.retry && count > 0 ? ` ×${count}` : ''}</FlowRouteLabel>
  </span>
)

export interface FlowGraphProps {
  readonly model: FlowModel
  readonly overlay?: FlowOverlay
  readonly selectedStep?: string | null
  readonly onSelectStep?: (step: string) => void
  readonly faces?: ReadonlyMap<string, ReactNode>
  readonly faceTints?: ReadonlyMap<string, Tint>
  readonly doing?: ReadonlyMap<string, string | null>
  readonly now?: number
}

/** The frozen Flow's measured drawing and accessible list. A Run overlays recorded state, seated faces, motion and shared Timeline selection; a blueprint stays still. */
export const FlowGraph = ({ model, overlay, selectedStep, onSelectStep, faces, faceTints, doing, now = Date.now() }: FlowGraphProps) => {
  const grid = useId().replace(/[^A-Za-z0-9_-]/g, '')
  const glow = `${grid}-glow`
  // A pure function of the model, which a Run's window keeps for as long as the
  // Run's records do: a long Flow costs a few milliseconds to lay out, and the
  // window renders again whenever its snapshot moves.
  const layout = useMemo(() => (model.steps.length === 0 ? null : flowLayout(model)), [model])
  if (layout === null) {
    return <Text role="muted" as="p" data-slot="flow-graph">This Flow has no steps.</Text>
  }
  const stepsById = new Map(model.steps.map((step) => [step.id, step]))
  const activities = new Map(model.steps.map(step => [step.id, activityOf(overlay?.steps.get(step.id), doing)]))
  const kindOfRule = new Map(layout.edges.flatMap((edge) => edge.rules.map((id) => [id, edge.kind] as const)))
  const countOf = (edge: FlowEdge): number => edge.rules.reduce((count, id) => count + (overlay?.rules.get(id)?.count ?? 0), 0)
  const incoming = layout.edges.find(edge => edge.rules.some(id => overlay?.rules.get(id)?.current))
  const labels = overlay ? flowOverlayLabels(layout, overlay) : new Map(layout.edges.flatMap(edge => edge.label ? [[edge.id, edge.label] as const] : []))
  const height = Math.max(layout.height + (overlay ? FLOW_MARGIN : 0), ...[...labels.values()].map(label => label.y + label.h / 2 + FLOW_MARGIN))
  return (
    <div data-slot="flow-graph" className="@container/flow flex min-w-0 flex-col gap-4">
      <div data-slot="flow-drawing" aria-hidden="true" className="overflow-x-auto @max-[38rem]/flow:hidden">
        <div data-slot="flow-stage" className="relative" style={{ width: layout.width, height }}>
          <svg className="absolute inset-0" width={layout.width} height={height} focusable="false">
            <defs>
              <filter id={glow} filterUnits="userSpaceOnUse" x={0} y={0} width={layout.width} height={height}><feGaussianBlur stdDeviation={3} /></filter>
              <pattern id={grid} width={FLOW_GRID} height={FLOW_GRID} patternUnits="userSpaceOnUse">
                <circle cx={1} cy={1} r={1} fill={INK_SOFT} />
              </pattern>
            </defs>
            <rect width={layout.width} height={height} fill={`url(#${grid})`} />
            {layout.edges.map((edge) => <EdgeLine key={edge.id} edge={edge} travelled={countOf(edge) > 0} overlay={Boolean(overlay)} glow={glow} active={Boolean(incoming)} />)}
          </svg>
          {incoming && <FlowBaton path={incoming.path} />}
          {layout.nodes.map((node) => <StepCard key={node.id} node={node} drawingWidth={layout.width} step={stepsById.get(node.id)!} run={overlay?.steps.get(node.id)} selected={selectedStep === node.id} onSelect={onSelectStep} faces={faces} faceTints={faceTints} activity={activities.get(node.id)!} now={now} />)}
          {layout.edges.map((edge) => (labels.has(edge.id) ? <Word key={edge.id} label={labels.get(edge.id)!} count={countOf(edge)} /> : null))}
        </div>
      </div>

      <div data-slot="flow-list" className="flex min-w-0 flex-col gap-4">
        <section aria-label="Steps">
          <SectionHead name="Steps" />
          <Rows>
            {model.steps.map((step) => {
              const { tint, Mark } = KIND[step.kind]
              const more = [
                ...(step.count > 1 ? [`${step.count} at once`] : []),
                ...step.agents,
              ]
              const run = overlay?.steps.get(step.id)
              const activity = activities.get(step.id)!
              const StateRow = onSelectStep ? RowButton : Row
              return (
                <StateRow
                  key={step.id}
                  onClick={() => onSelectStep?.(step.id)}
                  {...(onSelectStep ? { 'aria-pressed': selectedStep === step.id } : {})}
                  data-step-row={step.id}
                  data-state={run?.state}
                  mark={<FlowFaces seats={step.kind === 'agent' ? run?.seats : undefined} faces={faces} tints={faceTints} size="sm" fallback={<IconTile size="sm" tint={tint}><Mark /></IconTile>} />}
                  title={<span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"><span className="min-w-0 truncate">{step.name}</span><Chip size="sm" tint={tint}>{ROLE_KIND_WORDS[step.kind]}</Chip>
                    {run && (run.state === 'working' || run.state === 'waiting' || run.state === 'blocked'
                      ? <Chip size="sm" tone={run.state === 'waiting' ? 'warning' : run.state === 'working' ? 'info' : 'neutral'}>{statusOf(run)}</Chip>
                      : <Text role="meta">{statusOf(run)}</Text>)}
                    {run && durationOf(run, now) !== null && <Text role="meta" numeric>{durationOf(run, now)}</Text>}
                    {run?.runs !== undefined && run.runs !== null && run.runs > 1 && <Text role="meta" numeric>{run.runs} runs</Text>}
                  </span>}
                  desc={<span title={titleOf(step, run, activity.object)}>{[lineOf(step, run, activity.object), activity.text, ...more, ...(run ? [durationOf(run, now) === null ? 'Time not recorded' : null, run.runs === null ? 'Run count unavailable' : null] : [])].filter(Boolean).join(' · ')}</span>}
                />
              )
            })}
          </Rows>
        </section>

        <section aria-label="Rules">
          <SectionHead name="Rules" />
          <Rows>
            {model.rules.length === 0 && <Row title="No rules" desc="The first round runs, then the Run ends." />}
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
