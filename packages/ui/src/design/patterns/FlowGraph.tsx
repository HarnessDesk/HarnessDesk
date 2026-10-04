import { useId, useMemo } from 'react'

import { AgentIcon, CheckIcon, RetryIcon, UserIcon } from '../../components/Icons'
import {
  FLOW_FAN_INSET, FLOW_FAN_RISE, FLOW_GRID, flowLayout,
  type FlowEdge, type FlowLabel, type FlowNode,
} from '../../lib/flow-layout'
import { stepName, type FlowModel, type FlowStep, type StepKind } from '../../lib/flow-model'
import { ROLE_KIND_WORDS } from '../../lib/shapes'
import { Card } from '../ui/card'
import { IconTile } from '../ui/icon-tile'
import type { Tint } from '../ui/tone'
import { Chip, Row, Rows, SectionHead, Text } from './Settings'

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
 */

const KIND: Readonly<Record<StepKind, { readonly tint: Tint; readonly Mark: typeof AgentIcon }>> = {
  agent: { tint: 'violet', Mark: AgentIcon },
  check: { tint: 'sky', Mark: CheckIcon },
  person: { tint: 'amber', Mark: UserIcon },
}

/** Lines, arrowheads and the dots of the grid: tokens, never a colour of their own. */
const INK = 'var(--hd-muted-foreground)'
const INK_SOFT = 'var(--hd-border-strong)'
const LINE_WIDTH = 1.5
const LINE_OPACITY = 0.6

const points = (head: FlowEdge['head']): string => head.map((one) => `${Math.round(one.x * 10) / 10},${Math.round(one.y * 10) / 10}`).join(' ')

const StepCard = ({ node, step }: { node: FlowNode; step: FlowStep }) => {
  const { tint, Mark } = KIND[step.kind]
  return (
    <div
      data-slot="flow-step"
      data-step={step.id}
      data-kind={step.kind}
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
      <Card variant="raised" spacing="compact" className="absolute inset-0 flex-row items-center">
        <IconTile tint={tint}><Mark /></IconTile>
        <span className="flex min-w-0 flex-1 flex-col">
          <Text role="row" truncate title={step.name}>{step.name}</Text>
          <Text role="meta" truncate title={step.line}>{step.line}</Text>
        </span>
      </Card>
    </div>
  )
}

const EdgeLine = ({ edge }: { edge: FlowEdge }) => (
  <g data-slot="flow-edge" data-edge={edge.id} data-kind={edge.kind}>
    <path d={edge.path} fill="none" stroke={INK} strokeOpacity={LINE_OPACITY} strokeWidth={LINE_WIDTH} strokeLinecap="round" />
    <polygon points={points(edge.head)} fill={INK} fillOpacity={LINE_OPACITY} />
  </g>
)

/** The outcome word, on a ground of its own so the line it speaks for can pass behind it. */
const Word = ({ label }: { label: FlowLabel }) => (
  <span
    data-slot="flow-word"
    {...(label.retry ? { 'data-retry': '' } : {})}
    className="absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap"
    style={{ left: label.x, top: label.y }}
  >
    <Chip size="sm" tone="neutral">{label.retry && <RetryIcon size={11} aria-hidden="true" />}{label.text}</Chip>
  </span>
)

export interface FlowGraphProps {
  readonly model: FlowModel
}

export const FlowGraph = ({ model }: FlowGraphProps) => {
  const grid = useId().replace(/[^A-Za-z0-9_-]/g, '')
  // A pure function of the model, which a Run's window keeps for as long as the
  // Run's records do: a long Flow costs a few milliseconds to lay out, and the
  // window renders again whenever its snapshot moves.
  const layout = useMemo(() => (model.steps.length === 0 ? null : flowLayout(model)), [model])
  if (layout === null) {
    return <Text role="muted" as="p" data-slot="flow-graph">This Flow has no steps.</Text>
  }
  const stepsById = new Map(model.steps.map((step) => [step.id, step]))
  const kindOfRule = new Map(layout.edges.flatMap((edge) => edge.rules.map((id) => [id, edge.kind] as const)))
  return (
    <div data-slot="flow-graph" className="@container/flow flex min-w-0 flex-col gap-4">
      <div data-slot="flow-drawing" aria-hidden="true" className="overflow-x-auto @max-[38rem]/flow:hidden">
        <div data-slot="flow-stage" className="relative" style={{ width: layout.width, height: layout.height }}>
          <svg className="absolute inset-0" width={layout.width} height={layout.height} focusable="false">
            <defs>
              <pattern id={grid} width={FLOW_GRID} height={FLOW_GRID} patternUnits="userSpaceOnUse">
                <circle cx={1} cy={1} r={1} fill={INK_SOFT} />
              </pattern>
            </defs>
            <rect width={layout.width} height={layout.height} fill={`url(#${grid})`} />
            {layout.edges.map((edge) => <EdgeLine key={edge.id} edge={edge} />)}
          </svg>
          {layout.nodes.map((node) => <StepCard key={node.id} node={node} step={stepsById.get(node.id)!} />)}
          {layout.edges.map((edge) => (edge.label ? <Word key={edge.id} label={edge.label} /> : null))}
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
              return (
                <Row
                  key={step.id}
                  mark={<IconTile size="sm" tint={tint}><Mark /></IconTile>}
                  title={<span className="flex min-w-0 items-center gap-2"><span className="min-w-0 truncate">{step.name}</span><Chip size="sm" tint={tint}>{ROLE_KIND_WORDS[step.kind]}</Chip></span>}
                  desc={[step.line, ...more].join(' · ')}
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
                    {kindOfRule.get(rule.id) === 'loop' && <Chip size="sm" tone="neutral">Loops back</Chip>}
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
