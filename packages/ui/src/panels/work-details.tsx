import type { ReactNode } from 'react'
import type { Session } from '@harnessdesk/protocol'
import { SummaryList, SummaryItem, ToolBody, ToolSection, Checklist, ChecklistItem, ToolProse } from '../design'
import { useSnapshot, useRuntime } from '../state/context'
import { useSeatAgent } from '../state/seat-agent'
import { seatCeilingOf } from '../lib/ceilings'
import { ceilingMeaning, seatCeilingWords } from '../lib/agents'
import { describeContext } from '../lib/context-usage'
import { sessionPlan, todoState } from '../lib/todos'
import { worktreeBranch } from '../lib/worktree-branch'
import { sanitizeText } from '../lib/sanitize'
import { AgentsView } from '../components/Details'
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
  return <ToolBody>
    <ToolSection label={session ? 'Conversation' : 'Starts in'}>
      <SummaryList surface="panel" aria-label="Conversation facts">
        <SummaryItem label="Agent">{agentName}</SummaryItem>
        {shown && <SummaryItem label="Ceiling" note={shown ? shown.note
          ? `${shown.ceiling.hold === 'held' ? 'Held' : 'Asked, not held'}: ${shown.note}` : ceilingMeaning(shown.ceiling.level) : undefined}>
          {shown ? seatCeilingWords(shown.ceiling) : 'Not recorded'}
        </SummaryItem>}
        <SummaryItem label="Folder" kind="path" action={placeAction} note={armed ? 'Source folder; the worktree is made when the message goes' : undefined}>
          {cwd ?? 'Choose a project folder'}
        </SummaryItem>
        {branch && <SummaryItem label="Branch" kind="path">{branch}</SummaryItem>}
        <SummaryItem label="Context">{context?.title ?? 'No usage yet'}</SummaryItem>
      </SummaryList>
      {(!shown || !branch) && <ToolProse>Not recorded for this {session ? 'conversation' : 'draft'}: {[!shown && 'the ceiling', !branch && 'the branch'].filter(Boolean).join(', ')}.</ToolProse>}
      <Slot name="session.header" />
    </ToolSection>
    <ToolSection label="Plan">
      {todos.length ? <Checklist surface="panel">{todos.map((todo, index) => <ChecklistItem key={index} state={todoState(todo)}>{sanitizeText(todo.label)}</ChecklistItem>)}</Checklist>
        : <ToolProse>No plan yet.</ToolProse>}
      {session && <AgentsView />}
    </ToolSection>
  </ToolBody>
}
