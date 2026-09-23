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

/** One candidate this guard judges: a card, the round it belongs to, and the observed revision to judge it at. */
export interface FlowSubject {
  readonly card: number
  readonly round: number
  readonly checkout: { readonly cwd: string; readonly branch: string | null }
  readonly at: string
}

/** What a finished round's rule sees: its own cards' subjects, and the facts that might satisfy a guard about them. */
export interface FlowEvidenceContext {
  readonly goal: string
  readonly finished: FlowRoundState
  readonly subjects: readonly FlowSubject[]
  readonly facts: readonly EvidenceView[]
  readonly outcomes: readonly (string | null)[]
}

export type FlowGuardResult =
  | { readonly state: 'matched'; readonly evidence: readonly string[]; readonly subjects: readonly FlowSubject[] }
  | { readonly state: 'no-match' }
  | { readonly state: 'waiting'; readonly reason: string }

export const MISSING_EVIDENCE = 'The evidence this card needs is missing or ambiguous. Observe it again.'
export const AMBIGUOUS_REVIEWS = 'These reviews name different revisions. Ask for one revision before continuing.'
const WAITING_CHECK = 'Waiting for a passing check at this revision.'
const WAITING_CI = 'Waiting for CI to go green at this revision.'
const WAITING_REVIEW = 'Waiting for a structured review at this revision.'
const WAITING_PR = 'Waiting for the pull request to reach that state.'
const WAITING_DIFF = 'Waiting for an observed diff at this revision.'

// ----------------------------------------------------------------- chooseFact

/** One logical question's observations, in canonical append order — never sorted by wall clock or id. */
export interface FactChoice {
  id: string
  kind: string
  at: string
  fresh: boolean
  restored: boolean
  card: number
  round: number
  observedAt: number
  passed: boolean
}

/**
 * The last observation of one logical question, judged. Null means unusable —
 * missing, stale, restored or itself a failure — so the caller can tell "no
 * observation yet" from "an explicit negative fact" by looking at `facts`
 * again with the freshness check dropped, which is exactly the mutation this
 * function is built to fail under.
 */
export function chooseFact(
  facts: readonly FactChoice[],
  scope: { readonly cards: readonly number[]; readonly round: number; readonly kind: string; readonly at: string },
): FactChoice | null {
  const matching = facts.filter(
    (fact) => scope.cards.includes(fact.card) && fact.round === scope.round && fact.kind === scope.kind && fact.at === scope.at,
  )
  const latest = matching.at(-1)
  if (!latest || !latest.fresh || latest.restored || !latest.passed) return null
  return latest
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
  return template.replace(/\{\{\s*evidence\.([^{}]*?)\s*\}\}/g, (_whole, path: string) => {
    if (!EVIDENCE_FIELD.test(path)) {
      throw new Error('This evidence field is not supported. Use one kind and one field.')
    }
    if (!Object.hasOwn(values, path)) {
      throw new Error(MISSING_EVIDENCE)
    }
    return values[path]!
  })
}

// ---------------------------------------------------------------- the guard

/** A guard's own scope key: `check:<run text>`, `ci`, `review:<answer>`, `pr:<state>`, `diff`. */
const kindOf = (guard: FlowEvidenceGuard): string =>
  'check' in guard ? `check:${guard.check}`
    : 'ci' in guard ? 'ci'
      : 'review' in guard ? `review:${guard.review}`
        : 'pr' in guard ? `pr:${guard.pr}`
          : 'diff'

const waitingFor = (guard: FlowEvidenceGuard): string =>
  'check' in guard ? WAITING_CHECK : 'ci' in guard ? WAITING_CI : 'review' in guard ? WAITING_REVIEW : 'pr' in guard ? WAITING_PR : WAITING_DIFF

/** `EvidenceView[]` reduced to the questions this guard kind can answer, in append order. */
const choicesFor = (guard: FlowEvidenceGuard, facts: readonly EvidenceView[]): FactChoice[] => {
  const kind = kindOf(guard)
  const out: FactChoice[] = []
  for (const view of facts) {
    const fact = view.record.fact
    const card = view.record.card?.id
    const round = view.record.round
    if (card === undefined || round == null) continue
    const fresh = view.freshness.state === 'fresh'
    const restored = Boolean(view.record.restored)
    const observedAt = view.record.observedAt
    if ('check' in guard && fact.kind === 'check' && fact.run === guard.check) {
      out.push({ id: view.record.id, kind, at: fact.at, fresh, restored, card, round, observedAt, passed: checkPassed(fact) })
    } else if ('ci' in guard && fact.kind === 'ci') {
      out.push({ id: view.record.id, kind, at: fact.at, fresh, restored, card, round, observedAt, passed: ciVerdict(fact.checks) === 'passed' })
    } else if ('review' in guard && fact.kind === 'review') {
      out.push({ id: view.record.id, kind, at: fact.at, fresh, restored, card, round, observedAt, passed: fact.verdict === guard.review })
    } else if ('pr' in guard && fact.kind === 'pr' && fact.state === guard.pr) {
      out.push({ id: view.record.id, kind, at: fact.head, fresh, restored, card, round, observedAt, passed: true })
    } else if ('diff' in guard && fact.kind === 'diff') {
      out.push({ id: view.record.id, kind, at: fact.to, fresh, restored, card, round, observedAt, passed: true })
    }
  }
  return out
}

