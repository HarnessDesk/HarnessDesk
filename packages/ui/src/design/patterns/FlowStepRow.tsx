import type { ReactNode } from 'react'
import { AgentIcon, TerminalIcon, UserIcon } from '../../components/Icons'
import { formatDuration } from '../../components/TurnTail'
import { wordOf } from '../../lib/agents'
import type { FlowStepRun } from '../../lib/flow-overlay'
import type { FlowStep, StepKind } from '../../lib/flow-model'
import { sanitizeHtml, sanitizeText } from '../../lib/sanitize'
import { ROLE_KIND_WORDS } from '../../lib/shapes'
import { FlowFaces } from '../ui/flow-step'
import { IconTile } from '../ui/icon-tile'
import { ListRow } from '../ui/list-row'
import type { Tint, Tone } from '../ui/tone'
import { Chip, Text } from './Settings'

export const FLOW_STEP_KINDS: Readonly<Record<StepKind, { readonly tint: Tint; readonly Mark: typeof AgentIcon }>> = {
  agent: { tint: 'violet', Mark: AgentIcon },
  check: { tint: 'sky', Mark: TerminalIcon },
  person: { tint: 'amber', Mark: UserIcon },
}
/** Read an agent-authored line as safe words, the same way the Flow drawing does. */
export const words = (value: string): string => {
  const box = document.createElement('template')
  box.innerHTML = sanitizeHtml(value)
  return box.content.textContent ?? ''
}
const toneOf = (label: string): Tone => {
  switch (label.toLowerCase()) {
    case 'working': return 'info'
    case 'needs you': case 'request changes': return 'warning'
    case 'published': case 'pass': case 'passed': case 'done': case 'approve': case 'approved': return 'success'
    case 'fail': case 'failed': return 'danger'
    default: return 'neutral'
  }
}
/** A recorded step or Seat state, toned once for the Flow list and Run dock. Unknown outcomes stay neutral. */
export const RunStateChip = ({ state }: { state: string }) => <Chip tone={toneOf(state)}>{sanitizeText(state)}</Chip>

const stateOf = (run: FlowStepRun): string => run.state === 'done' && run.line ? wordOf(words(run.line))
  : ({ future: 'Not reached', done: 'Done', working: 'Working', waiting: 'Needs you', blocked: 'Waiting for evidence', stopping: 'Stopping', stopped: 'Stopped' })[run.state]

/** A step in the Flow list or dock: kind and seated faces, a recorded state, and trailing time and run count. The caller owns its earned second line and selection. */
export const FlowStepRow = ({ step, run, subtitle, selected, faces, faceTints, now = Date.now(), onSelect, tabIndex }: {
  step: FlowStep
  run?: FlowStepRun
  subtitle?: ReactNode
  selected?: boolean
  faces?: ReadonlyMap<string, ReactNode>
  faceTints?: ReadonlyMap<string, Tint>
  tabIndex?: number
  now?: number
  onSelect?: (step: string) => void
}) => {
  const { tint, Mark } = FLOW_STEP_KINDS[step.kind]
  const elapsed = run?.since != null && (run.state === 'working' || run.state === 'waiting') ? Math.max(0, now - run.since) : 0
  const duration = run?.durationMs == null ? null : formatDuration(run.durationMs + elapsed)
  return <ListRow data-step-row={step.id} data-state={run?.state} data-selected={selected || undefined}
    tabIndex={tabIndex}
    as={onSelect ? 'button' : 'div'} interactive={Boolean(onSelect)} selected={selected}
    onClick={onSelect ? () => onSelect(step.id) : undefined}
    lead={<FlowFaces seats={step.kind === 'agent' ? run?.seats : undefined} faces={faces} tints={faceTints}
      fallback={<IconTile shape={step.kind === 'check' ? 'square' : 'face'} tint={tint}><Mark /></IconTile>} />}
    title={<span className="flex min-w-0 flex-wrap items-center gap-2"><span className="min-w-0 truncate" title={sanitizeText(step.name)}>{sanitizeText(step.name)}</span><Chip size="sm" tint={tint}>{ROLE_KIND_WORDS[step.kind]}</Chip></span>}
    subtitle={subtitle} wrapSubtitle
    trail={run ? <span className="flex flex-col items-end gap-1">
      <RunStateChip state={stateOf(run)} />
      {run.state !== 'future' && <Text role="meta" numeric>
        <span title={duration === null ? 'Time not recorded' : undefined}>{duration ?? '—'}</span>{' · '}
        <span title={run.runs === null ? 'Run count unavailable' : undefined}>{run.runs === null ? '—' : `${run.runs} ${run.runs === 1 ? 'run' : 'runs'}`}</span>
      </Text>}
    </span> : undefined} />
}
