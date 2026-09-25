import {
  checkPassed,
  ciVerdict,
  type EvidenceRecord,
  type EvidenceView,
  type FlowEvidenceGuard,
  type FlowRoundState,
  type ReviewCandidate,
  type ReviewInput,
  type SeatId,
} from '@harnessdesk/protocol'

import { mintId } from './evidence/records.js'
import type { TeamCallScope } from './team.js'

/**
 * Evidence guards: what a finished round's rule may read to decide whether to
 * move on, and the one narrow way a judgment becomes evidence.
 *
 * Every function here reads what the desk already observed — the evidence
 * store's append-only facts, each bound to the revision it was true at — and
 * never a message or a card's own `outcome`. A guard that cannot yet tell
 * waits; one with a fresh contradicting fact says so, so an explicit failure
 * route can fire; nothing here invents a revision or promotes a claim into a
 * fact.
 */

// -------------------------------------------------------------- the subject

/*
 * How a fact comes to speak for a finished round — the one invariant every
 * guard kind below obeys, and the one `FlowExecutions` builds its context to:
 *
 * 1. A guard judges subjects, never Seats. A subject is a revision: the head
 *    of a card that could change files (its binding's grant is above read)
 *    and does not judge (its Agent does not produce reviews), found by
 *    walking back from the finished round's own cards along `dependsOn` to
 *    the nearest such round — the finished round itself when it is one. A
 *    judge's or a reviewer's own checkout is never a subject, whatever its
 *    grant: a review is always of what the reviewer depends on. A
 *    writer whose checkout has no clean head right now is `unsettled`: it
 *    waits, and is never quietly left out.
 * 2. The facts that may speak for a subject are those filed on a card of that
 *    walk — the finished round's own cards (its checks, its reviews), every
 *    round between, and the subjects' own cards (what the desk observed about
 *    them: diff, pull request, CI, whose `round` is null). Card membership,
 *    not the round number a fact carries, is what scopes it to this run.
 * 3. A fact speaks for a subject only at the subject's own revision
 *    (`check.at`, `ci.at`, `review.at`, `pr.head`, `diff.to`), only while it
 *    is fresh, and only if this desk observed it (never a restored one).
 * 4. Each question — a check by its exact command, CI, a pull request by its
 *    number, the diff, a review by the Seat that wrote it — is decided by its
 *    last observation in append order: a later failure defeats an earlier
 *    pass, and a last observation that has gone stale waits.
 * 5. Every subject must pass every guard, unless the rule's review guards
 *    single out one subject every required reviewer chose; then that subject
 *    alone is judged by the rest. Required reviewers are the finished round's
 *    own Seats.
 *
 * Nothing here is woken by a message: a durable append to a Goal's facts is
 * what makes `FlowExecutions.wakeEvidence` read these again.
 */

/** One candidate this guard judges: a writer's card, the round it belongs to, and the observed revision to judge it at. */
export interface FlowSubject {
  readonly card: number
  readonly round: number
  readonly checkout: { readonly cwd: string; readonly branch: string | null }
  readonly at: string
}

/** What a finished round's rule sees: its subjects, the cards whose facts may speak for them, and those facts. */
export interface FlowEvidenceContext {
  readonly goal: string
  readonly finished: FlowRoundState
  readonly subjects: readonly FlowSubject[]
  /** Writers in the closure with no clean head right now, and why: each one waits rather than being dropped. */
  readonly unsettled: readonly { readonly card: number; readonly why: string }[]
  /** Every card of the dependency walk: the finished round's own, those between, and the subjects'. */
  readonly cards: readonly number[]
  /** The Seats whose reviews a `review` guard needs: the finished round's own. */
  readonly reviewers: readonly string[]
  readonly facts: readonly EvidenceView[]
  readonly outcomes: readonly (string | null)[]
}

