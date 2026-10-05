import { useEffect, useState, type ReactNode } from 'react'
import { FlowStepRow, GroupLine, PanelBody, PanelFooter, PanelFrame, type Tint } from '../design'
import { flowModel } from '../lib/flow-model'
import { flowOverlay, stepForRow } from '../lib/flow-overlay'
import { runTimeline } from '../lib/run-timeline'
import { wordOf } from '../lib/agents'
import type { RunTimelineInput } from '../lib/run-timeline'
export interface RunStepsProps {
  input: RunTimelineInput
  selectedRow: string | null
  selectedStep?: string | null
  faces?: ReadonlyMap<string, ReactNode>
  faceTints?: ReadonlyMap<string, Tint>
  onSelect: (row: string) => void
  onSelectStep?: (step: string) => void
}
export const RunSteps = ({ input, selectedRow, selectedStep, faces, faceTints, onSelect, onSelectStep }: RunStepsProps) => {
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
  return <div data-slot="run-steps" className="min-h-0 min-w-0 flex-1"><PanelFrame><PanelBody>
    <GroupLine left={`Taken ${rounds.length}`} />
    {rounds.map(round => {
      const one = model.steps.find(one => one.id === round.role)
      const state = flowOverlay({ execution: { ...execution, rounds: [round] }, model, cards: input.cards, sessions: input.sessions,
        attempts: input.attempts ? new Map([...input.attempts].map(([id, attempts]) => [id, { attempts, complete: !input.incompleteAttempts?.has(id) }])) : undefined }).steps.get(round.role)
      return <FlowStepRow key={round.n} step={one ?? { id: round.role, kind: 'agent', name: wordOf(round.role), line: '', count: 1, agents: [] }}
        run={state} faces={faces} faceTints={faceTints} now={now} subtitle={`Round ${round.n}`}
        selected={chosen === round.n || (chosen === null && step === round.role && round === rounds.at(-1))}
        onSelect={() => onSelect(`round-${round.n}`)} />
    })}
    {future.length > 0 && <><GroupLine left={`Not reached ${future.length}`} />{future.map(one => <FlowStepRow key={one.id}
      step={one} run={{ state: 'future', runs: 0, durationMs: null, since: null, line: null, seats: [] }}
      selected={step === one.id} onSelect={onSelectStep} />)}</>}
  </PanelBody><PanelFooter left={`${rounds.length + future.length} steps`} right="Selecting one lights its node on Flow" /></PanelFrame></div>
}
