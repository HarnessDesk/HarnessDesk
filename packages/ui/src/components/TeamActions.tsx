import { useEffect, useState, type ReactNode } from 'react'
import type { FlowExecution } from '@harnessdesk/protocol'
import { ActionError, Button, Dialog, Field, FormStack, Input, MenuItem } from '../design'
import { goalRunOf, namedGoalRun } from '../lib/goal-run'
import { goalActions } from '../lib/goals'
import { isRecord, RECORD_REASON } from '../lib/team-record'
import { teamSeats } from '../lib/team-seats'
import { useSnapshot, useStore } from '../state/context'
import { CommentIcon, PencilIcon, RetryIcon, StopIcon } from './Icons'
import { GoalWrap } from './GoalWrap'
import { RunAgain } from './RunAgain'
import { StopRunDialog } from './StopRunDialog'

/** The Team's subject actions and questions, shared by its header and sidebar. */
export const useTeamActions = (room: string, options: {
  readonly readRun?: boolean
  readonly onRunStarted?: (execution: FlowExecution) => void
} = {}) => {
  const store = useStore(), snapshot = useSnapshot()
  const goal = snapshot.goals.get(room)
  const record = isRecord(goal)
  const execution = goalRunOf(room, goal, snapshot.flowExecutions)
  const run = namedGoalRun(goal)
  // Sidebar rows do not load every Team's Run just by being rendered.
  useEffect(() => {
    if (!options.readRun || !run || snapshot.flowExecutions.has(run)) return
    void store.readFlowExecution(run).catch(() => {})
  }, [options.readRun, run, snapshot.flowExecutions, store])
  // A trigger or person-created Team may name no Run after its reservation
  // ends. Discover persisted Runs once per menu opening, independently of
  // execution-map pushes: an empty or failed read must not start a retry loop.
  useEffect(() => {
    if (!options.readRun || !goal?.goal.id || run) return
    void store.loadTeamRuns(room).catch(() => {})
  }, [options.readRun, room, goal?.goal.id, goal?.goal.root, run, store])
  const [renaming, setRenaming] = useState(false)
  const [rename, setRename] = useState('')
  const [renameError, setRenameError] = useState<string | null>(null)
  const [wrapping, setWrapping] = useState(false)
  const [stoppingRun, setStoppingRun] = useState<string | null>(null)
  const [again, setAgain] = useState<FlowExecution | null>(null)
  useEffect(() => {
    setRenaming(false); setWrapping(false); setStoppingRun(null); setAgain(null)
  }, [room])
  const wrapDisabled = goal ? goalActions(goal.goal).disabled || goal.problem !== null : true
  const renameSubject = async () => {
    if (!rename.trim() || !goal || record) return
    try { await store.updateGoal(goal.goal.id, goal.goal.revision, { sentence: rename.trim() }); setRenaming(false) }
    catch (cause) { setRenameError(cause instanceof Error ? cause.message : String(cause)) }
  }
  const stoppingExecution = stoppingRun ? snapshot.flowExecutions.get(stoppingRun) : null
  const stopSeatIds = new Set(stoppingExecution?.rounds.flatMap(round => round.seats) ?? [])
  const stopSeatNames = new Map(stoppingExecution ? teamSeats(goal, snapshot.teams.get(room), stoppingExecution, 'seat').map(seat => [seat.record.id, seat.name]) : [])
  const stopSeats = (goal?.members ?? []).filter(seat => !seat.closed && stopSeatIds.has(seat.id)).map(seat => ({
    id: seat.id, name: stopSeatNames.get(seat.id) ?? 'Agent',
    interrupt: snapshot.runtimes.find(runtime => runtime.id === seat.session.runtime)?.capabilities.interrupt,
  }))
  return {
    wrapDisabled, setWrapping, setStoppingRun, setAgain,
    items: (close: () => void, related?: ReactNode) => <>
      {goal && <MenuItem icon={<PencilIcon />} label="Rename" disabled={record ? RECORD_REASON : false} onSelect={() => { setRename(goal.goal.sentence); setRenameError(null); setRenaming(true); close() }} />}
      {related}
      {execution && <MenuItem icon={<RetryIcon />} label="Run again…" disabled={record ? RECORD_REASON : goal?.goal.state !== 'open' ? 'This Team is not open' : false} onSelect={() => { setAgain(execution); close() }} />}
      {goal?.goal.state !== 'wrapped' && <MenuItem icon={<CommentIcon />} label="Wrap…" disabled={record ? RECORD_REASON : wrapDisabled} onSelect={() => { setWrapping(true); close() }} />}
      {execution && <MenuItem icon={<StopIcon />} label="Stop run…" disabled={record ? RECORD_REASON : execution.state !== 'running' ? 'This Run is not running' : false} onSelect={() => { setStoppingRun(execution.id); close() }} />}
    </>,
    dialogs: <>
      {renaming && goal && <Dialog title="Rename Team" onClose={() => setRenaming(false)} footer={<>
        <Button disabled={!rename.trim() || record} onClick={() => void renameSubject()}>Rename</Button><Button variant="quiet" onClick={() => setRenaming(false)}>Cancel</Button>
      </>}><FormStack><Field label="Brief">{control => <Input {...control} value={rename} onChange={event => setRename(event.target.value)} autoFocus
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void renameSubject() } }} />}</Field></FormStack>{renameError && <ActionError>{renameError}</ActionError>}</Dialog>}
      {wrapping && goal && <GoalWrap view={goal} onClose={() => setWrapping(false)} />}
      {stoppingRun && stoppingExecution?.goal === room && <StopRunDialog key={stoppingRun} seats={stopSeats}
        refusal={record ? RECORD_REASON : null} ended={stoppingExecution.state === 'stopped' || stoppingExecution.state === 'settled'}
        failure={snapshot.flowStopProblems.get(stoppingRun)} onStop={reason => store.stopFlowExecution(stoppingRun, reason)} onClose={() => setStoppingRun(null)} />}
      {again?.goal === room && goal && <RunAgain key={again.id} execution={again} root={goal.goal.root} sentence={goal.goal.sentence}
        onClose={() => setAgain(null)} onStarted={next => { setAgain(null); options.onRunStarted?.(next); void store.loadTeamRuns(room) }} />}
    </>,
  }
}
