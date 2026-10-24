import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { parseLeadCardDecisionFor, type LeadAcceptanceContract, type LeadCard, type LeadCardDecision, type LeadPullRequest, type TriggerFact } from '@harnessdesk/protocol'
import { parseLeadPublicationSource, type LeadJournal, type LeadPublicationSource, type LeadPublicationOperation, type LeadOwnedPush } from '@harnessdesk/lead'
import type { PullObservation, PullWatch } from '../intake/forge.js'
import type { GitGateway, GitRequester, GitCheckout } from '../git-gateway/index.js'

// Transport labels from older journals are historical metadata. The gateway
// always chooses its destination from the pinned repository, never these fields.
const sameSource = (left: LeadPublicationSource, right: LeadPublicationSource): boolean => {
  const { remote: _leftRemote, remoteUrl: _leftUrl, ...a } = left
  const { remote: _rightRemote, remoteUrl: _rightUrl, ...b } = right
  return isDeepStrictEqual(a, b)
}
/** Compare the reviewed checkout identity before every effect, including recovery. */
export const verifyPublicationSource = async (value: LeadPublicationSource, gateway: GitGateway): Promise<GitCheckout> => {
  const source = parseLeadPublicationSource(value)
  if (source.branch === source.defaultBranch) throw new Error('lead-push-default-branch')
  const checkout = await gateway.inspectCheckout(source.cwd)
  if (checkout.branch !== source.branch || checkout.sha !== source.head) throw new Error('lead-publication-checkout-changed')
  return checkout
}
/** New branches are create-only; updates require the exact owned tip and proven ancestry.
 * The empty lease is a create-if-absent assertion, never permission to replace a branch. */
export const pushToOwnedBranch = async (source: LeadPublicationSource, ownedHead: string | null, reconcile: boolean,
  beforePush: () => Promise<void>, gateway: GitGateway, requester: GitRequester): Promise<{ pushed: boolean }> => {
  const { objectStore, tree } = await verifyPublicationSource(source, gateway)
  try { return await gateway.push({ repository: source.repository, branch: source.branch, sha: source.head, previousSha: ownedHead, objectStore, tree, requester },
    { reconcile, beforePush: async () => { await verifyPublicationSource(source, gateway); await beforePush() } }) }
  catch (error) {
    // Keep the Lead's existing refusal codes at its own boundary.
    if (error instanceof Error && ['git-gateway-branch-exists-not-owned', 'git-gateway-owned-head-changed', 'git-gateway-not-fast-forward', 'git-gateway-head-changed'].includes(error.message))
      throw new Error(error.message.replace('git-gateway-', 'lead-push-'))
    throw error
  }
}

/** The repair owner supplies its fresh reviewed-round gate. The host journals the repair push and head update here. */
export const pushOwnedLeadBranch = async (options: {
  readonly journal: LeadJournal; readonly source: LeadPublicationSource; readonly now: () => number
  readonly validate: () => Promise<void>
  readonly gateway: GitGateway
}): Promise<void> => {
  const { journal, validate } = options, source = parseLeadPublicationSource(options.source)
  const previous = journal.state.ownedPush, pr = journal.state.pr
  if (!pr) throw new Error('lead-push-unowned')
  if (pr.branchOwner === 'person') throw new Error('lead-push-branch-released')
  if (previous?.stage === 'completed' && previous.source.head === source.head && pr.head === source.head) return
  await validate()
  if (previous && ['needs-you', 'prepared'].includes(previous.stage) && previous.source.head !== source.head && previous.effectStarted === false)
    await journal.ownedPush({ ...previous, stage: 'superseded' })
  const replay = previous?.source.head === source.head && previous.stage !== 'superseded'
  let operation: LeadOwnedPush = replay ? { ...previous!, stage: previous!.stage === 'push-started' ? 'push-started' : 'prepared' } :
    { source, number: pr.number, previousHead: pr.head, at: options.now(), stage: 'prepared', effectStarted: false }
  if (!sameSource(operation.source, source)) throw new Error('lead-push-source-changed')
  await journal.ownedPush(operation)
  try {
    await validate()
    const current = journal.state
    if (current.pr?.branchOwner === 'person') throw new Error('lead-push-branch-released')
    if (current.pr?.head !== operation.previousHead || current.pr.number !== operation.number || current.pr.state !== 'open' ||
      ['accepted', 'declined', 'stopped'].includes(current.phase) || current.recoveryBlocked || current.budget?.stop) throw new Error('lead-push-owner-changed')
    await pushToOwnedBranch(source, operation.previousHead, !!replay && (previous?.effectStarted === true || previous?.stage === 'push-started'), async () => {
      operation = { ...operation, stage: 'push-started', effectStarted: true }; await journal.ownedPush(operation)
    }, options.gateway, { kind: 'lead-goal', id: journal.state.budget!.logicalGoalId })
    operation = { ...operation, stage: 'completed', at: Math.max(operation.at, journal.state.pr!.at, options.now()) }
    await journal.ownedPush(operation)
  } catch (error) {
    try { await journal.ownedPush({ ...operation, stage: 'needs-you' }) } catch { /* Retain the prepared prefix on disk failure. */ }
    throw error
  }
}

