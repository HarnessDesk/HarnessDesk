import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { isDeepStrictEqual, promisify } from 'node:util'
import { parseLeadCardDecisionFor, type LeadAcceptanceContract, type LeadCard, type LeadCardDecision, type LeadPullRequest, type TriggerFact } from '@harnessdesk/protocol'
import { parseLeadPublicationSource, type LeadJournal, type LeadPublicationSource, type LeadPublicationOperation, type LeadOwnedPush } from '@harnessdesk/lead'
import type { PullObservation, PullWatch } from '../intake/forge.js'
import { HARDENED_GIT_CONFIG } from '../git-hardening.js'
import { pushBranch } from '../git-actions.js'

const run = promisify(execFile)
const git = async (cwd: string, args: readonly string[]): Promise<string> => {
  const result = await run('git', ['-C', cwd, ...HARDENED_GIT_CONFIG, ...args], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
  return result.stdout.trim()
}
/** Compare the live checkout and destination before every effect, including recovery. */
export const verifyPublicationSource = async (value: LeadPublicationSource): Promise<void> => {
  const source = parseLeadPublicationSource(value)
  if (source.branch === source.defaultBranch) throw new Error('lead-push-default-branch')
  if (await git(source.cwd, ['symbolic-ref', '--short', 'HEAD']) !== source.branch || await git(source.cwd, ['rev-parse', 'HEAD']) !== source.head ||
    await git(source.cwd, ['remote', 'get-url', '--push', '--all', source.remote]) !== source.remoteUrl)
    throw new Error('lead-publication-checkout-changed')
}
/** New branches are create-only; updates require the exact owned tip and proven ancestry.
 * The empty lease is a create-if-absent assertion, never permission to replace a branch. */
export const pushToOwnedBranch = async (source: LeadPublicationSource, ownedHead: string | null, reconcile = false): Promise<{ pushed: boolean }> => {
  await verifyPublicationSource(source)
  const ref = `refs/heads/${source.branch}`
  const read = await git(source.cwd, ['ls-remote', '--heads', source.remoteUrl, ref])
  const remote = read.split('\n').map(line => line.split(/\s+/)).find(([, name]) => name === ref)?.[0] ?? null
  if (remote === source.head && (ownedHead !== null || reconcile)) return { pushed: false }
  if (ownedHead === null && remote !== null) throw new Error('lead-push-branch-exists-not-owned')
  if (ownedHead !== null) {
    if (remote !== ownedHead) throw new Error('lead-push-owned-head-changed')
    try { await git(source.cwd, ['merge-base', '--is-ancestor', ownedHead, source.head]) }
    catch { throw new Error('lead-push-not-fast-forward') }
  }
  await verifyPublicationSource(source)
  await pushBranch(source.cwd, source.remoteUrl, source.head, ref, ownedHead === null)
  if ((await git(source.cwd, ['ls-remote', '--heads', source.remoteUrl, ref])).split(/\s/)[0] !== source.head)
    throw new Error('lead-push-head-changed')
  return { pushed: true }
}

/** The repair owner supplies its fresh reviewed-round gate. The host journals the repair push and head update here. */
export const pushOwnedLeadBranch = async (options: {
  readonly journal: LeadJournal; readonly source: LeadPublicationSource; readonly now: () => number
  readonly validate: () => Promise<void>
}): Promise<void> => {
  const { journal, validate } = options, source = parseLeadPublicationSource(options.source)
  const previous = journal.state.ownedPush, pr = journal.state.pr
  if (!pr) throw new Error('lead-push-unowned')
  if (previous?.stage === 'completed' && previous.source.head === source.head && pr.head === source.head) return
  await validate()
  const replay = previous?.source.head === source.head
  let operation: LeadOwnedPush = replay ? { ...previous!, stage: 'prepared' } :
    { source, number: pr.number, previousHead: pr.head, at: options.now(), stage: 'prepared' }
  if (!isDeepStrictEqual(operation.source, source)) throw new Error('lead-push-source-changed')
  await journal.ownedPush(operation)
  try {
    await validate()
    const current = journal.state
    if (current.pr?.head !== operation.previousHead || current.pr.number !== operation.number || current.pr.state !== 'open' ||
      ['accepted', 'declined', 'stopped'].includes(current.phase) || current.recoveryBlocked || current.budget?.stop) throw new Error('lead-push-owner-changed')
    await pushToOwnedBranch(source, operation.previousHead, !!replay)
    operation = { ...operation, stage: 'completed' }
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
  readonly now: () => number
  readonly validate: (card: ResultCard, decision: LeadCardDecision, contract: LeadAcceptanceContract) => Promise<void>
  readonly source: (card: ResultCard, contract: LeadAcceptanceContract) => Promise<LeadPublicationSource>
  /** Must read the forge afresh. An initial claim additionally requires a worker publication. */
  readonly find: (source: LeadPublicationSource, recovering: boolean) => Promise<readonly LeadPrCandidate[]>
  readonly create: (source: LeadPublicationSource, card: ResultCard, contract: LeadAcceptanceContract) => Promise<LeadPrCandidate>
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
    const current = this.#card(decision)
    if (!isDeepStrictEqual(current.card, card) || !isDeepStrictEqual(current.contract, contract)) throw new Error('lead-card-stale')
    await this.options.validate(card, decision, contract)
    const source = parseLeadPublicationSource(await this.options.source(card, contract))
    this.#card(decision)
    const previous = this.options.journal.state.publication
    const retry = previous?.stage === 'needs-you' && isDeepStrictEqual(previous.decision, decision) && isDeepStrictEqual(previous.source, source)
    const id = retry ? previous.id : `publication-${randomUUID()}`
    if (previous && previous.stage !== 'completed' && !retry) throw new Error('lead-publication-pending')
    await this.options.journal.publication(retry ? { ...previous, stage: 'push-prepared' } : { id, decision, source, at: this.options.now(), stage: 'push-prepared' })
    await this.#run(retry)

  }) }
  pushOwned(source: LeadPublicationSource, validate: () => Promise<void>): Promise<void> {
    return this.#queue(() => pushOwnedLeadBranch({ journal: this.options.journal, source, now: this.options.now, validate }))
  }
  reconcile(): Promise<void> { return this.#queue(async () => {
    const op = this.options.journal.state.publication
    if (!op || op.stage === 'needs-you' || this.options.journal.state.decidedCards.includes(`${op.decision.cardId}:${op.decision.expectedRevision}`)) return
    await this.#run(true)
  }) }
  async #run(recovering: boolean): Promise<void> {
    const { journal, validate, source: readSource, find, create } = this.options
    let op = journal.state.publication!
    const { card, contract } = this.#card(op.decision)
    const advance = async (stage: LeadPublicationOperation['stage'], pr: LeadPullRequest | null = null) => {
      op = { ...op, stage }; await journal.publication(op, pr)
    }
    const guard = async () => {
      this.#card(op.decision)
      await validate(card, op.decision, contract)
      if (!isDeepStrictEqual(parseLeadPublicationSource(await readSource(card, contract)), op.source)) throw new Error('lead-publication-source-changed')
      this.#card(op.decision)
    }
    try {
      await guard()
      const owned = journal.state.pr
      if (owned && (owned.repository !== op.source.repository || owned.branch !== op.source.branch || owned.state !== 'open')) throw new Error('lead-publication-owner-changed')
      let candidates = await find(op.source, recovering)
      const matching = () => candidates.length === 1 && candidates[0]!.repository === op.source.repository &&
        candidates[0]!.branch === op.source.branch && candidates[0]!.head === op.source.head && (!owned || candidates[0]!.number === owned.number)
      if (owned && candidates.length === 1 && candidates[0]!.repository === owned.repository && candidates[0]!.number === owned.number && candidates[0]!.branch === owned.branch && candidates[0]!.head === owned.head && owned.head !== op.source.head) candidates = []
      if (candidates.length && !matching()) throw new Error('lead-publication-conflict')
      if (op.stage === 'push-prepared') {
        if (!candidates.length) {
          await guard()
          await (this.options.push ?? pushToOwnedBranch)(op.source, owned?.head ?? null, recovering)
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
        await advance('completed', { ...candidates[0]!, state: 'open', check: null, review: null, at: this.options.now() })
      }
      await journal.decideCard(op.decision, null, undefined, () => validate(card, op.decision, contract))
    } catch (error) {
      // If disk itself failed, preserve the last prepared stage for crash reconciliation.
      if (journal.state.publication?.stage !== 'completed')
        try { await advance('needs-you') } catch { /* The durable prefix still owns recovery. */ }
      throw error
    }
  }
  watches(): readonly (PullWatch & { readonly project: string; readonly repository: string; readonly head: string; readonly number: number })[] {
    const state = this.options.journal.state, pr = state.pr
    if (!pr || pr.state !== 'open' || state.phase === 'stopped' || !state.contract) return []
    return [{ project: state.contract.project.path, repository: pr.repository, number: pr.number, head: pr.head, since: state.publication?.at ?? pr.at,
      checks: state.follow.checks, reviews: state.follow.reviews }]
  }
  /** Keep a bounded latest review status; repair admission has its own host owner. */
  async observeFacts(facts: readonly TriggerFact[]): Promise<void> {
    for (const fact of facts) {
      const { journal } = this.options, state = journal.state, pr = state.pr
      if (!pr || !this.watches().length || !state.follow.reviews || fact.action !== 'review-commented' || !fact.review ||
        fact.repository !== pr.repository || fact.subject !== String(pr.number) || fact.head !== pr.head || fact.review.head !== pr.head ||
        fact.at < (state.publication?.at ?? pr.at) || (pr.review && fact.review.id <= pr.review.id)) continue
      await journal.observePr({ ...pr, review: fact.review, at: Math.max(pr.at, fact.at) })
    }
  }
  async observe(observation: PullObservation): Promise<void> {
    const { journal } = this.options, state = journal.state, pr = state.pr
    if (!pr || !this.watches().length || observation.repository !== pr.repository || observation.number !== pr.number ||
      observation.head !== pr.head || observation.at < pr.at) return
    const next = { ...pr, state: observation.state, check: state.follow.checks ? observation.check?.head === pr.head ? observation.check : null : pr.check, at: observation.at }
    if (JSON.stringify(next) !== JSON.stringify(pr)) await journal.observePr(next)
  }
}
