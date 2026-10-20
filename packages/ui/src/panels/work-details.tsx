import type { ReactNode } from 'react'
import type { Session } from '@harnessdesk/protocol'
import { SummaryList, SummaryItem, ToolBody, ToolBodySections, ToolFooterSuppressed, ToolSection, Checklist, ChecklistItem, ToolProse, ToolFold, Chip, InlineParts, BoardMenuButton, DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '../design'
import { useSnapshot, useRuntime } from '../state/context'
import { useSeatAgent } from '../state/seat-agent'
import { ceilingTitle, seatCeilingOf } from '../lib/ceilings'
import { ceilingWords } from '../lib/agents'
import { describeContext, formatTokens } from '../lib/context-usage'
import { sessionPlan, todoState } from '../lib/todos'
import { worktreeBranch } from '../lib/worktree-branch'
import { sanitizeText } from '../lib/sanitize'
import { AgentsView, TrajectoryCard } from '../components/Details'
import { hasSessionAgents } from '../components/Agents'
import { SeatRecordBlock } from '../components/SeatRecordBlock'
import { downloadMarkdown, exportFilename, sessionToMarkdown } from '../lib/export-session'
import { useStore } from '../state/context'
import { BackgroundTasksView } from '../components/BackgroundTasks'
import { Slot } from '../slots/registry'
export const ConversationDetails = ({ session, placeAction }: { session: Session | null; placeAction?: ReactNode }) => {
  const store = useStore()
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
    <ToolSection label={session ? 'Conversation' : 'Starts in'} action={session ? <DropdownMenu icons="none"><DropdownMenuTrigger render={<BoardMenuButton aria-label="Conversation actions" />} /><DropdownMenuContent align="end"><DropdownMenuItem label="Export as Markdown" onClick={() => { downloadMarkdown(exportFilename(session), sessionToMarkdown(session)); store.notice('info', 'Session exported as Markdown.') }} /></DropdownMenuContent></DropdownMenu> : undefined}>
      <SummaryList surface="panel" aria-label="Conversation facts">
        <SummaryItem kind="name" label={seated?.name ? 'Agent' : 'Runtime'}>{agentName}</SummaryItem>
        {shown && <SummaryItem label="Ceiling"><InlineParts>
          <Chip size="sm" tone="neutral" title={ceilingTitle(shown.ceiling, shown.note)}>{ceilingWords(shown.ceiling.level)}</Chip>
          <Chip size="sm" tone="neutral" title={ceilingTitle(shown.ceiling, shown.note)}>{shown.ceiling.hold === 'held' ? 'Held' : 'Asked, not held'}</Chip>
        </InlineParts></SummaryItem>}
        <SummaryItem label="Folder" kind="name" action={placeAction}>
          {cwd ?? 'Not chosen'}
        </SummaryItem>
        {branch && <SummaryItem label="Branch" kind="path">{branch}</SummaryItem>}
        <SummaryItem label="Context">{context?.fill ? `${context.fill.percent}% full` : context?.total ? `${formatTokens(context.total.totalTokens)} tokens` : context ? 'Window not reported' : 'No usage yet'}</SummaryItem>
      </SummaryList>
      {session && (!shown || !branch) && <ToolProse variant="note">
        {!shown && <>Permission level not reported for this {session ? 'conversation' : 'draft'}.</>}
        {!shown && !branch && ' '}
        {!branch && <>Branch not reported for this {session ? 'conversation' : 'draft'}.</>}
      </ToolProse>}
      {(shown || context || armed) && <ToolFold label="Details">
        {armed && <ToolProse>Source folder; the worktree is made when the message goes.</ToolProse>}
        {shown && <ToolProse>{ceilingTitle(shown.ceiling, shown.note)}</ToolProse>}
        {context && <ToolProse>{context.title}</ToolProse>}
      </ToolFold>}
      <Slot name="session.header" />
    </ToolSection>
    {todos.length > 0 && <ToolSection label="Plan">
      <Checklist surface="panel">{todos.map((todo, index) => <ChecklistItem key={index} state={todoState(todo)}>{sanitizeText(todo.label)}</ChecklistItem>)}</Checklist>
    </ToolSection>}
    {session && <SeatRecordBlock />}
    {hasSessionAgents(session) && <ToolSection label="Sub-agents"><AgentsView includeSeat={false} /></ToolSection>}
    {session && <><BackgroundTasksView card /><TrajectoryCard /></>}
  </ToolFooterSuppressed></ToolBodySections></ToolBody>
}
