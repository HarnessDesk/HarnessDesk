import { checkRetryRefusal, currentTurn, isBusy, sessionKey, type Session, type SessionKey, type BoardEvidence, type EvidenceView, type FindingRunView, type FindingView, type FlowCheckAttempt, type FlowExecution, type Intent, type TeamSignal } from '@harnessdesk/protocol'
import { lifecycleWords } from './words.js'
import { reviewPublication, runPublication, type ReviewPublication } from './review-publication.js'
import { wordOf } from './words.js'
import { runNeedsAttention } from './run-attention.js'

/**
 * Shared plain-data contract: runTimeline(input)
 * returns { header: RunHeader, rows: RunTimelineRow[] }. Stable row ids are
 * scoped to this Run; the inspector owns the selected id, never a DOM node.
 * Unknown times/results stay null. A check's earlier attempts come from a
 * separate read (`flow/check/attempts`), passed in as `attempts`.
 */
export interface RunHeader {
  run: string
  flow: string
  state: FlowExecution['state']
  needsYou: boolean
  publication: ReviewPublication | null
  revision: string | null
  continues: string | null
  end: FlowExecution['end']
  interruptedCheck: number | null
  /**
   * What a Run that makes no pull request made: the revision of the answer it
   * committed, when its Flow says a person reads the committed change. Null for
   * every other Run, whose pull request (or nothing yet) says the rest.
   */
  answer: { revision: string } | null
}
/** One attempt of a round of competitors, as the judge's pick reads it. */
export interface RunAttempt {
  card: number
  /** "Attempt A": the order the round opened them in. */
  label: string
  /** Where its work stood when it finished, from its recorded change; null when none was recorded. */
  revision: string | null
  /** Once the judge has picked: whether this is the revision it kept. Null while no pick is recorded or it names none of them. */
  keep: 'kept' | 'not-kept' | null
}
/** What the judge's recorded review chose among the attempts. */
export interface RunPick {
  /** The revision the review picked, as the desk recorded it. */
  revision: string
  attempts: readonly RunAttempt[]
}
/** The change a card left, as the desk recorded it when the card finished. */
export interface RunChange {
  revision: string
  from: string
  added: number
  removed: number
  files: number
  /** The checkout the fact was observed in, and its branch; null when it recorded none. */
  cwd: string | null
  branch: string | null
}
export interface RunTimelineRow {
  id: string
  kind: 'start' | 'brief' | 'round' | 'card' | 'check' | 'attempt' | 'person' | 'findings' | 'ahead' | 'end'
  title: string
  detail: string | null
  round: number | null
  card: number | null
  seat: string | null
  status: string | null
  attention: boolean
  durationMs: number | null
  since: number | null
  working: boolean
  /** Round rows only: every recorded card is done or abandoned, independent of closure. */
  complete: boolean | null
  publication: ReviewPublication | null
  /**
   * A check row only: why the check cannot be run again from what its Run and
   * its operation say (`checkRetryRefusal`, the host's sentence), or null when
   * it may be asked. The host can still refuse for what only it sees, in the
   * consent dialog. Null on every other row, where it means nothing.
   */
  retryRefusal: string | null
  /** Round rows only: how many cards the round opened, and how many of them are done or abandoned. */
  asked: number | null
  answered: number | null
  /**
   * Round rows only: the round is open on a live Run and its several read-only
   * Seats may not read one another until it closes, as its Flow file declares.
   */
  blind: boolean
  /** A card of a round of isolated competitors: "Attempt A". Null on every other row. */
  attempt: string | null
  /** A check card that ran on one of those attempts: its label. Null when the check names none, or none can be told. */
  on: string | null
  /** An attempt once a pick is recorded. */
  keep: 'kept' | 'not-kept' | null
  /** The judge's card, once its review has picked one of the attempts. */
  pick: RunPick | null
  /** A card's own words for what it did: its completion note, else the first paragraph of its handoff, else a person's step's words. */
  summary: string | null
  /** The change the card's checkout recorded, when it recorded one that is whole, current and its own. */
  change: RunChange | null
}
export interface RunTimelineInput {
  execution: FlowExecution
  cards: readonly Intent[]
  /** Live conversations qualify a retained claim after the Run ends. */
  sessions?: ReadonlyMap<SessionKey, Session> | undefined
  signals?: readonly TeamSignal[]
  evidence?: BoardEvidence | null
  findings?: readonly FindingView[]
  origin?: string | null
  findingRun?: FindingRunView | null
  publicationOn?: boolean
  /** What the desk recorded each time a check card ran, by card: a check with more than one result draws each under it. */
  attempts?: ReadonlyMap<number, readonly FlowCheckAttempt[]>
  /** Cards whose readable evidence may omit earlier check results. */
  incompleteAttempts?: ReadonlySet<number>
}
const row = (id: string, kind: RunTimelineRow['kind'], title: string, rest: Partial<RunTimelineRow> = {}): RunTimelineRow => ({
  id, kind, title, detail: null, round: null, card: null, seat: null, status: null,
  attention: false, publication: null, durationMs: null, since: null, working: false, complete: null, retryRefusal: null,
  asked: null, answered: null, blind: false, attempt: null, on: null, keep: null, pick: null, summary: null, change: null, ...rest,
})
const STANDARD_OUTCOMES = ['pass', 'fail', 'passed', 'failed']
/**
 * One result of a check in the words its row uses: the Flow's own word when the
 * Flow named one of its own (`no-pr`), and otherwise how the command ended.
 */
