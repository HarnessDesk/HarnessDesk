import type { ReactNode } from 'react'
import type { Session } from '@harnessdesk/protocol'
import { SummaryList, SummaryItem, ToolBody, ToolBodySections, ToolFooterSuppressed, ToolSection, Checklist, ChecklistItem, ToolProse } from '../design'
import { useSnapshot, useRuntime } from '../state/context'
import { useSeatAgent } from '../state/seat-agent'
import { seatCeilingOf } from '../lib/ceilings'
import { ceilingMeaning, seatCeilingWords } from '../lib/agents'
import { describeContext } from '../lib/context-usage'
import { sessionPlan, todoState } from '../lib/todos'
import { worktreeBranch } from '../lib/worktree-branch'
import { sanitizeText } from '../lib/sanitize'
import { AgentsView, TrajectoryCard } from '../components/Details'
import { BackgroundTasksView } from '../components/BackgroundTasks'
import { Slot } from '../slots/registry'
export const ConversationDetails = ({ session, placeAction }: { session: Session | null; placeAction?: ReactNode }) => {
  const snapshot = useSnapshot(), runtime = useRuntime(), seated = useSeatAgent(session)
  const pointed = !session && snapshot.draftPlace?.kind === 'existing' ? snapshot.draftPlace.path : null
  const armed = !session && snapshot.draftPlace?.kind === 'worktree' ? snapshot.draftPlace : null
  const pointedAway = pointed !== null && pointed !== snapshot.workspace?.path
  const cwd = session?.cwd ?? pointed ?? armed?.root ?? snapshot.workspace?.path ?? null
  const checkout = snapshot.worktrees.find(one => one.path === cwd)
  const branch = (armed ? worktreeBranch(armed.name) : null)
    ?? (pointedAway && snapshot.draftPlace?.kind === 'existing' ? snapshot.draftPlace.branch : null)
    ?? (cwd === snapshot.workspace?.path ? snapshot.workspace?.git?.branch ?? null : null)
    ?? checkout?.branch ?? session?.git?.branch ?? null
  const agentName = seated?.name ?? snapshot.runtimes.find(one => one.id === session?.runtime)?.presentation.name ?? runtime.presentation.name
  const shown = session ? seatCeilingOf(session.settings, [...snapshot.flowRuns.values()].flat(), String(session.runtime), String(session.id)) : null
  const context = describeContext(session?.usage, agentName), todos = sessionPlan(session) ?? []
  return <ToolBody><ToolBodySections><ToolFooterSuppressed>
    <ToolSection label={session ? 'Conversation' : 'Starts in'}>
      <SummaryList surface="panel" aria-label="Conversation facts">
        <SummaryItem label="Agent">{agentName}</SummaryItem>
        {shown && <SummaryItem label="Ceiling" note={shown ? shown.note
          ? `${shown.ceiling.hold === 'held' ? 'Held' : 'Asked, not held'}: ${shown.note}` : ceilingMeaning(shown.ceiling.level) : undefined}>
          {shown ? seatCeilingWords(shown.ceiling) : 'Not recorded'}
        </SummaryItem>}
        <SummaryItem label="Folder" action={placeAction} note={armed ? 'Source folder; the worktree is made when the message goes' : undefined}>
          {cwd ? <span title={cwd}>{cwd.split('/').filter(Boolean).at(-1) ?? cwd}</span> : 'Not chosen'}
        </SummaryItem>
        {branch && <SummaryItem label="Branch" kind="path">{branch}</SummaryItem>}
        <SummaryItem label="Context">{context?.title ?? 'No usage yet'}</SummaryItem>
      </SummaryList>
      {session && (!shown || !branch) && <ToolProse variant="note">
        {!shown && <>Permission level not reported for this {session ? 'conversation' : 'draft'}.</>}
        {!shown && !branch && ' '}
        {!branch && <>Branch not reported for this {session ? 'conversation' : 'draft'}.</>}
      </ToolProse>}
      <Slot name="session.header" />
    </ToolSection>
    {(session || todos.length > 0) && <ToolSection label="Plan">
      {todos.length ? <Checklist surface="panel">{todos.map((todo, index) => <ChecklistItem key={index} state={todoState(todo)}>{sanitizeText(todo.label)}</ChecklistItem>)}</Checklist>
        : <ToolProse variant="note">No plan yet.</ToolProse>}
      {session && <AgentsView />}
    </ToolSection>}
    {session && <><BackgroundTasksView card /><TrajectoryCard /></>}
  </ToolFooterSuppressed></ToolBodySections></ToolBody>
}