export type FlowGuardResult =
  | { readonly state: 'matched'; readonly evidence: readonly string[]; readonly subjects: readonly FlowSubject[] }
  /** `reason`, when there is one, says which fact contradicted the guard — for a run that ends on it. */
  | { readonly state: 'no-match'; readonly reason?: string }
  | { readonly state: 'waiting'; readonly reason: string }

export const MISSING_EVIDENCE = 'The evidence this card needs is missing or ambiguous. Observe it again.'
export const AMBIGUOUS_REVIEWS = 'These reviews name different revisions. Ask for one revision before continuing.'
export const NO_SUBJECT = 'Nothing in this step’s history changed any files, so there is no revision to judge.'
const WAITING_CHECK = 'Waiting for a passing check at this revision.'
const WAITING_CI = 'Waiting for CI to go green at this revision.'
const WAITING_REVIEW = 'Waiting for a structured review at this revision.'
const WAITING_PR = 'Waiting for the pull request to reach that state.'
const WAITING_DIFF = 'Waiting for an observed diff at this revision.'

// ----------------------------------------------------------------- chooseFact

/** One observation of one logical question, in canonical append order — never sorted by wall clock or id. */
export interface FactChoice {
  readonly id: string
  /** The question it answers: `check`, `ci`, `diff`, `pr:<number>`, `review:<seat>`. */
  readonly question: string
  readonly at: string
  readonly fresh: boolean
  /** Null when it is not a verdict yet: CI still running, a pull request still open when another state is wanted. */
  readonly passed: boolean | null
}

/**
 * The last observation of one question at one revision, judged. `pass` and
 * `fail` only for a fresh last observation; anything else — none at all, a
 * last one gone stale, one that is not a verdict yet — is `missing`, which
 * waits and never falls through to a later rule.
 */
export function chooseFact(
  facts: readonly FactChoice[],
  scope: { readonly question: string; readonly at: string },
): { readonly state: 'pass' | 'fail'; readonly fact: FactChoice } | { readonly state: 'missing' } {
  const latest = facts.filter((fact) => fact.question === scope.question && fact.at === scope.at).at(-1)
  if (!latest || !latest.fresh || latest.passed === null) return { state: 'missing' }
  return { state: latest.passed ? 'pass' : 'fail', fact: latest }
}

// -------------------------------------------------------------- renderEvidence

const EVIDENCE_FIELD = /^(check\.(at|name|exit)|ci\.at|review\.(at|verdict|by)|pr\.(head|number)|diff\.(from|to))$/

/**
 * One-pass field substitution: `{{evidence.check.at}}` and the like, from a
 * flat map of already-resolved values. One level deep, no expressions, no
 * arrays, no computed access, no recursive substitution — a resolved value
 * that itself contains `{{` is inserted as literal bytes, never fed back
 * through this or any other pass.
 */
export function renderEvidence(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{\s*evidence\.([^{}]*?)\s*\}\}/g, (_whole, path: string) => evidenceField(path, values))
}

const evidenceField = (path: string, values: Readonly<Record<string, string>>): string => {
  if (!EVIDENCE_FIELD.test(path)) throw new Error('This evidence field is not supported. Use one kind and one field.')
  if (!Object.hasOwn(values, path)) throw new Error(MISSING_EVIDENCE)
  return values[path]!
}

/**
 * A v2 card's title or detail: its ordinary slots and its evidence fields, in
 * one pass over the template. Neither kind of value is ever read again as a
 * template, so an input or a fact that itself says `{{...}}` stays literal.
 * An unknown ordinary slot stays as written; an evidence field this rule has
 * no single value for refuses, so a merge card never names a guessed revision.
 */
export function renderCardTemplate(
  template: string,
  vars: Readonly<Record<string, string>>,
  evidence: Readonly<Record<string, string>>,
): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (whole, name: string) =>
    name.startsWith('evidence.') ? evidenceField(name.slice('evidence.'.length), evidence)
      : Object.hasOwn(vars, name) ? vars[name]! : whole)
}