export const attemptWords = (attempt: Pick<FlowCheckAttempt, 'exit' | 'timedOut' | 'outcome'>): string =>
  !STANDARD_OUTCOMES.includes(attempt.outcome) ? wordOf(attempt.outcome)
    : attempt.timedOut ? 'Timed out' : attempt.exit === 0 ? 'Passed' : attempt.exit === null ? 'Did not finish' : 'Failed'
const terminal = (card: Intent): boolean => card.state === 'done' || card.state === 'abandoned'
/** The current ending qualifies retained work; the first departure never does. */
export const currentRunEnd = (execution: Pick<FlowExecution, 'state' | 'currentEndedAt'>): number | null =>
  execution.state !== 'running' ? execution.currentEndedAt ?? null : null

/** Shared by the Timeline and Flow: an ended claim may still have its original turn live. */
export const runCardTiming = (execution: Pick<FlowExecution, 'state' | 'currentEndedAt'>, card: Intent,
  inFlight: boolean, since: number | null, sessions?: ReadonlyMap<SessionKey, Session>) => {
  const endedAt = currentRunEnd(execution)
  const working = execution.state === 'running' && inFlight
  const stoppedWork = execution.state !== 'running' && !terminal(card) && (card.state === 'claimed' || inFlight)
  const until = terminal(card) ? Math.min(card.updatedAt, endedAt ?? Infinity) : stoppedWork ? endedAt : null
  const session = stoppedWork && card.claim ? sessions?.get(sessionKey(card.claim.runtime, card.claim.sessionId)) : undefined
  const turn = session ? currentTurn(session) : undefined
  // A later follow-up in the same conversation is not this Run's turn.
  const live = session && isBusy(session) && endedAt !== null && (turn?.startedAt == null || turn.startedAt <= endedAt)
  return { working, stoppedWork, status: stoppedWork ? live ? 'Stopping' as const : 'Stopped' as const : null,
    since, until, durationMs: since !== null && until !== null ? Math.max(0, until - since) : null }
}
const claimAt = (card: Intent, signals: readonly TeamSignal[]): number | null => card.claim?.at
  ?? [...signals].filter(one => one.intent === card.id && one.signal === 'claimed' && one.at <= card.updatedAt).sort((a, b) => b.at - a.at)[0]?.at ?? null
