import type { ReactNode } from 'react'
import { Button, SummaryList, SummaryItem, ChangeStats, ToolProse, ToolFold } from '../design'
import { teamRunFacts } from '../lib/team-run-facts'
import { runTimeline, currentRunEnd, type RunTimelineInput } from '../lib/run-timeline'
import { sanitizeText } from '../lib/sanitize'
import { openExternal } from '../lib/desktop'
import { formatDuration } from './TurnTail'
import { BackgroundIcon, BranchIcon, CheckAllIcon, ClockIcon, CommentIcon, CommitIcon, CostIcon, DiffIcon, FlowIcon, FolderIcon, HistoryIcon, PullRequestIcon, RefreshIcon, RouteIcon, UserIcon, ZapIcon } from './Icons'
export const TeamRunFacts = ({ input, number, chooser, at, flowFile, pullRequest, cost, trigger, continuesNumber, originAction, originNote }: {
  input: RunTimelineInput | null; number: number; chooser?: ReactNode; at: string | null
  continuesNumber?: number
  originAction?: ReactNode; originNote?: string
  trigger?: ReactNode; flowFile?: ReactNode; pullRequest?: { number: number; url: string | null } | null; cost?: string | null
}) => {
  if (!input) return <><ToolProse variant="note">No Run recorded.</ToolProse><SummaryList surface="panel" keys="icon" aria-label="Team Run facts">
    {at && <SummaryItem label="At" icon={<FolderIcon />} kind="path">{sanitizeText(at)}</SummaryItem>}
    {trigger && <SummaryItem label="Trigger" icon={<ZapIcon />}>{trigger}</SummaryItem>}
  </SummaryList></>
  const facts = teamRunFacts(input), model = runTimeline(input), execution = input.execution
  const request = facts.pr ?? pullRequest
  const link = request?.url
  const end = currentRunEnd(execution)
  const elapsed = execution.startedAt != null && (execution.state === 'running' || end !== null)
    ? formatDuration(Math.max(0, (end ?? Date.now()) - execution.startedAt)) : 'Time not recorded'
  const state = { running: 'Running', settled: 'Settled', stopped: 'Stopped', stalled: 'Needs you' }[execution.state]
  const round = execution.rounds.at(-1)?.n
  const progress = round == null ? 'Not started' : `Round ${round}${facts.roundLimit == null ? '' : ` of ${facts.roundLimit}`}`

  return <>
    <SummaryList surface="panel" keys="icon" aria-label="Team Run facts">
      {chooser && <SummaryItem label="Run" icon={<HistoryIcon />} action={chooser}>{`Run ${number}`}</SummaryItem>}
      <SummaryItem label="State" icon={<BackgroundIcon />}>{state}</SummaryItem>
      <SummaryItem label="Flow" icon={<FlowIcon />}>{facts.flow}</SummaryItem>
      <SummaryItem label="Progress" icon={<RefreshIcon />}>{progress}</SummaryItem>
      <SummaryItem label="Elapsed" icon={<ClockIcon />}>{elapsed}</SummaryItem>
      {facts.origin !== 'Not recorded' && <SummaryItem label="Started by" icon={<UserIcon />} action={originAction} note={originNote}>{facts.origin}</SummaryItem>}
      {trigger && <SummaryItem label="Trigger" icon={<ZapIcon />}>{trigger}</SummaryItem>}
      {at && <SummaryItem label="At" icon={<FolderIcon />} kind="path">{sanitizeText(at!)}</SummaryItem>}
      {facts.branch && <SummaryItem label="Branch" icon={<BranchIcon />} kind="path">{sanitizeText(facts.branch!)}</SummaryItem>}
      {request && <SummaryItem label="Pull request" icon={<PullRequestIcon />} note={facts.stale ? 'Earlier observation' : undefined}
        action={link ? <Button variant="link" size="inline-link" onClick={() => void openExternal(link)}>Open</Button> : undefined}>
        {`#${request!.number}`}
      </SummaryItem>}
      {facts.checks && <SummaryItem label="Checks" icon={<CheckAllIcon />}>{facts.checks.length ? [...new Set(facts.checks.map(one => one.state))].map(state => `${facts.checks!.filter(one => one.state === state).length} ${state}`).join(' · ') : 'No checks'}</SummaryItem>}
      {facts.changes && <SummaryItem label="Changes" icon={<DiffIcon />}><ChangeStats added={facts.changes.added} removed={facts.changes.removed} /></SummaryItem>}
      {model.header.answer && !request && <SummaryItem label="Answer at" icon={<CommitIcon />} kind="path">{sanitizeText(model.header.answer.revision)}</SummaryItem>}
      {cost && <SummaryItem label="Seat cost" icon={<CostIcon />}>{cost}</SummaryItem>}
      {execution.continues && <SummaryItem label="Continues" icon={<RouteIcon />}>{continuesNumber ? `Run ${continuesNumber}` : 'an earlier Run'}</SummaryItem>}
      {model.header.publication?.label && <SummaryItem label="Publication" icon={<CommentIcon />}>{model.header.publication?.label}</SummaryItem>}
    </SummaryList>
    <ToolFold label="Record details">
      <SummaryList surface="panel" aria-label="Run record details">
        <SummaryItem label="Run">{`Run ${number}`}</SummaryItem>
        {cost == null && <SummaryItem label="Seat cost">Not recorded</SummaryItem>}
        {execution.brief && <SummaryItem label="Brief">{sanitizeText(execution.brief)}</SummaryItem>}
        {execution.base && <SummaryItem label="Base" kind="path">{sanitizeText(`${execution.base.remote} · ${execution.base.branch ?? 'Default branch'} · ${execution.base.at}`)}</SummaryItem>}
        {facts.revision && <SummaryItem label="Revision" kind="path">{sanitizeText(facts.revision)}</SummaryItem>}
        <SummaryItem label="Flow file" action={flowFile}>Current catalogue</SummaryItem>
        {facts.budget !== 'Not recorded' && <SummaryItem label="Budget">{facts.budget}</SummaryItem>}
        {facts.idle !== 'Not recorded' && <SummaryItem label="No progress">{facts.idle}</SummaryItem>}
        {execution.startedAt != null && <SummaryItem label="Started">{new Date(execution.startedAt).toLocaleString()}</SummaryItem>}
        {facts.extra && <SummaryItem label="Extra rounds">{sanitizeText(facts.extra)}</SummaryItem>}
      </SummaryList>
    </ToolFold>
  </>
}