/** Whether a template names any evidence field at all — the only case a card needs its round's facts read. */
export const namesEvidence = (template: string | null | undefined): boolean => /\{\{\s*evidence\./.test(template ?? '')

/**
 * The template values a set of facts supports: each field only when every
 * fact of its kind agrees on it. Two reviews naming two revisions give no
 * `review.at` at all rather than the first or the last of them.
 */
export function evidenceValues(records: readonly EvidenceRecord[]): Readonly<Record<string, string>> {
  const seen = new Map<string, Set<string>>()
  const put = (path: string, value: string | number | null): void => {
    if (value === null) return
    const set = seen.get(path) ?? new Set<string>()
    set.add(String(value))
    seen.set(path, set)
  }
  for (const { fact } of records) {
    if (fact.kind === 'check') { put('check.at', fact.at); put('check.name', fact.name); put('check.exit', fact.exit) }
    else if (fact.kind === 'ci') put('ci.at', fact.at)
    else if (fact.kind === 'review') { put('review.at', fact.at); put('review.verdict', fact.verdict); put('review.by', fact.by) }
    else if (fact.kind === 'pr') { put('pr.head', fact.head); put('pr.number', fact.number) }
    else if (fact.kind === 'diff') { put('diff.from', fact.from); put('diff.to', fact.to) }
  }
  const out: Record<string, string> = {}
  for (const [path, values] of seen) if (values.size === 1) out[path] = [...values][0]!
  return out
}

// ---------------------------------------------------------------- the guard

const waitingFor = (guard: FlowEvidenceGuard): string =>
  'check' in guard ? WAITING_CHECK : 'ci' in guard ? WAITING_CI : 'review' in guard ? WAITING_REVIEW : 'pr' in guard ? WAITING_PR : WAITING_DIFF

/** What a fresh, explicit contradiction of one guard at one subject was, in words. */
const failedFor = (guard: FlowEvidenceGuard, subject: FlowSubject): string =>
  'check' in guard ? `the check "${guard.check}" did not pass at card #${subject.card}'s revision`
    : 'ci' in guard ? `CI did not go green at card #${subject.card}'s revision`
      : 'pr' in guard ? `the pull request at card #${subject.card}'s revision is not ${guard.pr}`
          : `card #${subject.card}'s checkout has no committed change since its step began, so there is no diff`

/**
 * The facts this context lets speak (rule 2 and 3's scope: a card of the
 * walk, observed here), reduced to the questions this guard kind asks, in
 * append order. Freshness is carried, not filtered, so a stale last
 * observation still hides an older fresh one (rule 4).
 */
const choicesFor = (guard: FlowEvidenceGuard, context: FlowEvidenceContext): FactChoice[] => {
  const cards = new Set(context.cards)
  const out: FactChoice[] = []
  for (const view of context.facts) {
    const { record } = view
    if (record.restored || record.card?.board !== context.goal || !cards.has(record.card.id)) continue
    const fact = record.fact
    const fresh = view.freshness.state === 'fresh'
    const one = (question: string, at: string, passed: boolean | null): void => { out.push({ id: record.id, question, at, fresh, passed }) }
    if ('check' in guard && fact.kind === 'check' && fact.run === guard.check) {
      one('check', fact.at, checkPassed(fact) && fact.counted !== false)
    } else if ('ci' in guard && fact.kind === 'ci') {
      const verdict = ciVerdict(fact.checks)
      one('ci', fact.at, verdict === 'passed' ? true : verdict === 'running' ? null : false)
    } else if ('review' in guard && fact.kind === 'review') {
      one(`review:${fact.by}`, fact.at, fact.verdict === guard.review)
    } else if ('pr' in guard && fact.kind === 'pr') {
      const settledOther = fact.state !== guard.pr && fact.state !== 'open'
      one(`pr:${fact.number}`, fact.head, fact.state === guard.pr ? true : settledOther || guard.pr === 'open' ? false : null)
    } else if ('diff' in guard && fact.kind === 'diff') {
      one('diff', fact.to, fact.files > 0)
    }
  }
  return out
}

/**
 * One non-review guard at one subject: a pass on any of its questions passes
 * (a pull request is any of its numbers), a fail on every one of them fails,
 * and anything else waits.
 */
const judgeAt = (choices: readonly FactChoice[], subject: FlowSubject): { readonly state: 'pass' | 'fail' | 'missing'; readonly id?: string } => {
  const questions = [...new Set(choices.filter((one) => one.at === subject.at).map((one) => one.question))]
  const verdicts = questions.map((question) => chooseFact(choices, { question, at: subject.at }))
  const pass = verdicts.find((one) => one.state === 'pass')
  if (pass && pass.state === 'pass') return { state: 'pass', id: pass.fact.id }
  if (verdicts.length > 0 && verdicts.every((one) => one.state === 'fail')) return { state: 'fail' }
  return { state: 'missing' }
}

/** A non-review guard over every subject still standing (rule 5): all pass, or one fails, or it waits. */
const everySubject = (guard: FlowEvidenceGuard, context: FlowEvidenceContext, subjects: readonly FlowSubject[]): FlowGuardResult => {
  const choices = choicesFor(guard, context)
  const evidence: string[] = []
  let failed: FlowSubject | null = null
  let missing = false
  for (const subject of subjects) {
    const verdict = judgeAt(choices, subject)
    if (verdict.state === 'pass') evidence.push(verdict.id!)
    else if (verdict.state === 'fail') failed ??= subject
    else missing = true
  }
  if (failed) return { state: 'no-match', reason: failedFor(guard, failed) }
  if (missing) return { state: 'waiting', reason: waitingFor(guard) }
  return { state: 'matched', evidence, subjects }
}

/**
 * A review guard: which subject the required reviewers chose. Each
 * reviewer's last fresh review at a subject is its verdict there. More than
 * one subject chosen is ambiguous — never a partial match at each — and the
 * one chosen needs every required reviewer's pass at it: one reviewer's
 * explicit other verdict there is a no-match, one still to review waits.
 */
const reviewChoice = (answer: string, context: FlowEvidenceContext, subjects: readonly FlowSubject[]): FlowGuardResult => {
  const choices = choicesFor({ review: answer }, context)
  const required = context.reviewers.length > 0
    ? context.reviewers.map((seat) => `review:${seat}`)
    : [...new Set(choices.map((one) => one.question))]
  if (required.length === 0) return { state: 'waiting', reason: WAITING_REVIEW }
  const verdictsAt = (subject: FlowSubject) => required.map((question) => chooseFact(choices, { question, at: subject.at }))
  const chosen = subjects.filter((subject) => verdictsAt(subject).some((one) => one.state === 'pass'))
  if (chosen.length > 1) return { state: 'waiting', reason: AMBIGUOUS_REVIEWS }
  if (chosen.length === 0) {
    const refused = subjects.some((subject) => verdictsAt(subject).some((one) => one.state === 'fail'))
    return refused ? { state: 'no-match', reason: `no required reviewer answered ${answer}` } : { state: 'waiting', reason: WAITING_REVIEW }
  }
  const [subject] = chosen as [FlowSubject]
  const verdicts = verdictsAt(subject)
  if (verdicts.some((one) => one.state === 'fail')) return { state: 'no-match', reason: `not every required reviewer answered ${answer} at card #${subject.card}'s revision` }
  if (verdicts.some((one) => one.state === 'missing')) return { state: 'waiting', reason: WAITING_REVIEW }
  return { state: 'matched', evidence: verdicts.map((one) => (one.state === 'pass' ? one.fact.id : '')).filter(Boolean), subjects: [subject] }
}

/**
 * A rule's whole evidence list. Review guards are judged first, since they
 * may single out one subject; every other guard is then judged against the
 * subjects still standing. A writer with no clean head waits unless a review
 * already chose another subject. Empty guards match trivially.
 */
export function evidenceGuard(guards: readonly FlowEvidenceGuard[], context: FlowEvidenceContext): FlowGuardResult {
  if (guards.length === 0) return { state: 'matched', evidence: [], subjects: context.subjects }
  if (context.subjects.length === 0 && context.unsettled.length === 0) return { state: 'waiting', reason: NO_SUBJECT }
  let subjects = context.subjects
  const evidence = new Set<string>()
  const reviews = guards.filter((guard) => 'review' in guard)
  let narrowed = false
  for (const guard of reviews) {
    const result = reviewChoice(guard.review, context, subjects)
    if (result.state !== 'matched') return result
    subjects = result.subjects
    narrowed = true
    for (const id of result.evidence) evidence.add(id)
  }
  if (!narrowed && context.unsettled.length > 0) {
    const [first] = context.unsettled as [{ readonly card: number; readonly why: string }]
    return { state: 'waiting', reason: `Waiting for card #${first.card}: ${first.why}.` }
  }
  for (const guard of guards) {
    if ('review' in guard) continue
    const result = everySubject(guard, context, subjects)
    if (result.state !== 'matched') return result
    for (const id of result.evidence) evidence.add(id)
  }
  if (subjects.length === 0) return { state: 'waiting', reason: MISSING_EVIDENCE }
  return { state: 'matched', evidence: [...evidence], subjects }
}

// ------------------------------------------------------------ ready and findings

/**
 * What the findings ledger says about a run, for a ready rule: how many of
 * its admitted blocking findings are still unresolved, whether a regression
 * or security claim is waiting for a person, and whether the ledger could be
 * read whole. Missing evidence is never an empty blocking set.
 */
export interface FindingsGate {
  readonly blockers: number
  readonly pending: boolean
  readonly unreadable: boolean
}

export const WAITING_FINDINGS = (count: number): string =>
  `Waiting for ${count} open blocking finding${count === 1 ? '' : 's'} to be confirmed resolved.`
export const WAITING_EXCEPTION = 'Waiting for a person to review a new regression or security finding.'
export const WAITING_LEDGER = 'Some findings could not be read, so this cannot be ready. A person has to look.'

/**
 * A rule's evidence, with the findings ledger's say for a run that keeps one.
 * A ready rule — one with evidence guards — also needs zero unresolved
 * admitted blockers and no pending exception; with those clear, its guards
 * are judged exactly as before, so clearing findings never stands in for a
 * fresh check, CI or review. `findings` undefined is a run saved before the
 * ledger, judged as it always was.
 */
export function readyGuard(guards: readonly FlowEvidenceGuard[], context: FlowEvidenceContext, findings?: FindingsGate | null): FlowGuardResult {
  if (guards.length > 0 && findings !== undefined) {
    if (findings === null || findings.unreadable) return { state: 'waiting', reason: WAITING_LEDGER }
    if (findings.pending) return { state: 'waiting', reason: WAITING_EXCEPTION }
    if (findings.blockers > 0) return { state: 'waiting', reason: WAITING_FINDINGS(findings.blockers) }
  }
  return evidenceGuard(guards, context)
}

// ------------------------------------------------------------------- review

/**
 * What a `record_review` call binds to: the caller's own kept Seat, holding
 * this exact card now, and the round/candidates it may judge. Resolved fresh
 * on every call — the host's own gateway scope, never a caller-supplied id.
 */
export interface ReviewBinding {
  readonly goal: string
  readonly seat: SeatId
  /** The Agent's declared answers; a verdict outside this list is refused. */
  readonly answers: readonly string[]
  readonly round: number
  readonly subjects: readonly FlowSubject[]
  /** Predecessor writers with no clean head right now: still owed a review, but not one that can be recorded yet. */
  readonly unsettled?: readonly { readonly card: number; readonly why: string }[]
}

/** What appending one review record found already durable: a fresh write, an identical repeat, or a genuine conflict. */
export type ReviewAppendOutcome =
  | { readonly outcome: 'added' | 'duplicate'; readonly record: EvidenceRecord }
  | { readonly outcome: 'conflict' }

/** What `flow-evidence.ts` asks of the host to resolve a review call. Server-only. */
export interface ReviewSubjectPort {
  /** Null when this scope holds no live claim a review may be recorded against. */
  bindingFor(intent: number, scope: TeamCallScope): Promise<ReviewBinding | null>
  /** This Goal's raw facts, each already carrying its computed freshness. */
  facts(goal: string): Promise<readonly EvidenceView[]>
  /**
   * Appends through the store's own compare-and-swap merge, so two callers
   * racing the same verdict can never both write, and a caller naming a
   * different one for the same `(round,card,seat,at)` is told so rather than
   * silently dropped or silently overwritten.
   */
  append(goal: string, record: EvidenceRecord): Promise<ReviewAppendOutcome>
  now(): number
}

const CANDIDATE_TTL_MS = 10 * 60_000

interface HeldCandidate {
  readonly candidate: ReviewCandidate
  readonly checkout: FlowSubject['checkout']
  readonly goal: string
  readonly card: number
  readonly round: number
  readonly seat: SeatId
  readonly expires: number
}

/** Server-only: the plugin bridge's two hooks land here, never in protocol. */
export interface FlowReviewPort {
  candidates(intent: number, scope: TeamCallScope): Promise<readonly ReviewCandidate[]>
  record(input: ReviewInput, scope: TeamCallScope): Promise<EvidenceRecord>
}

/**
 * Structured review, admitted only through the caller's own claimed card and
 * an observed candidate this process minted. Candidate ids are opaque and
 * bound to the frozen subject snapshot they were read from — never an
 * arbitrary Git revision a caller could name directly.
 *
 * Publishing and forge posting are absent by design: these records stay
 * local, judged by a claim and a candidate this process itself minted, never
 * by parsing what an agent said. The findings ledger (`findings/plane.ts`)
 * raises and decides against the same held candidates (`held`).
 */
export class FlowReview implements FlowReviewPort {
  readonly #port: ReviewSubjectPort
  readonly #candidates = new Map<string, HeldCandidate>()

  constructor(port: ReviewSubjectPort) {
    this.#port = port
  }

  #sweep(): void {
    const now = this.#port.now()
    for (const [id, held] of this.#candidates) if (held.expires < now) this.#candidates.delete(id)
  }

  /**
   * Whether this caller's own Seat has already recorded a review on this
   * card, any verdict — the gate `complete_claim` checks for a role that
   * declares `produces: review`. Read from durable facts, never the
   * in-memory candidate map, so it survives a restart exactly as `record`
   * does.
   */
  async recorded(intent: number, scope: TeamCallScope): Promise<boolean> {
    const bound = await this.#port.bindingFor(intent, scope)
    if (!bound) return false
    const facts = await this.#port.facts(bound.goal)
    return facts.some(
      (view) =>
        view.record.fact.kind === 'review' &&
        view.record.fact.by === bound.seat &&
        view.record.card?.id === intent &&
        view.record.round === bound.round &&
        !view.record.restored,
    )
  }

  /**
   * Whether this caller still owes a review before `complete_claim` may
   * finish its card: it holds the card, the card has predecessor work to
   * judge — a revision, or a writer whose checkout is not yet clean — and
   * its own Seat has recorded nothing on it. A step with nothing before it
   * to judge (a seed that proposes, say) owes none: there is no candidate a
   * review could name.
   */
  async owed(intent: number, scope: TeamCallScope): Promise<boolean> {
    const bound = await this.#port.bindingFor(intent, scope)
    if (!bound) return true
    if (bound.subjects.length === 0 && (bound.unsettled?.length ?? 0) === 0) return false
    return !(await this.recorded(intent, scope))
  }

  async candidates(intent: number, scope: TeamCallScope): Promise<readonly ReviewCandidate[]> {
    this.#sweep()
    const bound = await this.#port.bindingFor(intent, scope)
    if (!bound) return []
    const facts = await this.#port.facts(bound.goal)
    const out: ReviewCandidate[] = []
    for (const subject of bound.subjects) {
      const evidence = facts
        .filter((view) => view.record.card?.id === subject.card && view.freshness.state === 'fresh' && !view.record.restored)
        .map((view) => view.record.id)
      const id = mintId()
      const candidate: ReviewCandidate = { id, card: subject.card, at: subject.at, branch: subject.checkout.branch, evidence }
      this.#candidates.set(id, {
        candidate, checkout: subject.checkout, goal: bound.goal, card: intent, round: bound.round, seat: bound.seat,
        expires: this.#port.now() + CANDIDATE_TTL_MS,
      })
      out.push(candidate)
    }
    return out
  }

  /**
   * A candidate this process minted for this caller's own card, still
   * offered, and still one of the card's current subjects — read again now,
   * so a head that moved since it was offered is no longer this candidate.
   * Null otherwise. The findings ledger raises and decides against exactly
   * what `record` would: never a revision a caller names.
   */
  async held(candidate: string, intent: number, scope: TeamCallScope): Promise<{
    readonly candidate: ReviewCandidate
    readonly checkout: FlowSubject['checkout']
    readonly goal: string
    readonly round: number
    readonly seat: SeatId
  } | null> {
    this.#sweep()
    const bound = await this.#port.bindingFor(intent, scope)
    if (!bound) return null
    const held = this.#candidates.get(candidate)
    if (!held || held.goal !== bound.goal || held.card !== intent || held.seat !== bound.seat) return null
    if (!bound.subjects.some((one) => one.card === held.candidate.card && one.at === held.candidate.at)) return null
    return { candidate: held.candidate, checkout: held.checkout, goal: held.goal, round: held.round, seat: held.seat }
  }

  /**
   * Records one verdict, idempotent through what is already durable rather
   * than a process-local cache: a retry after a restart finds the same
   * matching record instead of writing a second one, exactly as a Goal
   * operation's own journal makes a repeated step a no-op.
   */
  async record(input: ReviewInput, scope: TeamCallScope): Promise<EvidenceRecord> {
    this.#sweep()
    const bound = await this.#port.bindingFor(input.intent, scope)
    if (!bound) throw new Error('You do not hold this card, so no review can be recorded against it.')
    if (!bound.answers.includes(input.verdict)) {
      throw new Error(`"${input.verdict}" is not an answer this step accepts. It accepts ${bound.answers.join(', ')}.`)
    }
    const held = this.#candidates.get(input.candidate)
    if (!held || held.goal !== bound.goal || held.card !== input.intent || held.seat !== bound.seat) {
      throw new Error('That candidate is no longer being offered. Ask for review candidates again.')
    }
    if (!bound.subjects.some((one) => one.card === held.candidate.card && one.at === held.candidate.at)) {
      throw new Error('That candidate has moved on. Ask for review candidates again.')
    }
    const record: EvidenceRecord = {
      id: mintId(),
      fact: {
        kind: 'review', verdict: input.verdict, by: bound.seat, at: held.candidate.at,
        ...(input.against?.length ? { against: input.against } : {}),
      },
      card: { board: bound.goal, id: input.intent },
      checkout: { cwd: held.checkout.cwd, branch: held.checkout.branch },
      seat: bound.seat,
      round: held.round,
      observedAt: this.#port.now(),
      posted: null,
    }
    const outcome = await this.#port.append(bound.goal, record)
    if (outcome.outcome === 'conflict') {
      throw new Error('A different verdict is already recorded for this card. Reopen it in a new round to change it.')
    }
    return outcome.record
  }
}
