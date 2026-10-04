import { useRef, useState } from 'react'
import { sessionKey, type FlowExecution } from '@harnessdesk/protocol'
import { StopRunDialog, StopRunFailure, type StopRunSeat } from '../components/StopRunDialog'
import { RunWorkspace } from '../components/RunWorkspace'
import { TeamOverview } from '../components/TeamOverview'
import { runTimeline } from '../lib/run-timeline'
import { Button } from '../design'
import { runFixture } from './run-view-fixture'
import { overviewInput, overviewModel } from './team-overview-fixture'

export const STOP_RUN_STATES = ['running', 'empty', 'pending', 'failed', 'cleanup', 'stopping', 'stopped', 'resumed', 'restopped', 'narrow'] as const
export type StopRunScene = typeof STOP_RUN_STATES[number]
const SEATS: readonly StopRunSeat[] = [
  { id: 'alpha', name: 'Alpha', interrupt: true },
  { id: 'beta', name: 'Beta', interrupt: false },
]
const CLEANUP_FAILURE = { reason: 'The brief changed.', message: 'The Run stopped, but one Seat could not be released. Try again to finish stopping it.' }

/** The production strip, header, inspector and stop question, with placeholder identities only. */
export const StopRunExample = ({ scene = 'running' }: { scene?: StopRunScene }) => {
  // Stop retains the claim while the Seat finishes; it does not complete the card.
  const source = runFixture('running')
  if (scene === 'stopped' || scene === 'stopping' || scene === 'cleanup') source.execution = { ...source.execution, state: 'stopped',
    endedAt: source.execution.startedAt! + 900_000, currentEndedAt: source.execution.startedAt! + 900_000, end: { kind: 'stopped', by: 'person' }, reason: 'You stopped this Run. Its cards and findings are kept.',
    rounds: source.execution.rounds.map(round => ({ ...round, state: 'closed' })) }
  if (scene === 'resumed' || scene === 'restopped') source.execution = { ...source.execution,
    endedAt: source.execution.startedAt! + 300_000,
    currentEndedAt: scene === 'restopped' ? source.execution.startedAt! + 900_000 : null,
    state: scene === 'restopped' ? 'stopped' : 'running',
    end: scene === 'restopped' ? { kind: 'stopped', by: 'person' } : null,
    reason: scene === 'restopped' ? 'You stopped this Run. Its cards and findings are kept.' : null,
    rounds: source.execution.rounds.map(round => scene === 'restopped' ? { ...round, state: 'closed' } : round) }
  const [execution, setExecution] = useState(source.execution)
  const [failure, setFailure] = useState<typeof CLEANUP_FAILURE | undefined>(scene === 'cleanup' ? CLEANUP_FAILURE : undefined)
  const failedOnce = useRef(false)
  const [asking, setAsking] = useState(false)
  const [live, setLive] = useState(scene === 'stopping')
  const [selectedRow, setSelectedRow] = useState<string | null>('card-4-4')
  const ask = () => setAsking(true)
  const stop = async (reason: string): Promise<void> => {
    if (scene === 'pending') await new Promise<void>(() => {})
    const stopped: FlowExecution = { ...execution, state: 'stopped', reason, endedAt: execution.endedAt ?? Date.now(), currentEndedAt: Date.now(),
      end: { kind: 'stopped', by: 'person' }, rounds: execution.rounds.map(round => ({ ...round, state: 'closed' })) }
    setExecution(stopped)
    if (scene === 'failed' && !failedOnce.current) {
      failedOnce.current = true
      setFailure({ reason, message: CLEANUP_FAILURE.message })
      throw new Error(CLEANUP_FAILURE.message)
    }
    setFailure(undefined)
  }
  const liveSession = overviewInput('running').seats[0]!.session!
  const session = { ...liveSession, turns: liveSession.turns.map(turn => ({ ...turn, startedAt: source.cards[3]!.claim!.at })) }
  const input = { ...source, execution, sessions: live ? new Map([[sessionKey(session.runtime, session.id), session]]) : new Map() }
  const timeline = runTimeline(input)
  const summary = overviewModel('running')
  const model = { ...summary, needsYou: [], seats: [], run: summary.run ? { ...summary.run, state: execution.state, round: 4, role: 'writer' } : null }
  return <div data-stop-scene={scene} className="flex min-w-0 flex-col gap-4">
    {failure && <StopRunFailure number={1} message={failure.message} onRetry={ask} />}
    <TeamOverview model={model} timeline={timeline} runName="Build and review" onStop={ask} />
    {scene === 'stopping' && live && <span hidden><Button onClick={() => setLive(false)} data-finish-turn>Finish the fixture turn</Button></span>}
    <div className="flex h-144 min-w-0 flex-col">
      <RunWorkspace model={timeline} number={1} selectedRow={selectedRow} onSelect={setSelectedRow} onStop={ask}
        inspector={{ input, seats: [{ id: 'seat-0', name: 'Alpha' }], onAbandon: async () => {}, onStop: ask }} />
    </div>
    {asking && <StopRunDialog seats={scene === 'empty' ? [] : SEATS} failure={failure}
      ended={execution.state === 'stopped' || execution.state === 'settled'} onStop={stop} onClose={() => setAsking(false)} />}
  </div>
}

export const StopRunBoard = () => <div className="flex flex-col gap-4">
  {STOP_RUN_STATES.map(scene => <section key={scene} data-catalog-state={scene} className={scene === 'narrow' ? 'max-w-sm' : undefined}>
    <StopRunExample scene={scene} />
  </section>)}
</div>

export const StopRunFrames = ({ scene }: { scene: StopRunScene }) => <section id="stop-run-frame" className="p-4">
  <StopRunExample scene={scene} />
</section>
