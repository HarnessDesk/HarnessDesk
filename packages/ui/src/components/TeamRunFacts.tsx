import type { ReactNode } from 'react'
import { Button, SummaryList, SummaryItem, Text, ChangeStats } from '../design'
import { teamRunFacts } from '../lib/team-run-facts'
import { runTimeline, currentRunEnd, type RunTimelineInput } from '../lib/run-timeline'
import { sanitizeText } from '../lib/sanitize'
import { openExternal } from '../lib/desktop'
import { formatDuration } from './TurnTail'
import { commitDate } from '../lib/git-refs'
export const TeamRunFacts = ({ input, number, chooser, at, flowFile, pullRequest, cost, trigger }: {
  input: RunTimelineInput | null; number: number; chooser?: ReactNode; at: string | null
  trigger?: ReactNode; flowFile?: ReactNode; pullRequest?: { number: number; url: string | null } | null; cost?: string | null
}) => {
  if (!input) return <><Text role="meta">No Run recorded.</Text><SummaryList surface="panel" aria-label="Team Run facts">
    <SummaryItem label="At" kind="path">{sanitizeText(at ?? 'Not recorded')}</SummaryItem>
    {trigger && <SummaryItem label="Trigger">{trigger}</SummaryItem>}
  </SummaryList></>
  const facts = teamRunFacts(input), model = runTimeline(input), execution = input.execution
  const request = facts.pr ?? pullRequest
  const link = request?.url
  return <>
    <SummaryList surface="panel" aria-label="Team Run facts">
      <SummaryItem label="Run" action={chooser}>{`Run ${number}`}</SummaryItem>
      <SummaryItem label="State">{sanitizeText(execution.state)}</SummaryItem>
      <SummaryItem label="Brief">{sanitizeText(execution.brief ?? 'Not recorded')}</SummaryItem>
      <SummaryItem label="Base" kind="path">{execution.base ? sanitizeText(`${execution.base.remote} · ${execution.base.branch ?? 'Default branch'} · ${execution.base.at}`) : 'Not recorded'}</SummaryItem>
      <SummaryItem label="Flow" note={facts.revision ? `Revision ${sanitizeText(facts.revision)}` : 'Revision not recorded'}>{facts.flow}</SummaryItem>
      <SummaryItem label="Flow file" action={flowFile}>Current catalogue</SummaryItem>
      <SummaryItem label="Budget">{facts.budget}</SummaryItem>
      <SummaryItem label="No progress">{facts.idle}</SummaryItem>
      <SummaryItem label="Started by">{facts.origin}</SummaryItem>
      {trigger && <SummaryItem label="Trigger">{trigger}</SummaryItem>}
      <SummaryItem label="At" kind="path">{sanitizeText(at ?? 'Not recorded')}</SummaryItem>
      <SummaryItem label="Branch" kind="path">{sanitizeText(facts.branch ?? 'Not recorded')}</SummaryItem>
      <SummaryItem label="Pull request" note={facts.stale ? 'Earlier observation' : undefined}
        action={link ? <Button variant="link" size="inline-link" onClick={() => void openExternal(link)}>Open</Button> : undefined}>
        {request ? `#${request.number}` : 'Not recorded'}
      </SummaryItem>
      {facts.checks && <SummaryItem label="Checks">{facts.checks.length ? [...new Set(facts.checks.map(one => one.state))].map(state => `${facts.checks!.filter(one => one.state === state).length} ${state}`).join(' · ') : 'No checks'}</SummaryItem>}
      {facts.changes && <SummaryItem label="Changes"><ChangeStats added={facts.changes.added} removed={facts.changes.removed} /></SummaryItem>}
      {model.header.answer && !request && <SummaryItem label="Answer at" kind="path">{sanitizeText(model.header.answer.revision)}</SummaryItem>}
      <SummaryItem label="Elapsed">{execution.startedAt == null || (execution.state !== 'running' && currentRunEnd(execution) === null) ? 'Not recorded' : formatDuration(Math.max(0, (currentRunEnd(execution) ?? Date.now()) - execution.startedAt))}</SummaryItem>
      <SummaryItem label="Started">{execution.startedAt == null ? 'Not recorded' : commitDate(execution.startedAt, Date.now())}</SummaryItem>
      <SummaryItem label="Rounds">{execution.rounds.length}</SummaryItem>
      <SummaryItem label="Seat cost">{cost ?? 'Not recorded'}</SummaryItem>
      {execution.continues && <SummaryItem label="Continues">{sanitizeText(execution.continues)}</SummaryItem>}
      <SummaryItem label="Publication">{model.header.publication?.label ?? 'Not recorded'}</SummaryItem>
    </SummaryList>
    {facts.extra && <Text role="prose">{sanitizeText(facts.extra)}</Text>}
  </>
}
