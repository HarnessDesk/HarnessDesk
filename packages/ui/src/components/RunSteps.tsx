import { useEffect, useState, type ReactNode } from 'react'
import { Chip, GroupLine, IconTile, PanelBody, PanelFooter, PanelFrame, PanelRow } from '../design'
import { flowModel } from '../lib/flow-model'
import { flowOverlay, stepForRow } from '../lib/flow-overlay'
import { runTimeline } from '../lib/run-timeline'
import { sanitizeText } from '../lib/sanitize'
import { wordOf } from '../lib/agents'
import { AgentIcon, CheckIcon, UserIcon } from './Icons'
import { formatDuration } from './TurnTail'
import type { RunTimelineInput } from '../lib/run-timeline'
export interface RunStepsProps {
  input: RunTimelineInput
  selectedRow: string | null
  selectedStep?: string | null
  faces?: ReadonlyMap<string, ReactNode>
  onSelect: (row: string) => void
  onSelectStep?: (step: string) => void
}
export const RunSteps = ({ input, selectedRow, selectedStep, faces, onSelect, onSelectStep }: RunStepsProps) => {
  const { execution } = input
  const model = flowModel(execution.document.flow)
  const rows = runTimeline(input).rows
  const rounds = [...execution.rounds].sort((a, b) => a.n - b.n)
  const chosen = rows.find(one => one.id === selectedRow)?.round ?? (selectedStep ? null : rounds.at(-1)?.n)
  const step = selectedStep ?? stepForRow(execution, rows, selectedRow)
  const future = model.steps.filter(one => !rounds.some(round => round.role === one.id))
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (execution.state !== 'running') return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [execution.state])
  const mark = (kind: string, seat?: string) => <IconTile shape="face" size="sm">{seat && faces?.get(seat) || (kind === 'check' ? <CheckIcon /> : kind === 'person' ? <UserIcon /> : <AgentIcon />)}</IconTile>
  return <div data-slot="run-steps" className="min-h-0 min-w-0 flex-1"><PanelFrame><PanelBody>
    <GroupLine left={`Taken ${rounds.length}`} />
    {rounds.map(round => {
      const one = model.steps.find(one => one.id === round.role)
      const state = flowOverlay({ execution: { ...execution, rounds: [round] }, model, cards: input.cards, sessions: input.sessions,
        attempts: input.attempts ? new Map([...input.attempts].map(([id, attempts]) => [id, { attempts, complete: !input.incompleteAttempts?.has(id) }])) : undefined }).steps.get(round.role)
      const words = state?.state === 'done' ? state.line ? wordOf(state.line) : 'Done'
        : state?.state === 'stopping' ? 'Stopping' : state?.state === 'stopped' ? 'Stopped'
        : state?.state === 'working' ? 'Working' : state?.state === 'waiting' ? 'Needs you' : 'Waiting for evidence'
      const duration = state?.durationMs === null || state?.durationMs === undefined ? null
        : state.durationMs + (state.state === 'working' && state.since !== null ? Math.max(0, now - state.since) : 0)
      return <PanelRow key={round.n} mark={mark(one?.kind ?? 'agent', round.seats[0])}
        title={sanitizeText(one?.name ?? wordOf(round.role))}
        sub={`Round ${round.n}${duration !== null ? ` · ${formatDuration(duration)}${state?.state === 'working' ? ' so far' : ''}` : ''}`}
        selected={chosen === round.n || (chosen === null && step === round.role && round === rounds.at(-1))}
        trail={<Chip tone={state?.state === 'waiting' || state?.state === 'blocked' ? 'warning' : 'neutral'}>{sanitizeText(words)}</Chip>}
        onClick={() => onSelect(`round-${round.n}`)} />
    })}
    {future.length > 0 && <><GroupLine left={`Not reached ${future.length}`} />{future.map(one => <PanelRow key={one.id}
      mark={mark(one.kind)} title={sanitizeText(one.name)} selected={step === one.id}
      trail={<Chip tone="neutral">Not reached</Chip>} onClick={onSelectStep ? () => onSelectStep(one.id) : undefined} />)}</>}
  </PanelBody><PanelFooter left={`${rounds.length + future.length} steps`} right="Selecting one lights its node on Flow" /></PanelFrame></div>
}