export interface LeadPrCandidate { readonly repository: string; readonly number: number; readonly branch: string; readonly head: string }
type ResultCard = Extract<LeadCard, { type: 'result' }>
export interface LeadPrFollowOptions {
  readonly journal: LeadJournal
  readonly gateway: GitGateway
  readonly now: () => number
  readonly validate: (card: ResultCard, decision: LeadCardDecision, contract: LeadAcceptanceContract) => Promise<void>
  readonly source: (card: ResultCard, contract: LeadAcceptanceContract) => Promise<LeadPublicationSource>
  /** Must read the forge afresh. An initial claim additionally requires a worker publication. */
  readonly find: (source: LeadPublicationSource, recovering: boolean) => Promise<readonly LeadPrCandidate[]>
  readonly create: (source: LeadPublicationSource, card: ResultCard, contract: LeadAcceptanceContract) => Promise<LeadPrCandidate>
  /** Final person-gate answer, inside the decision's journal transaction. Preflight validate stays read-only. */
  readonly answer?: LeadPrFollowOptions['validate']
  readonly push?: (source: LeadPublicationSource, ownedHead: string | null, reconcile: boolean) => Promise<unknown>
}
/** External effects never run on the journal writer queue. A persisted click is their only authority. */
export class LeadPrFollow {
  #tail: Promise<unknown> = Promise.resolve()
  constructor(private readonly options: LeadPrFollowOptions) {}
  #queue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(work); this.#tail = next.catch(() => {}); return next
  }
  #card(decision: LeadCardDecision): { card: ResultCard; contract: LeadAcceptanceContract } {
    const state = this.options.journal.state, card = state.cards.find(card => card.id === decision.cardId)
    if (!card || card.type !== 'result' || state.decidedCards.includes(`${card.id}:${card.revision}`) || state.contract?.digest !== card.contractDigest ||
      ['accepted', 'declined', 'stopped'].includes(state.phase) || state.recoveryBlocked || state.budget?.stop) throw new Error('lead-card-stale')
    parseLeadCardDecisionFor(decision, card)
    if (decision.choice !== 'accept-open-pr' && !(card.publication === 'push' && decision.choice === 'accept')) throw new Error('lead-publication-choice')
    return { card, contract: state.contract! }
  }
  accept(card: ResultCard, decision: LeadCardDecision, contract: LeadAcceptanceContract): Promise<void> { return this.#queue(async () => {
    const pending = this.options.journal.state.publication
    if (pending?.stage === 'push-prepared' && !isDeepStrictEqual(pending.decision, decision)) {
      const oldCard = this.options.journal.state.cards.find(card => card.id === pending.decision.cardId)
      if (pending.effectStarted === false && (!oldCard || oldCard.revision !== pending.decision.expectedRevision || oldCard.contractDigest !== pending.decision.contractDigest))
        // The old approval cannot be replayed, and no external effect began.
        await this.options.journal.publication({ ...pending, stage: 'superseded' })
      else await this.#run(pending.effectStarted === true)
    }
    const current = this.#card(decision)
    if (!isDeepStrictEqual(current.card, card) || !isDeepStrictEqual(current.contract, contract)) throw new Error('lead-card-stale')
    await this.options.validate(card, decision, contract)
    if (this.options.journal.state.pr?.branchOwner === 'person') throw new Error('lead-push-branch-released')
    const source = parseLeadPublicationSource(await this.options.source(card, contract))
    this.#card(decision)
    const previous = this.options.journal.state.publication
    const same = previous && isDeepStrictEqual(previous.decision, decision) && sameSource(previous.source, source)
    if (same && !['completed', 'needs-you', 'superseded'].includes(previous.stage)) { await this.#run(previous.effectStarted === true); return }
    const retry = previous?.stage === 'needs-you' && same
    if (previous?.stage === 'needs-you' && !retry && previous.effectStarted === false)
      await this.options.journal.publication({ ...previous, stage: 'superseded' })
    const id = retry ? previous.id : `publication-${randomUUID()}`
    if (previous && !['completed', 'superseded'].includes(this.options.journal.state.publication!.stage) && !retry) throw new Error('lead-publication-pending')
    await this.options.journal.publication(retry ? { ...previous, stage: 'push-prepared' } : { id, decision, source, at: this.options.now(), stage: 'push-prepared', effectStarted: false })
    await this.#run(!!retry && previous?.effectStarted === true)

  }) }
  pushOwned(source: LeadPublicationSource, validate: () => Promise<void>): Promise<void> {
    return this.#queue(() => pushOwnedLeadBranch({ journal: this.options.journal, source, now: this.options.now, validate, gateway: this.options.gateway }))
  }
  reconcile(): Promise<void> { return this.#queue(async () => {
    const op = this.options.journal.state.publication
    if (!op || op.stage === 'needs-you' || op.stage === 'superseded' || this.options.journal.state.decidedCards.includes(`${op.decision.cardId}:${op.decision.expectedRevision}`)) return
    await this.#run(op.effectStarted === true || ['push-started', 'pushed', 'create-prepared', 'completed'].includes(op.stage))
  }) }
  async #run(recovering: boolean): Promise<void> {
    const { journal, validate, source: readSource, find, create } = this.options
    let op = journal.state.publication!
    const { card, contract } = this.#card(op.decision)
    const advance = async (stage: LeadPublicationOperation['stage'], pr: LeadPullRequest | null = null) => {
      op = { ...op, stage, ...(stage === 'push-started' ? { effectStarted: true } : {}) }; await journal.publication(op, pr)
    }
    const guard = async () => {
      this.#card(op.decision)
      await validate(card, op.decision, contract)
      if (!sameSource(parseLeadPublicationSource(await readSource(card, contract)), op.source)) throw new Error('lead-publication-source-changed')
      this.#card(op.decision)
    }
    try {
      await guard()
      const owned = journal.state.pr
      if (owned?.branchOwner === 'person') throw new Error('lead-push-branch-released')
      if (owned && (owned.repository !== op.source.repository || owned.branch !== op.source.branch || owned.state !== 'open')) throw new Error('lead-publication-owner-changed')
      const pushedByGoal = () => this.options.gateway.hasSucceededPush({ repository: op.source.repository, branch: op.source.branch,
        sha: op.source.head, requester: { kind: 'lead-goal', id: journal.state.budget!.logicalGoalId } })
      if (recovering && !['push-prepared', 'push-started'].includes(op.stage) && !pushedByGoal()) throw new Error('lead-publication-push-unproven')
      let candidates = await find(op.source, recovering)
      const matching = () => candidates.length === 1 && candidates[0]!.repository === op.source.repository &&
        candidates[0]!.branch === op.source.branch && candidates[0]!.head === op.source.head && (!owned || candidates[0]!.number === owned.number)
      if (owned && candidates.length === 1 && candidates[0]!.repository === owned.repository && candidates[0]!.number === owned.number && candidates[0]!.branch === owned.branch && candidates[0]!.head === owned.head && owned.head !== op.source.head) candidates = []
      if (candidates.length && !matching()) throw new Error('lead-publication-conflict')
      if (candidates.length && (recovering || card.publication === 'push') && !pushedByGoal()) throw new Error('lead-publication-push-unproven')
      if (op.stage === 'push-prepared' || op.stage === 'push-started') {
        if (!candidates.length) {
          await guard()
          if (this.options.push) {
            await advance('push-started')
            await this.options.push(op.source, owned?.head ?? null, recovering)
          } else await pushToOwnedBranch(op.source, owned?.head ?? null, recovering, () => advance('push-started'), this.options.gateway, { kind: 'lead-goal', id: journal.state.budget!.logicalGoalId })
        }
        await advance('pushed')
      }
      if (!candidates.length && op.stage !== 'completed') {
        if (owned) candidates = [{ ...owned, head: op.source.head }]
        else {
          await advance('create-prepared')
          await guard()
          candidates = await find(op.source, true)
          if (!candidates.length) candidates = [await create(op.source, card, contract)]
        }
      }
      if (op.stage !== 'completed') {
        if (!matching()) throw new Error('lead-publication-conflict')
        await advance('completed', { ...candidates[0]!, branchOwner: 'lead', observedHead: op.source.head, state: 'open', check: null, review: null, at: this.options.now() })
      }
      await journal.decideCard(op.decision, null, undefined, () => (this.options.answer ?? validate)(card, op.decision, contract))
    } catch (error) {
      // If disk itself failed, preserve the last prepared stage for crash reconciliation.
      if (journal.state.publication?.stage !== 'completed')
        try { await advance('needs-you') } catch { /* The durable prefix still owns recovery. */ }
      else try { await journal.publicationNeedsYou(op.id) } catch { /* Preserve the successful publication and pending decision on disk failure. */ }
      throw error
    }
  }
  watches(): readonly (PullWatch & { readonly project: string; readonly repository: string; readonly head: string; readonly number: number })[] {
    const state = this.options.journal.state, pr = state.pr
    if (!pr || pr.state !== 'open' || state.phase === 'stopped' || !state.contract) return []
    return [{ project: state.contract.project.path, repository: pr.repository, number: pr.number, head: pr.observedHead ?? pr.head, since: state.publication?.at ?? pr.at,
      checks: true, reviews: true }]
  }
  /** Keep a bounded latest review status; repair admission has its own host owner. */
  observeFacts(facts: readonly TriggerFact[]): Promise<void> { return this.#queue(async () => {
    for (const fact of facts) {
      const { journal } = this.options, state = journal.state, pr = state.pr
      if (!pr || !this.watches().length || fact.action !== 'review-commented' || !fact.review ||
        fact.repository !== pr.repository || fact.subject !== String(pr.number) || fact.head !== (pr.observedHead ?? pr.head) || fact.review.head !== (pr.observedHead ?? pr.head) ||
        fact.at < (state.publication?.at ?? pr.at) || (pr.review && fact.review.id <= pr.review.id)) continue
      await journal.observePr({ ...pr, review: fact.review, at: Math.max(pr.at, fact.at) })
    }
  }) }
  reclaim(card: Extract<LeadCard, { type: 'branch-ownership' }>, decision: LeadCardDecision): Promise<void> {
    return this.#queue(async () => {
      const { journal, gateway } = this.options
      if (decision.choice !== 'reclaim-branch') throw new Error('lead-publication-choice')
      const current = journal.state.pr
      if (!current || current.repository !== card.repository || current.number !== card.number || current.observedHead !== card.observedHead) throw new Error('lead-card-stale')
      const remoteHead = await gateway.remoteHead(current.repository, current.branch)
      await journal.decideCard(decision, null, undefined, async () => {
        const pr = journal.state.pr
        if (!pr || pr.state !== 'open' || pr.branchOwner !== 'person' || pr.repository !== card.repository || pr.number !== card.number ||
          pr.branch !== current.branch || pr.observedHead !== card.observedHead || remoteHead !== card.observedHead ||
          ['accepted', 'declined', 'stopped'].includes(journal.state.phase) || journal.state.recoveryBlocked || journal.state.budget?.stop) throw new Error('lead-card-stale')
      })
    })
  }
  observe(observation: PullObservation): Promise<void> { return this.#queue(async () => {
    const { journal, gateway } = this.options, state = journal.state, pr = state.pr
    if (!pr || !this.watches().length || observation.repository !== pr.repository || observation.number !== pr.number || observation.at < pr.at) return
    let head = pr.head, branchOwner = pr.branchOwner ?? 'lead', releaseReason = pr.releaseReason, branchChange = pr.branchChange
    if (observation.state === 'open' && observation.head !== (pr.observedHead ?? pr.head)) {
      const author = await gateway.attribute(pr.repository, pr.branch, observation.head)
      const attributed = author !== 'unknown' && author.kind === 'lead-goal' && author.id === state.budget?.logicalGoalId
      // A late poll can still carry a head from an earlier successful push.
      // Distinguish it from an actual rewind at the pinned remote before
      // adopting anything or releasing authority.
      const oldHead = attributed && observation.head !== pr.head &&
        await gateway.isAncestor(pr.repository, observation.head, pr.head).catch(() => false)
      if (oldHead && await gateway.remoteHead(pr.repository, pr.branch) !== observation.head) return
      const fastForward = !oldHead && await gateway.isAncestor(pr.repository, pr.observedHead ?? pr.head, observation.head).catch(() => false)
      if (branchOwner !== 'person' && attributed && fastForward) {
        head = observation.head
        const pending = journal.state.ownedPush
        if (pending && pending.source.head === head && pending.number === pr.number && !['completed', 'superseded'].includes(pending.stage)) {
          if (pending.stage === 'needs-you') await journal.ownedPush({ ...pending, stage: 'prepared' })
          await journal.ownedPush({ ...journal.state.ownedPush!, stage: 'completed', at: Math.max(pending.at, pr.at, this.options.now()) })
        }
      } else {
        branchOwner = 'person'
        // An unavailable ancestry proof must never grant push authority.
        branchChange = fastForward ? 'fast-forward' : 'rewrite'
        releaseReason = `Branch ${fastForward ? 'extended' : 'rewritten'} by ${author === 'unknown' ? 'an unknown writer' : `${author.kind} ${author.id}`}. Automatic updates are paused.`
      }
    }
    const next: LeadPullRequest = { ...pr, head, branchOwner, observedHead: observation.head,
      ...(releaseReason ? { releaseReason, branchChange } : {}), state: observation.state,
      check: observation.check?.head === observation.head ? observation.check : null,
      review: pr.review?.head === observation.head ? pr.review : null, at: Math.max(observation.at, journal.state.pr!.at) }
    if (JSON.stringify(next) !== JSON.stringify(pr)) await journal.observePr(next)
    if (next.state === 'open' && next.branchOwner === 'person' && journal.state.contract) {
      // One immutable choice per observed head. A later observation invalidates
      // the old choice at reducer and execution time, including after replay.
      const id = `reclaim-${pr.number}-${observation.head}`
      if (!journal.state.cards.some(card => card.id === id)) await journal.offerCard({ version: 1, id, revision: 1, type: 'branch-ownership',
        contractDigest: journal.state.contract.digest, repository: pr.repository, number: pr.number, observedHead: observation.head,
        summary: releaseReason ?? 'The branch belongs to you. Reclaim it to resume automatic repairs.' })
    }
  }) }
}
