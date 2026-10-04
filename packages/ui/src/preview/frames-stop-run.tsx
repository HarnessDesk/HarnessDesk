import { useRef, useState } from 'react'
import type { FlowExecution } from '@harnessdesk/protocol'
import { StopRunDialog, StopRunFailure, type StopRunSeat } from '../components/StopRunDialog'
import { RunWorkspace } from '../components/RunWorkspace'
import { TeamOverview } from '../components/TeamOverview'
import { runTimeline } from '../lib/run-timeline'
import { runFixture } from './run-view-fixture'
import { overviewModel } from './team-overview-fixture'

export const STOP_RUN_STATES = ['running', 'empty', 'pending', 'failed', 'cleanup', 'stopped', 'narrow'] as const
export type StopRunScene = typeof STOP_RUN_STATES[number]
const SEATS: readonly StopRunSeat[] = [
  { id: 'alpha', name: 'Alpha', interrupt: true },
  { id: 'beta', name: 'Beta', interrupt: false },
]
const CLEANUP_FAILURE = { reason: 'The brief changed.', message: 'The Run stopped, but one Seat could not be released. Try again to finish stopping it.' }

/** The production strip, header, inspector and stop question, with placeholder identities only. */
export const StopRunExample = ({ scene = 'running' }: { scene?: StopRunScene }) => {
  const source = runFixture(scene === 'stopped' || scene === 'cleanup' ? 'stopped' : 'running')
  const [execution, setExecution] = useState(source.execution)
  const [failure, setFailure] = useState<typeof CLEANUP_FAILURE | undefined>(scene === 'cleanup' ? CLEANUP_FAILURE : undefined)
  const failedOnce = useRef(false)
  const [asking, setAsking] = useState(false)
  const [selectedRow, setSelectedRow] = useState<string | null>('card-4-4')
  const ask = () => setAsking(true)
  const stop = async (reason: string): Promise<void> => {
    if (scene === 'pending') await new Promise<void>(() => {})
    const stopped: FlowExecution = { ...execution, state: 'stopped', reason, endedAt: Date.now(),
      end: { kind: 'stopped', by: 'person' }, rounds: execution.rounds.map(round => ({ ...round, state: 'closed' })) }
    setExecution(stopped)
    if (scene === 'failed' && !failedOnce.current) {
      failedOnce.current = true
      setFailure({ reason, message: CLEANUP_FAILURE.message })
      throw new Error(CLEANUP_FAILURE.message)
    }
    setFailure(undefined)
  }
  const input = { ...source, execution }
  const summary = overviewModel('running')
  const model = { ...summary, needsYou: [], seats: [], run: summary.run ? { ...summary.run, state: execution.state } : null }
  return <div data-stop-scene={scene} className="flex min-w-0 flex-col gap-4">
    {failure && <StopRunFailure number={1} message={failure.message} onRetry={ask} />}
    <TeamOverview model={model} runName="Build and review" onStop={ask} />
    <div className="flex h-144 min-w-0 flex-col">
      <RunWorkspace model={runTimeline(input)} number={1} selectedRow={selectedRow} onSelect={setSelectedRow} onStop={ask}
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
