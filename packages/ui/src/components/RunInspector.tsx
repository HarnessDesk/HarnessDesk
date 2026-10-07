import { AgentIcon, PullRequestIcon } from './Icons'
import { openExternal } from '../lib/desktop'
import type { FindingRoundPublication, FlowCheckAttempt, GoalState } from '@harnessdesk/protocol'
import { attemptWords, runTimeline, type RunTimelineInput } from '../lib/run-timeline'
import type { SeatRow } from '../lib/team-overview'
export interface InspectorSeat {
  id: string
  name: string
  override?: string | null
  cost?: SeatRow['cost']
  onOpen?: () => void
}
export interface RunInspectorProps {
  home?: string | null
  teamState?: GoalState | undefined
  input: RunTimelineInput
  selectedRow: string | null
  seats: readonly InspectorSeat[]
  faces?: ReadonlyMap<string, ReactNode>
  faceTints?: ReadonlyMap<string, Tint>
  pullRequest?: { number: number; url: string | null } | null
  flowFile?: ReactNode
  /** Abandons a card; rejects with the host's refusal. Without it a card offers no abandoning. */
  onAbandon?: (card: number) => Promise<void>
  onStop?: (() => void) | undefined
  /** Answers a person's step; rejects with the host's refusal. Without it the step's words are text. */
  onAnswer?: (card: number, outcome: string | null, note: string) => Promise<void>
  /** Opens the board, where a review step's attempt is chosen. */
  onOpenBoard?: () => void
  publication?: FindingRoundPublication | null
  reviewActions?: ReviewActionsTarget
  /**
   * Why a finding that is not here may still exist: the read of them is still `reading`, or it `failed`.
   * Unset once every finding has been read. With no `input.findings` at all nothing has landed, so `reading`.
   */
  findingsRead?: 'reading' | 'failed'
  /**
   * Why this check's attempts are not in `input.attempts`: they are still being `read`, or the read `failed`. Incomplete
   * histories are card-scoped on `input.incompleteAttempts` so another check's damaged record does not taint this one.
   */
  attemptsRead?: 'reading' | 'failed'
}

import { Button, Card, CardHeader, CardTitle, CardAction, CardContent, Chip, CodeText, GroupLabel, IconTile, KeyValue, KeyValueRow, ChangeStats, PanelBody, SectionBody, PanelFooter, PanelFrame, PanelRow, PanelTools, Progress, RunStateChip, stateTone, Text, type Tint } from '../design'
import { commandShown } from '../lib/projects'
import { sanitizeText } from '../lib/sanitize'
import { wordOf } from '../lib/agents'
import { lifecycleWords } from '../lib/findings'
import { reviewPublication } from '../lib/review-publication'
import { ReviewPublicationActions, type ReviewActionsTarget } from './ReviewPublicationActions'
import { commitDate } from '../lib/git-refs'
import { useState, type ReactNode } from 'react'
import { RunAgain } from './RetryCheck'
import { isRecordState, RECORD_REASON } from '../lib/team-record'
import { stepDoor } from '../lib/needs-you'
import { AbandonCard } from './AbandonCard'
import { StepAnswer } from './StepAnswer'

const Section = ({ title, children }: { title: string; children: ReactNode }) => <section className="flex min-w-0 flex-col gap-2">
  <GroupLabel>{title}</GroupLabel>{children}
</section>
const Words = ({ children }: { children: string }) => <Text as="div" role="prose" className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{sanitizeText(children)}</Text>
/**
 * One recorded result of a check: how it ended, when, and the commit it ran at. Its output is the command's own text, which
 * can hold anything a repository or a tool printed, so it goes through the sanitiser like every other agent-reachable text
 * here; it stays behind a link because an earlier attempt's output is there to be read, not to lengthen every inspector.
 */
const Attempt = ({ attempt, incomplete }: { attempt: FlowCheckAttempt; incomplete: boolean }) => {
  const [open, setOpen] = useState(false)
  return <div data-attempt={incomplete || attempt.n === null ? 'unknown' : attempt.n} className="flex min-w-0 flex-col items-start gap-1">
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <Text role="row">{incomplete || attempt.n === null ? 'Recorded result' : `Attempt ${attempt.n}`}</Text>
      <Chip tone="neutral">{sanitizeText(attemptWords(attempt))}</Chip>
      <Text role="meta" numeric>{commitDate(attempt.at, Date.now())}</Text>
    </div>
    <Text role="meta" as="div" title={sanitizeText(attempt.commit)}>{attempt.timedOut ? 'Timed out' : attempt.exit === null ? 'No exit recorded' : `Exit ${attempt.exit}`} · {sanitizeText(attempt.commit.slice(0, 12))}</Text>
    <Button variant="link" size="inline-link" aria-expanded={open} onClick={() => setOpen(was => !was)}>{open ? 'Hide output' : 'Show output'}</Button>
    {open && <CodeText block wrap className="self-stretch">{sanitizeText(attempt.tail || 'No output was printed')}</CodeText>}
  </div>
}
const costWords = (cost: InspectorSeat['cost']): string => cost ? `${cost.estimated ? 'About ' : ''}${cost.unit === 'money' ? `$${cost.value.toFixed(2)}` : `${cost.value} turns`}` : 'Not recorded'