const endTitle = (execution: FlowExecution, publicationNeedsYou: boolean): string => {
  switch (execution.end?.kind) {
    case 'unrouted': return 'Ended without a next step'
    case 'budget': return execution.end.which === 'rounds' ? 'Round budget reached' : 'Rounds without progress reached'
    case 'complete': return publicationNeedsYou ? 'Needs you' : 'Settled'
    case 'stopped': return execution.end.by === 'person' ? 'Stopped by you' : 'Stopped by the desk'
    default: return execution.state === 'stalled' || publicationNeedsYou ? 'Needs you' : execution.state === 'stopped' ? 'Stopped' : 'Settled'
  }
}
type DeclaredRole = FlowExecution['document']['flow']['roles'][number]
/** Competitors work apart, each in a checkout of its own: that is what makes several cards of one role attempts. */
const isolates = (role: DeclaredRole | undefined): boolean => role?.kind === 'agent' && 'isolate' in role && role.isolate === true
/** "Attempt A", "Attempt B": the order a round opened its competitors in. */
const attemptLabel = (index: number): string => `Attempt ${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[index] ?? index + 1}`
/** A fact that still speaks for its revision: not one a backup brought, and not one the branch has since rewritten or never held. */
const speaks = (view: EvidenceView): boolean => !view.record.restored && ['fresh', 'behind', 'final'].includes(view.freshness.state)
const newest = (a: EvidenceView, b: EvidenceView): number => b.record.observedAt - a.record.observedAt
const factsOf = (evidence: BoardEvidence | null | undefined, card: number): readonly EvidenceView[] =>
  evidence?.cards.find(one => one.card === card)?.facts ?? []
/** The change a card left: its newest recorded diff, when that diff is of committed work and still speaks. */
const changeOf = (facts: readonly EvidenceView[]): RunChange | null => {
  const found = facts.filter(one => one.record.fact.kind === 'diff' && one.record.fact.dirty !== true && speaks(one)).sort(newest)[0]
  const fact = found?.record.fact
  return found && fact?.kind === 'diff'
    ? { revision: fact.to, from: fact.from, added: fact.added, removed: fact.removed, files: fact.files,
      cwd: found.record.checkout?.cwd ?? null, branch: found.record.checkout?.branch ?? null } : null
}
const firstParagraph = (text: string | null | undefined): string | null =>
  text?.split(/\n\s*\n/).map(one => one.trim()).find(Boolean) ?? null
/**
 * A card's detail as the step it asks of a person. The host appends tool
 * instructions after the rendered sentence; remove only those complete trailing
 * paragraphs, keeping authored text. The host joins paragraphs with a blank
 * line, but a sentence written as a YAML `|` block ends in a newline of its own,
 * so more than one blank line can come before them. The breaks are kept as they
 * were written.
 */
