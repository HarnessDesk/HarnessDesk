import type { ReactNode } from 'react'
import { Button, SummaryList, SummaryItem, Text, ChangeStats, ToolProse } from '../design'
import { teamRunFacts } from '../lib/team-run-facts'
import { runTimeline, currentRunEnd, type RunTimelineInput } from '../lib/run-timeline'
import { sanitizeText } from '../lib/sanitize'
import { openExternal } from '../lib/desktop'
import { formatDuration } from './TurnTail'
import { commitDate } from '../lib/git-refs'
export const TeamRunFacts = ({ input, number, chooser, at, flowFile, pullRequest, cost, trigger, continuesNumber }: {
  input: RunTimelineInput | null; number: number; chooser?: ReactNode; at: string | null
  continuesNumber?: number
  trigger?: ReactNode; flowFile?: ReactNode; pullRequest?: { number: number; url: string | null } | null; cost?: string | null
}) => {
  if (!input) return <><Text role="meta">No Run recorded.</Text><SummaryList surface="panel" aria-label="Team Run facts">
    {at && <SummaryItem label="At" kind="path">{sanitizeText(at)}</SummaryItem>}
    {trigger && <SummaryItem label="Trigger">{trigger}</SummaryItem>}
  </SummaryList></>
  const facts = teamRunFacts(input), model = runTimeline(input), execution = input.execution
  const request = facts.pr ?? pullRequest
  const link = request?.url
  const missing = [facts.budget === 'Not recorded' && 'the budget', facts.idle === 'Not recorded' && 'the no-progress limit', facts.origin === 'Not recorded' && 'what started it', !execution.brief && 'the brief', !facts.revision && "the Flow's revision", !execution.base && 'the base', !at && 'the commit', !facts.branch && 'the branch', !request && 'the pull request', execution.startedAt == null && 'the start time', execution.startedAt != null && execution.state !== 'running' && currentRunEnd(execution) === null && 'elapsed time', cost == null && 'Seat costs', !model.header.publication && 'publication'].filter(Boolean)

  return <>
    <SummaryList surface="panel" aria-label="Team Run facts">
      <SummaryItem label="Run" action={chooser}>{`Run ${number}`}</SummaryItem>
      <SummaryItem label="State">{sanitizeText(execution.state)}</SummaryItem>
      {execution.brief && <SummaryItem label="Brief">{sanitizeText(execution.brief)}</SummaryItem>}
      {execution.base && <SummaryItem label="Base" kind="path">{sanitizeText(`${execution.base.remote} · ${execution.base.branch ?? 'Default branch'} · ${execution.base.at}`)}</SummaryItem>}
      <SummaryItem label="Flow" note={facts.revision ? `Revision ${sanitizeText(facts.revision)}` : undefined}>{facts.flow}</SummaryItem>
      <SummaryItem label="Flow file" action={flowFile}>Current catalogue</SummaryItem>
      {facts.budget !== 'Not recorded' && <SummaryItem label="Budget">{facts.budget}</SummaryItem>}
      {facts.idle !== 'Not recorded' && <SummaryItem label="No progress">{facts.idle}</SummaryItem>}
      {facts.origin !== 'Not recorded' && <SummaryItem label="Started by">{facts.origin}</SummaryItem>}
      {trigger && <SummaryItem label="Trigger">{trigger}</SummaryItem>}
      {at && <SummaryItem label="At" kind="path">{sanitizeText(at!)}</SummaryItem>}
      {facts.branch && <SummaryItem label="Branch" kind="path">{sanitizeText(facts.branch!)}</SummaryItem>}
      {request && <SummaryItem label="Pull request" note={facts.stale ? 'Earlier observation' : undefined}
        action={link ? <Button variant="link" size="inline-link" onClick={() => void openExternal(link)}>Open</Button> : undefined}>
        {`#${request!.number}`}
      </SummaryItem>}
      {facts.checks && <SummaryItem label="Checks">{facts.checks.length ? [...new Set(facts.checks.map(one => one.state))].map(state => `${facts.checks!.filter(one => one.state === state).length} ${state}`).join(' · ') : 'No checks'}</SummaryItem>}
      {facts.changes && <SummaryItem label="Changes"><ChangeStats added={facts.changes.added} removed={facts.changes.removed} /></SummaryItem>}
      {model.header.answer && !request && <SummaryItem label="Answer at" kind="path">{sanitizeText(model.header.answer.revision)}</SummaryItem>}
      {execution.startedAt != null && (execution.state === 'running' || currentRunEnd(execution) !== null) && <SummaryItem label="Elapsed">{execution.startedAt == null || (execution.state !== 'running' && currentRunEnd(execution) === null) ? 'Not recorded' : formatDuration(Math.max(0, (currentRunEnd(execution) ?? Date.now()) - execution.startedAt))}</SummaryItem>}
      {execution.startedAt != null && <SummaryItem label="Started">{execution.startedAt == null ? 'Not recorded' : commitDate(execution.startedAt, Date.now())}</SummaryItem>}
      <SummaryItem label="Rounds">{execution.rounds.length}</SummaryItem>
      {cost && <SummaryItem label="Seat cost">{cost}</SummaryItem>}
      {execution.continues && <SummaryItem label="Continues">{continuesNumber ? `Run ${continuesNumber}` : 'an earlier Run'}</SummaryItem>}
      {model.header.publication?.label && <SummaryItem label="Publication">{model.header.publication?.label}</SummaryItem>}
    </SummaryList>
    {missing.length > 0 && <ToolProse variant="note">Not recorded for this Run: {missing.join(', ')}.</ToolProse>}
    {facts.extra && <Text role="prose">{sanitizeText(facts.extra)}</Text>}
  </>
}