/** flow-execution appends these tool instructions after the rendered sentence.
 * Remove only those complete trailing paragraphs, keeping authored text.
 * The host joins paragraphs with a blank line, but a sentence written as a
 * YAML `|` block ends in a newline of its own, so more than one blank line can
 * come before them. The breaks are kept as they were written. */
const detailWords = (detail: string | null | undefined): string | null => {
  const parts = detail?.trim().split(/(\n{2,})/) ?? [] // paragraph, break, paragraph, ...
  const completion = /^Finish this with complete_claim and an outcome of exactly one of: [^\n]+\.$/
  const split = /^Finish this with complete_claim's split as well: the agreed split of files for the "[^"\n]+" round, one list of path patterns for each of its \d+ cards?, in card order, no two overlapping\. Each of those cards will own only its own list\.$/
  while (parts.length && (completion.test(parts.at(-1)!) || split.test(parts.at(-1)!))) parts.splice(-2) // the paragraph and the break before it
  return parts.join('') || null
}

/** Recorded detail only. No transcript copies, dispatch controls or guessed results. */
export const RunInspector = ({ home, teamState, input, selectedRow, seats, onAbandon, onStop, onAnswer, onOpenBoard, publication, reviewActions, findingsRead, attemptsRead, faces, faceTints, pullRequest, flowFile }: RunInspectorProps) => {
  const { execution, cards, evidence } = input
  const selected = runTimeline(input).rows.find(row => row.id === selectedRow)
  const round = execution.rounds.find(one => one.n === selected?.round)
  const card = cards.find(one => one.id === selected?.card)
  const role = execution.document.flow.roles.find(one => one.id === round?.role)
  const seat = seats.find(one => one.id === selected?.seat)
  const findings = (input.findings ?? []).filter(one => one.origin.run === execution.id && one.origin.round === selected?.round
    && (selected?.kind === 'findings' || one.origin.card === selected?.card))
  // None is only said of a read that is whole: until then, say what is happening to it instead.
  const unread = findingsRead ?? (input.findings ? undefined : 'reading')
  const showFindings = <Section title="Findings">{findings.length ? findings.map(finding => <div key={finding.id} className="flex min-w-0 flex-col gap-1">
    <Words>{finding.title}</Words><Text role="meta">{lifecycleWords(finding)}</Text><Words>{finding.body}</Words>{finding.problem && <Words>{finding.problem}</Words>}
  </div>) : unread === 'reading' ? <Text role="meta" as="div">Reading findings…</Text>
    : <Words>{unread === 'failed' ? 'Findings could not be read' : 'No findings recorded'}</Words>}</Section>
  const title = card ? `#${card.id} · ${card.title}` : selected?.kind === 'findings' ? 'Findings' : 'Run details'
  const abandon = onAbandon && card
    ? <div><AbandonCard key={JSON.stringify([execution.id, card.id])} execution={execution} cards={cards} card={card} holder={seat?.name} onAbandon={onAbandon} onStop={onStop} /></div>
    : null
  let body: ReactNode
  if (selected?.kind === 'check' && card && role?.kind === 'check' && role.check) {
    const check = role.check
    const results = input.attempts?.get(card.id)
    const incomplete = input.incompleteAttempts?.has(card.id) ?? false
    const record = evidence?.cards.find(one => one.card === card.id)?.facts.map(one => one.record)
      .filter(one => one.round === round?.n && one.fact.kind === 'check' && one.fact.name === role.id && one.fact.run === check.run)
      .sort((a, b) => b.observedAt - a.observedAt)[0]
    const fact = record?.fact.kind === 'check' ? record.fact : null
    body = <>
      <Section title="Command"><CodeText block wrap title={sanitizeText(check.run)}>{sanitizeText(commandShown(check.run, home))}</CodeText></Section>
      <Section title="Where"><Words>{record?.checkout?.cwd ?? (check.cwd ? `Declared folder: ${check.cwd} · Run location not recorded` : 'Run location not recorded')}</Words></Section>
      <Section title="Limit"><Words>{`${check.timeout} seconds`}</Words></Section>
      <Section title="Exit mapping"><Words>{[...Object.entries(check.exits).map(([exit, outcome]) => `Exit ${exit} → ${wordOf(outcome)}`), `Other exits and timeout → ${wordOf(check.otherwise)}`].join('\n')}</Words></Section>
      <Section title="Latest result"><Words>{selected.status ?? 'Result unavailable'}</Words>{fact && <Text role="meta">{fact.timedOut ? 'Timed out' : fact.exit === null ? 'No exit recorded' : `Exit ${fact.exit}`} · {sanitizeText(fact.at)}</Text>}</Section>
      <Section title="Output">{fact ? <CodeText block wrap>{sanitizeText(fact.tail || 'No output was printed')}</CodeText> : <Words>Output is not kept for this check</Words>}</Section>
      {/* Once it has run more than once, each result the desk recorded — the latest above is the last of them. */}
      {incomplete || (results && results.length > 1) ? <Section title="Attempts">
        {incomplete && <Words>Attempt history could not be read completely.</Words>}
        {[...(results ?? [])].reverse().map(one => <Attempt key={one.id} attempt={one} incomplete={incomplete} />)}
      </Section> : !results && attemptsRead ? <Section title="Attempts">{attemptsRead === 'failed' ? <Words>Earlier attempts could not be read</Words>
        : <Text role="meta" as="div">Reading attempts…</Text>}</Section> : null}
      {abandon}
      <RunAgain run={execution.id} card={card.id} refusal={isRecordState(teamState) ? RECORD_REASON : selected.retryRefusal} terminal={isRecordState(teamState) || execution.state === 'settled' || execution.state === 'stopped'} />
    </>
  } else if (selected?.kind === 'person' && card) {
    // A card recorded without its role is still its round's: the round is what opened it.
    const door = onAnswer && onOpenBoard && round ? stepDoor({ ...card, role: card.role ?? round.role }, execution) : null
    body = <><Section title="Step"><Words>{detailWords(card.detail) ?? card.title}</Words></Section>
      {door && onAnswer && onOpenBoard
        ? <Section title="Your answer"><StepAnswer key={JSON.stringify([execution.id, card.id])} door={door} onAnswer={onAnswer} onOpenBoard={onOpenBoard} /></Section>
        : <Section title="Outcomes"><Words>{role?.kind === 'person' ? role.outcomes.map(wordOf).join(' · ') : 'Not recorded'}</Words></Section>}
      {card.outcome && <Section title="Answer"><Words>{wordOf(card.outcome)}</Words></Section>}
      {abandon}
    </>
  } else if (selected?.kind === 'findings') {
    body = showFindings
  } else if (selected?.kind === 'card' && card) {
    // Round order is not a handoff edge: independently opened rounds have none.
    const predecessors = cards.filter(one => one.id !== card.id && card.dependsOn.includes(one.id) && one.handoff)
    const runReview = input.findingRun?.run === execution.id && input.findingRun.goal === execution.goal ? input.findingRun : null
    const review = runReview ? runReview.rounds.find(one => one.round === round?.n && one.cards.includes(card.id))
      : publication && publication.round === round?.n && publication.cards.includes(card.id) ? publication : null
    const chip = review ? reviewPublication({ state: review.state,
      pr: review.state === 'local' && runReview ? runReview.boundPr?.pr ?? null : review.pr,
      postingOn: input.publicationOn !== false, hasFindings: review.state !== 'none' }) : null
    const reviewText = [card.handoff, card.note, findings.map(one => `${one.title}\n${one.body}`).join('\n\n')]
      .find(one => one && sanitizeText(one).trim()) ?? ''
    const completeReview = card.state === 'done' && review && review.state !== 'none' && sanitizeText(reviewText).trim() !== ''
    const reviewReason = review?.reason ?? runReview?.reason
    body = <>
      <Section title="Input"><Words>{detailWords(card.detail) ?? 'No input recorded'}</Words>{predecessors.map(one => <div key={one.id}><Text role="meta">From #{one.id}</Text><Words>{one.handoff!}</Words></div>)}</Section>
      <Section title="Handoff"><Words>{card.handoff ?? card.note ?? 'No handoff recorded'}</Words></Section>
      {showFindings}
      <Section title="Review">{chip ? <span><Chip tone={chip.tone}>{chip.label}</Chip></span> : <Words>No review recorded</Words>}
        {reviewReason && <Words>{reviewReason}</Words>}
        {completeReview && reviewActions && round && <ReviewPublicationActions key={JSON.stringify([reviewActions.goal,reviewActions.run,round.n])} {...reviewActions} round={round.n} review={reviewText} alreadyShownReason={reviewReason} />}
      </Section>
      <Section title="Cost"><Words>{costWords(seat?.cost)}</Words><Text role="meta">Recorded for this Seat</Text></Section>
      {abandon}
      {seat?.onOpen ? <Button variant="link" size="inline-link" onClick={seat.onOpen}>Open the conversation</Button> : <Text role="meta">Conversation not kept</Text>}
    </>
  } else {
    return <RunSummary input={input} selectedRow={null} seats={seats} faces={faces} faceTints={faceTints} pullRequest={pullRequest} flowFile={flowFile} />
  }
  return <div data-slot="run-inspector" className="min-h-0 min-w-0 flex-1">
    <PanelFrame inset="reading"><PanelTools><Text role="section" className="min-w-0 break-words [overflow-wrap:anywhere]">{sanitizeText(title)}</Text>
      {card && selected?.status && <Text role="meta">{sanitizeText(selected.status)}</Text>}
    </PanelTools>
      <PanelBody><div className="flex min-w-0 flex-col gap-4">{body}</div></PanelBody>
    </PanelFrame>
  </div>
}

/** The Run's summary keeps only recorded facts, with one explanation for gaps. */
const RunSummary = ({ input, seats, faces, faceTints, pullRequest, flowFile }: RunInspectorProps) => {
  const { execution } = input
  const rows = runTimeline(input).rows
  const budget = execution.findings?.budget
  const extra = execution.findings?.extraRound
  const limit = budget ? Math.max(budget.rounds, extra ? extra.after + (extra.count ?? 1) : 0) : null
  const ids = [...new Set(execution.rounds.flatMap(one => one.seats))]
  const recorded = ids.flatMap(id => { const seat = seats.find(one => one.id === id); return seat ? [seat] : [] })
  const costs = recorded.flatMap(one => one.cost ? [one.cost] : [])
  const totals = (['money', 'turns'] as const).flatMap(unit => {
    const values = costs.filter(one => one.unit === unit)
    return values.length ? [costWords({ unit, value: values.reduce((n, one) => n + one.value, 0), estimated: values.some(one => one.estimated) })] : []
  })
  // Evidence is scoped to the cards this Run actually opened; another Run's PR is not this one's.
  const cardIds = new Set(execution.rounds.flatMap(one => one.cards))
  const facts = (input.evidence?.cards ?? []).filter(one => cardIds.has(one.card)).flatMap(one => one.facts)
    .filter(one => !one.record.restored).sort((a, b) => b.record.observedAt - a.record.observedAt)
  const prRecord = facts.find(one => one.record.fact.kind === 'pr')
  const pr = prRecord?.record.fact.kind === 'pr' ? prRecord.record.fact : null
  const request = pr ?? pullRequest
  const branch = prRecord?.record.checkout?.branch
  const ci = facts.find(one => one.record.fact.kind === 'ci' && one.record.fact.at === pr?.head && one.freshness.state === 'fresh')?.record.fact
  const diff = facts.find(one => one.record.fact.kind === 'diff' && one.record.fact.to === pr?.head && !one.record.fact.dirty && one.freshness.state === 'fresh')?.record.fact
  const gaps = [!execution.brief && 'brief', !execution.revision && 'Flow revision', !execution.base && 'base', !budget && 'budget',
    recorded.length !== ids.length && 'Seat details', costs.length !== ids.length && 'Seat costs'].filter(Boolean)
  const closed = execution.findings?.closedRounds.length ?? execution.rounds.filter(one => one.state === 'closed').length
  const idle = execution.findings?.idleRounds ?? 0
  return <div data-slot="run-inspector" className="min-h-0 min-w-0 flex-1">
    <PanelFrame>
      <PanelBody><div className="flex min-w-0 flex-col gap-(--hd-inset-dense)">
        {execution.brief && <Card as="section">
          <CardHeader><CardTitle><Text role="section">Brief</Text></CardTitle></CardHeader>
          <CardContent><Words>{execution.brief}</Words></CardContent>
        </Card>}
        {recorded.length > 0 && <Card as="section">
          <CardHeader><CardTitle><Text role="section">{`Seats ${ids.length}`}</Text></CardTitle></CardHeader>
          <CardContent inset="none">
            {recorded.map(one => {
              const state = [...rows].reverse().find(row => row.seat === one.id && row.status)?.status
              return <PanelRow key={one.id} mark={<IconTile shape="face" tint={faceTints?.get(one.id) ?? 'violet'}>{faces?.get(one.id) ?? <AgentIcon />}</IconTile>}
                title={sanitizeText(one.name)} sub={one.override ? sanitizeText(one.override) : undefined}
                trail={state ? <RunStateChip state={state} /> : undefined} onClick={one.onOpen} />
            })}
          </CardContent>
        </Card>}
        {request && <Card as="section">
          <CardHeader>
            <CardTitle className="flex min-w-0 flex-wrap items-center gap-2"><PullRequestIcon /><Text role="section">{`Pull request #${request.number}`}</Text>
              {pr && <Chip tone={stateTone(pr.state).tone} stale={prRecord?.freshness.state !== 'fresh'}>{wordOf(pr.state)}</Chip>}
            </CardTitle>
            {request.url && <CardAction><Button variant="link" size="inline-link" onClick={() => openExternal(request.url!)}>Open</Button></CardAction>}
          </CardHeader>
          <CardContent><KeyValue variant="panel" className="grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            {branch && <KeyValueRow label="Branch" variant="panel"><CodeText wrap>{sanitizeText(branch)}</CodeText></KeyValueRow>}
            {pr && prRecord?.freshness.state !== 'fresh' && <KeyValueRow label="Observation" variant="panel">Earlier observation</KeyValueRow>}
            {ci?.kind === 'ci' && <KeyValueRow label="Checks" variant="panel"><span className="inline-flex flex-wrap items-center gap-1">
              {[...new Set(ci.checks.map(one => one.state))].map((state, index) => <span key={state} className="inline-flex items-center gap-1">
                {index > 0 && <Text role="meta">·</Text>}
                <Text role="meta" numeric tone={state === 'pending' ? 'info' : state === 'cancelled' ? 'neutral' : stateTone(state).tone}>{`${ci.checks.filter(one => one.state === state).length} ${state}`}</Text>
              </span>)}
              {ci.checks.length === 0 && <Text role="meta">No checks</Text>}
            </span></KeyValueRow>}
            {diff?.kind === 'diff' && <KeyValueRow label="Changes" variant="panel"><ChangeStats added={diff.added} removed={diff.removed} /></KeyValueRow>}
          </KeyValue></CardContent>
        </Card>}
        <Card as="section">
          <CardHeader><CardTitle><Text role="section">Run</Text></CardTitle>{flowFile && <CardAction>{flowFile}</CardAction>}</CardHeader>
          <CardContent><KeyValue variant="panel" className="grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <KeyValueRow label="Flow" variant="panel">{sanitizeText(execution.document.flow.name)}{execution.revision ? ` · ${sanitizeText(execution.revision)}` : ''}</KeyValueRow>
            {execution.base && <KeyValueRow label="Base" variant="panel">{sanitizeText(`${execution.base.remote} · ${execution.base.branch ?? 'Default branch'} · ${execution.base.at}`)}</KeyValueRow>}
            {input.origin && <KeyValueRow label="Started by" variant="panel">{sanitizeText(input.origin)}</KeyValueRow>}
            {budget && <KeyValueRow label="Budget" variant="panel"><Progress size="sm" value={closed} max={limit!} label={`${closed} of ${limit} rounds`} aria-label="Budget" /></KeyValueRow>}
            {budget && <KeyValueRow label="Without progress" variant="panel"><Progress size="sm" value={idle} max={budget.withoutProgress} label={`${idle} of ${budget.withoutProgress} rounds`} aria-label="Without progress" /></KeyValueRow>}
            {totals.length > 0 && <KeyValueRow label="Cost" variant="panel">{totals.join(' · ')}{costs.length < ids.length ? ' · Partial' : ''}</KeyValueRow>}
          </KeyValue>
          {extra && <div className="mt-2"><Words>{`Authorized after round ${extra.after}: ${extra.count ?? 1} more ${(extra.count ?? 1) === 1 ? 'round' : 'rounds'}\n${extra.reason}`}</Words></div>}
          </CardContent>
        </Card>
        {gaps.length > 0 && <div data-slot="run-recording-gaps"><SectionBody spacing="inline"><Text as="p" role="meta">{`This Run did not record: ${gaps.join(', ')}.`}</Text></SectionBody></div>}
      </div></PanelBody>
      <PanelFooter left="Recorded for this Run" right={`${execution.rounds.length} ${execution.rounds.length === 1 ? 'round' : 'rounds'}`} />
    </PanelFrame>
  </div>
}