export const stepWords = (detail: string | null | undefined): string | null => {
  const parts = detail?.trim().split(/(\n{2,})/) ?? [] // paragraph, break, paragraph, ...
  const completion = /^Finish this with complete_claim and an outcome of exactly one of: [^\n]+\.$/
  const split = /^Finish this with complete_claim's split as well: the agreed split of files for the "[^"\n]+" round, one list of path patterns for each of its \d+ cards?, in card order, no two overlapping\. Each of those cards will own only its own list\.$/
  while (parts.length && (completion.test(parts.at(-1)!) || split.test(parts.at(-1)!))) parts.splice(-2) // the paragraph and the break before it
  return parts.join('') || null
}
/** The rounds a Flow opens after a step when exactly one rule follows it, and so on while exactly one does; none past a fork or a loop. */
const rulesAfter = (execution: FlowExecution, role: string): readonly { role: string; title: string | null }[] => {
  if (execution.document.format !== 'agents') return []
  const out: { role: string; title: string | null }[] = []
  const seen = new Set([role])
  for (let at = role;;) {
    const next = execution.document.flow.rules.filter(rule => rule.on === at)
    if (next.length !== 1 || seen.has(next[0]!.then.role)) return out
    at = next[0]!.then.role
    seen.add(at)
    // A title with a placeholder in it is the engine's template, not words to show before it has filled it.
    out.push({ role: at, title: next[0]!.then.title.includes('{{') ? null : next[0]!.then.title })
  }
}
/** The committed change a Flow's person reads, if its Flow says one does: a rule that waits on a diff and hands on to a person. */
const answeringRole = (execution: FlowExecution): string | null => {
  if (execution.document.format !== 'agents') return null
  const { rules, roles } = execution.document.flow
  return rules.find(rule => rule.when?.evidence?.some(guard => 'diff' in guard) && roles.find(one => one.id === rule.then.role)?.kind === 'person')?.on ?? null
}
export function runTimeline(input: RunTimelineInput): { header: RunHeader; rows: RunTimelineRow[] } {
  const execution = input.execution
  const endedAt = currentRunEnd(execution)
  const findingRun = input.findingRun?.run === execution.id && input.findingRun.goal === execution.goal ? input.findingRun : null
  const publication = runPublication(findingRun, input.publicationOn !== false)
  const needsYou = runNeedsAttention(execution, publication?.needsYou === true)
  const header: RunHeader = { run: execution.id, flow: execution.document.flow.name, state: execution.state, needsYou, publication,
    revision: execution.revision ?? null, continues: execution.continues ?? null, end: execution.end,
    interruptedCheck: execution.state === 'stalled' ? execution.operations.find(one => one.kind === 'check' && one.state === 'uncertain')?.card ?? null : null,
    answer: null }
  const rows: RunTimelineRow[] = [row('start', 'start', 'Start', { detail: input.origin ?? null, since: execution.startedAt ?? null })]
  if (execution.brief) rows.push(row('brief', 'brief', 'Brief', { detail: execution.brief }))
  const sorted = [...execution.rounds].sort((a, b) => a.n - b.n)
  const roleOf = (id: string): DeclaredRole | undefined => execution.document.flow.roles.find(one => one.id === id)
  // Rounds of isolated competitors, by round: each card an attempt, with where its work stood when it finished.
  const competing = new Map<number, (RunAttempt & { cwd: string | null })[]>()
  for (const round of sorted) {
    if (round.cards.length < 2 || !isolates(roleOf(round.role))) continue
    competing.set(round.n, round.cards.map((id, index) => {
      const change = changeOf(factsOf(input.evidence, id))
      return { card: id, label: attemptLabel(index), revision: change?.revision ?? null, cwd: change?.cwd ?? null, keep: null }
    }))
  }
  const attemptsBefore = (n: number) => [...competing].filter(([at]) => at < n).sort((a, b) => b[0] - a[0])[0]?.[1] ?? []
  // A judge's recorded review of one of them: which revision it kept, among which attempts.
  const picks = new Map<number, RunPick>()
  const kept = new Map<number, 'kept' | 'not-kept'>()
  for (const round of sorted) for (const id of round.cards) {
    const attempts = attemptsBefore(round.n)
    const reviewView = factsOf(input.evidence, id).filter(one => one.record.fact.kind === 'review' && one.record.fact.verdict === 'picked' && !one.record.restored).sort(newest)[0]
    const review = reviewView?.record.fact
    if (!attempts.length || review?.kind !== 'review') continue
    const matching = attempts.filter(one => one.revision === review.at && (!reviewView?.record.checkout?.cwd || one.cwd === reviewView.record.checkout.cwd))
    const chosen = matching.length === 1 ? matching[0]!.card : null
    const decided = attempts.map(({ cwd: _cwd, ...one }): RunAttempt => ({ ...one, keep: chosen === null || one.revision === null ? null : one.card === chosen ? 'kept' : 'not-kept' }))
    picks.set(id, { revision: review.at, attempts: decided })
    for (const one of decided) if (one.keep) kept.set(one.card, one.keep)
  }
  for (const round of sorted) {
    const cards = round.cards.map(id => input.cards.find(one => one.id === id))
    const finished = cards.filter(one => one && terminal(one)).length
    const starts = cards.flatMap(one => { const at = one ? claimAt(one, input.signals ?? []) : null; return at === null ? [] : [at] })
    const since = starts.length === cards.length && starts.length ? Math.min(...starts) : null
    const durationMs = round.state === 'closed' && since !== null && cards.every(Boolean)
      ? Math.max(0, Math.min(Math.max(...cards.map(one => one!.updatedAt)), endedAt ?? Infinity) - since) : null
    rows.push(row(`round-${round.n}`, 'round', `Round ${round.n} · ${round.role}`, {
      round: round.n, detail: `${finished} of ${round.cards.length} answered`, complete: finished === round.cards.length, durationMs, since,
      working: execution.state === 'running' && round.state === 'running', asked: round.cards.length, answered: finished,
      blind: round.cards.length > 1 && round.blind === true && round.state !== 'closed' && (execution.state === 'running' || execution.state === 'stalled'),
    }))
    const roundFindings = (input.findings ?? []).filter(one => one.origin.run === execution.id && one.origin.round === round.n)
    const recorded = findingRun?.rounds.find(one => one.round === round.n)
    const roundPublication = recorded ? reviewPublication({ state: recorded.state,
      pr: recorded.state === 'local' ? findingRun?.boundPr?.pr ?? null : recorded.pr,
      postingOn: input.publicationOn !== false, hasFindings: recorded.state !== 'none' }) : null
    const role = roleOf(round.role)
    round.cards.forEach((id, index) => {
      const card = cards[index]
      if (!card) { rows.push(row(`card-${round.n}-${id}`, 'card', `#${id} · Card unavailable`, { round: round.n, card: id })); return }
      const since = claimAt(card, input.signals ?? [])
      const operation = [...execution.operations].reverse().find(one => one.kind === 'check' && one.card === id)
      const uncertain = role?.kind === 'check' && operation?.state === 'uncertain'
      const inFlight = role?.kind === 'check' ? operation?.state === 'started' : card.state === 'claimed'
      const timing = runCardTiming(execution, card, inFlight, since, input.sessions)
      const { working, stoppedWork, durationMs } = timing
      const outcome = card.outcome == null ? null : wordOf(card.outcome)
      let status: string = outcome ?? (working ? 'Working' : card.state === 'done' ? 'Done' : card.state === 'abandoned' ? 'Abandoned' : card.state === 'blocked' ? 'Blocked' : 'Waiting')
      let title = `#${id} · ${card.title}`
      let kind: RunTimelineRow['kind'] = 'card'
      const personWaiting = role?.kind === 'person' && (execution.state === 'running' || execution.state === 'stalled') && round.state !== 'closed'
        && (card.state === 'open' || card.state === 'claimed' || (card.blockedBy === 'hand' && Boolean(card.blockedReason?.trim())))
      if (role?.kind === 'person') { kind = 'person'; if (personWaiting) status = 'Needs you' }
      let retryRefusal: string | null = null
      if (role?.kind === 'check') {
        kind = 'check'
        title = role.check?.run ?? card.title
        retryRefusal = checkRetryRefusal(execution.state, operation?.state ?? null)
        const result = input.evidence?.cards.find(one => one.card === id)?.facts
          .map(one => one.record).filter(one => one.round === round.n && one.fact.kind === 'check' && one.fact.name === round.role && one.fact.run === title)
          .sort((a, b) => b.observedAt - a.observedAt)[0]?.fact
        status = uncertain ? 'Needs you' : working ? 'Working' : result?.kind === 'check'
          ? attemptWords({ exit: result.exit, timedOut: result.timedOut, outcome: card.outcome ?? 'pass' }) : outcome ?? 'Result unavailable'
      }
      if (timing.status) status = timing.status
      const attention = (!stoppedWork && (uncertain || personWaiting)) || (execution.end?.kind === 'unrouted' && execution.end.card === id)
      // The attempt a check ran on: by its revision or checkout, qualifying shared revisions by checkout; else by card order before a result.
      const subject = (): string | null => {
        const attempts = attemptsBefore(round.n)
        if (!attempts.length || !card.dependsOn.some(dep => attempts.some(one => one.card === dep))) return null
        const result = factsOf(input.evidence, id).filter(one => one.record.fact.kind === 'check' && !one.record.restored).sort(newest)[0]
        if (!result) return round.cards.length === attempts.length ? attempts[index]!.label : null
        const at = result.record.fact.kind === 'check' ? result.record.fact.at : null
        const cwd = result.record.checkout?.cwd ?? null
        const hit = attempts.filter(one => one.revision === at || (cwd !== null && one.cwd === cwd))
        const qualified = hit.length > 1 && cwd !== null ? hit.filter(one => one.cwd === cwd) : hit
        return qualified.length === 1 ? qualified[0]!.label : null
      }
      rows.push(row(`${kind}-${round.n}-${id}`, kind, title, { round: round.n, card: id,
        seat: [...execution.operations].reverse().find(one => one.kind === 'seat' && one.card === id && one.seat !== null)?.seat ?? null,
        status, attention, durationMs, since, working, publication: recorded?.cards.includes(id) ? roundPublication : null, retryRefusal,
        attempt: kind === 'card' ? competing.get(round.n)?.find(one => one.card === id)?.label ?? null : null,
        on: kind === 'check' ? subject() : null, keep: kept.get(id) ?? null, pick: picks.get(id) ?? null,
        summary: kind === 'check' ? null : kind === 'person' ? stepWords(card.detail) ?? card.title : firstParagraph(card.note) ?? firstParagraph(card.handoff),
        change: kind === 'card' ? changeOf(factsOf(input.evidence, id)) : null }))
      // The check row says the latest result; once it has run more than once, each result is drawn under it.
      const results = kind === 'check' ? input.attempts?.get(id) ?? [] : []
      // A skipped evidence line may hide an earlier result. Show those results
      // in the inspector without claiming the readable subset's ordinals.
      if (results.length > 1 && !input.incompleteAttempts?.has(id) && results.every(one => one.n !== null)) for (const one of results) rows.push(row(`attempt-${round.n}-${id}-${one.n}`, 'attempt', `Attempt ${one.n}`, { round: round.n, card: id, status: attemptWords(one), since: one.at }))
    })
    const findings = roundFindings
    if (findings.length) rows.push(row(`findings-${round.n}`, 'findings', `${findings.length} ${findings.length === 1 ? 'finding' : 'findings'}`, {
      round: round.n, publication: roundPublication, detail: findings.map(one => `${one.title} · ${lifecycleWords(one)}${one.inactiveReason ? ' · Not kept' : ''}${one.problem ? ` · ${one.problem}` : ''}`).join('\n'),
    }))
  }
  // The rounds that wait on a person's answer, drawn ahead of it and not yet reached.
  const latest = sorted.at(-1)
  if (latest && roleOf(latest.role)?.kind === 'person' && latest.state !== 'closed' && (execution.state === 'running' || execution.state === 'stalled')
    && rows.some(one => one.kind === 'person' && one.round === latest.n && one.attention)) {
    rulesAfter(execution, latest.role).forEach((next, index) => rows.push(row(`ahead-${latest.n + 1 + index}`, 'ahead',
      `Round ${latest.n + 1 + index} · ${next.role}`, { detail: next.title, status: 'Not reached' })))
  }
  // A Run that makes no pull request says what it made, when its Flow has a person read the committed change.
  const answering = answeringRole(execution)
  const mine = new Set(sorted.flatMap(one => one.cards))
  const pullRequested = (input.evidence?.cards ?? []).some(one => mine.has(one.card) && one.facts.some(view => view.record.fact.kind === 'pr' && !view.record.restored))
  const committed = answering === null || pullRequested ? undefined
    : sorted.filter(one => one.role === answering).flatMap(one => one.cards).flatMap(id => changeOf(factsOf(input.evidence, id)) ?? []).at(-1)
  if (committed) header.answer = { revision: committed.revision }
  if (execution.state !== 'running') {
    const end = execution.end
    const publicationReason = findingRun?.reason?.trim() || (publication ? `${publication.label} still needs your attention.` : null)
    const detail = end?.kind === 'complete' ? publication?.needsYou ? publicationReason : 'Nothing waits.'
      : end?.kind === 'budget' ? `${execution.reason ?? ''}${execution.reason ? '\n' : ''}${end.used} round${end.used === 1 ? '' : 's'} ${end.which === 'rounds' ? 'used' : 'without progress'}.`
        : execution.reason ?? (end?.kind === 'unrouted' ? `Card #${end.card} answered ${wordOf(end.outcome)}; no rule follows it.` : publication?.needsYou ? findingRun?.reason ?? null : null)
    rows.push(row('end', 'end', endTitle(execution, publication?.needsYou === true), { detail, publication, attention: needsYou, since: endedAt }))
  }
  return { header, rows }
}