/** Whether any fresh, kept fact of this guard's kind exists for the exact subject, whatever it decided. */
const observedAt = (choices: readonly FactChoice[], round: number, kind: string, subject: FlowSubject): boolean =>
  choices.some((one) => one.card === subject.card && one.round === round && one.kind === kind && one.at === subject.at && one.fresh && !one.restored)

/**
 * One guard, over the current candidate subjects: every subject must match,
 * except a `review` guard, which may instead pick out exactly one candidate
 * by the revision its reviewers named (`review.at` narrowing).
 */
const evaluateGuard = (guard: FlowEvidenceGuard, context: FlowEvidenceContext, subjects: readonly FlowSubject[]): FlowGuardResult => {
  const kind = kindOf(guard)
  const choices = choicesFor(guard, context.facts)
  if ('review' in guard && subjects.length > 1) return reviewNarrowing(guard.review, kind, choices, context, subjects)
  const matched: FlowSubject[] = []
  const evidence: string[] = []
  let sawNegative = false
  for (const subject of subjects) {
    const found = chooseFact(choices, { cards: [subject.card], round: context.finished.n, kind, at: subject.at })
    if (found) {
      matched.push(subject)
      evidence.push(found.id)
      continue
    }
    if (observedAt(choices, context.finished.n, kind, subject)) sawNegative = true
  }
  if (subjects.length > 0 && matched.length === subjects.length) return { state: 'matched', evidence: [...new Set(evidence)], subjects: matched }
  if (sawNegative) return { state: 'no-match' }
  return { state: 'waiting', reason: waitingFor(guard) }
}

/**
 * A `review` guard over more than one candidate: the reviewers' own `at`
 * chooses which one they judged. Every fresh, kept review naming the answer
 * must agree on one revision; disagreement is ambiguous rather than a partial
 * match, and a revision no candidate carries is not one that exists here.
 */
const reviewNarrowing = (
  answer: string, kind: string, choices: readonly FactChoice[], context: FlowEvidenceContext, subjects: readonly FlowSubject[],
): FlowGuardResult => {
  const seen = choices.filter((one) => one.round === context.finished.n && one.fresh && !one.restored)
  if (seen.length === 0) return { state: 'waiting', reason: waitingFor({ review: answer }) }
  const negative = seen.filter((one) => !one.passed)
  const positive = seen.filter((one) => one.passed)
  const heads = new Set(positive.map((one) => one.at))
  if (heads.size > 1) return { state: 'waiting', reason: AMBIGUOUS_REVIEWS }
  if (heads.size === 0) return negative.length > 0 ? { state: 'no-match' } : { state: 'waiting', reason: waitingFor({ review: answer }) }
  const [at] = heads
  const subject = subjects.find((one) => one.at === at)
  if (!subject) return { state: 'waiting', reason: MISSING_EVIDENCE }
  const winners = positive.filter((one) => one.at === at && one.card === subject.card)
  return { state: 'matched', evidence: [...new Set(winners.map((one) => one.id))], subjects: [subject] }
}

/**
 * A rule's whole evidence list. Every guard must match, over the same
 * surviving subjects — a `review` guard may narrow them, and a later guard is
 * judged only against what an earlier one left. Empty guards match trivially,
 * over every subject the round offers.
 */
export function evidenceGuard(guards: readonly FlowEvidenceGuard[], context: FlowEvidenceContext): FlowGuardResult {
  let subjects = context.subjects
  const evidence = new Set<string>()
  for (const guard of guards) {
    const result = evaluateGuard(guard, context, subjects)
    if (result.state !== 'matched') return result
    subjects = result.subjects
    for (const id of result.evidence) evidence.add(id)
  }
  if (subjects.length === 0) return { state: 'waiting', reason: MISSING_EVIDENCE }
  return { state: 'matched', evidence: [...evidence], subjects }
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
 * Findings, publishing and forge posting are absent by design: these records
 * stay local, judged by a claim and a candidate this process itself minted,
 * never by parsing what an agent said.
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
