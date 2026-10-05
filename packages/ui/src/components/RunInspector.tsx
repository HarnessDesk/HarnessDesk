import type { FindingRoundPublication, FlowCheckAttempt } from '@harnessdesk/protocol'
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
  input: RunTimelineInput
  selectedRow: string | null
  seats: readonly InspectorSeat[]
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

import { Button, Chip, CodeText, GroupLabel, PanelBody, PanelFrame, PanelTools, Text } from '../design'
import { sanitizeText } from '../lib/sanitize'
import { wordOf } from '../lib/agents'
import { lifecycleWords } from '../lib/findings'
import { reviewPublication } from '../lib/review-publication'
import { ReviewPublicationActions, type ReviewActionsTarget } from './ReviewPublicationActions'
import { commitDate } from '../lib/git-refs'
import { useState, type ReactNode } from 'react'
import { RunAgain } from './RetryCheck'
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
export const RunInspector = ({ input, selectedRow, seats, onAbandon, onStop, onAnswer, onOpenBoard, publication, reviewActions, findingsRead, attemptsRead }: RunInspectorProps) => {
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
      <Section title="Command"><CodeText block wrap>{sanitizeText(check.run)}</CodeText></Section>
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
      <RunAgain run={execution.id} card={card.id} refusal={selected.retryRefusal} />
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
    const reviewText = card.handoff ?? card.note ?? findings.map(one => `${one.title}\n${one.body}`).join('\n\n')
    const reviewReason = review?.reason ?? runReview?.reason
    body = <>
      <Section title="Input"><Words>{detailWords(card.detail) ?? 'No input recorded'}</Words>{predecessors.map(one => <div key={one.id}><Text role="meta">From #{one.id}</Text><Words>{one.handoff!}</Words></div>)}</Section>
      <Section title="Handoff"><Words>{card.handoff ?? card.note ?? 'No handoff recorded'}</Words></Section>
      {showFindings}
      <Section title="Review">{chip ? <span><Chip tone={chip.tone}>{chip.label}</Chip></span> : <Words>No review recorded</Words>}
        {reviewReason && <Words>{reviewReason}</Words>}
        {reviewActions && round && <ReviewPublicationActions key={JSON.stringify([reviewActions.goal,reviewActions.run,round.n])} {...reviewActions} round={round.n} review={reviewText} alreadyShownReason={reviewReason} />}
      </Section>
      <Section title="Cost"><Words>{costWords(seat?.cost)}</Words><Text role="meta">Recorded for this Seat</Text></Section>
      {abandon}
      {seat?.onOpen ? <Button variant="link" size="inline-link" onClick={seat.onOpen}>Open the conversation</Button> : <Text role="meta">Conversation not kept</Text>}
    </>
  } else {
    // Only what the Run recorded: one saved before budgets has none, and a Flow's own or the default
    // budget is what a new Run would freeze, so reading it back would invent a limit (docs/flows.md).
    const budget = execution.findings?.budget ?? null
    const extra = execution.findings?.extraRound
    const roundLimit = budget ? Math.max(budget.rounds, extra ? extra.after + (extra.count ?? 1) : 0) : null
    const ids = new Set(execution.rounds.flatMap(one => one.seats))
    body = <>
      <Section title="Brief"><Words>{execution.brief ?? 'No brief recorded'}</Words></Section>
      <Section title="Flow"><Words>{`${execution.document.flow.name}${execution.revision ? ` · ${execution.revision}` : ' · Revision not recorded'}`}</Words></Section>
      <Section title="Seats">{ids.size ? [...ids].map(id => { const one = seats.find(item => item.id === id); return <div key={id}><Words>{one?.name ?? 'Seat not recorded'}</Words>{one?.override && <Text role="meta">{sanitizeText(one.override)}</Text>}</div> }) : <Words>No Seats opened</Words>}</Section>
      <Section title="Base"><Words>{execution.base ? `${execution.base.remote} · ${execution.base.branch ?? 'Default branch'} · ${execution.base.at}` : 'Not recorded'}</Words></Section>
      <Section title="Started by"><Words>{input.origin ?? 'Not recorded'}</Words></Section>
      <Section title="Budgets"><Words>{`Rounds: ${execution.findings?.closedRounds.length ?? execution.rounds.filter(one => one.state === 'closed').length}${roundLimit !== null ? ` of ${roundLimit}` : ' · Limit not recorded'}\nRounds without progress: ${execution.findings?.idleRounds ?? 'Not recorded'}${budget ? ` · Limit ${budget.withoutProgress}` : ''}`}</Words>
        {extra && <Words>{`Authorized after round ${extra.after}: ${extra.count ?? 1} more ${(extra.count ?? 1) === 1 ? 'round' : 'rounds'}\n${extra.reason}`}</Words>}
      </Section>
      <Section title="Cost">{[...ids].map(id => { const one = seats.find(item => item.id === id); return <Words key={id}>{`${one?.name ?? 'Seat'} · ${costWords(one?.cost)}`}</Words> })}<Text role="meta">Recorded for these Seats</Text></Section>
    </>
  }
  return <div data-slot="run-inspector" className="min-h-0 min-w-0 flex-1">
    <PanelFrame inset="reading"><PanelTools><Text role="section" className="min-w-0 break-words [overflow-wrap:anywhere]">{sanitizeText(title)}</Text>
      {card && selected?.status && <Text role="meta">{sanitizeText(selected.status)}</Text>}
    </PanelTools>
      <PanelBody><div className="flex min-w-0 flex-col gap-4">{body}</div></PanelBody>
    </PanelFrame>
  </div>
}
