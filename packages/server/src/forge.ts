import { gitSteerContext } from './git-gateway/steer-context.js'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'

import { validateForgeArgs, type ForgePush, type ForgeCreate, type ForgeUpdate, type ForgeMerge, type ForgeReview, type ForgeComment, type ForgeRecordQuery, type ForgeAttribute, type ForgeVerb, type ForgeWriteResult, type ForgeEngine, type ForgeIdentity, type ForgeScope, type ForgeSeat } from '@harnessdesk/cordis-host'
import { isForgeReference, itemId, type ConfigOption, type ForgeAssociatedPullRequest, type ForgeReference, type PublicationItem } from '@harnessdesk/protocol'

import type { GitGateway, GitRequester, GitApproval } from './git-gateway/index.js'
import type { HeldQuestion } from './ceilings/gate.js'

import { seatOf } from './seat.js'

/**
 * The forge plane: what the desk adds around a git forge.
 *
 * A pull request an agent opens from here is published *through the desk*,
 * and two things follow from that which nothing else can supply. The
 * **seat** — which agent, on which model, at which effort — is a fact about
 * the conversation that made the tool call; the Git plugin renders it into
 * the signature the person configured, and this is where it is read from.
 * The **record** of what was published belongs in the transcript, drawn as
 * the object it is rather than as a line of shell output; this is what puts
 * it there, as a `publication` item in the turn that was running.
 *
 * Writes run through the host's one GitGateway; its pinned destination and
 * credential helper never enter a plugin's checkout or shell.
 *
 * And one sentence for the agents: the standing instruction that names the
 * `pr_*` tools, handed to each agent through its own instruction layer —
 * never through the conversation, which is the person's. See `instructions`.
 */

/** The forge plane's window onto the host. */
export interface ForgePort {
  readonly gitGateway?: GitGateway
  checkoutOf?(scope: ForgeScope): Promise<{ readonly cwd: string; readonly root: string } | null>
  admitWrite?(verb: ForgeVerb, scope: ForgeScope, args?: unknown): Promise<void>
  askPerson?(scope: ForgeScope, question: HeldQuestion, signal?: AbortSignal): Promise<'allowed' | 'standing' | 'refused' | 'unanswered'>
  mergeStep?(scope: ForgeScope, target: { readonly number: number; readonly head: string }): boolean
  guardedMerge?(scope: ForgeScope): boolean
  mergeAuthority?(scope: ForgeScope, target: { readonly repository: string; readonly number: number; readonly head: string }): Promise<import('@harnessdesk/protocol').ReviewTargetBinding | null>
  mergeFence?(scope: ForgeScope, target: { readonly repository: string; readonly number: number; readonly head: string }): string | null
  mergeGeneration?(): number
  /** The agent behind a runtime — its presentation name and version — or null when the host has no such runtime. */
  agentOf(runtime: string): { readonly name: string; readonly version: string | null } | null
  /** The controls of a conversation with their current values, or null when the host holds no such conversation. */
  optionsOf(runtime: string, sessionId: string): readonly ConfigOption[] | null
  /** The Team role, review round and Team name for this conversation; null outside a Team. */
  teamOf?(runtime: string, sessionId: string): Pick<ForgeSeat, 'role' | 'round' | 'team'> | null
  /**
   * Puts a publication into a conversation's transcript, in the turn that is
   * running. False when the host holds no such conversation, or it has no
   * turn to put it in.
   */
  record(runtime: string, sessionId: string, item: PublicationItem): boolean
  /** Whether the `pr_*` tools are registered right now — the instruction names them. */
  toolsOffered(): boolean
  /** Why a conversation may not publish to a forge yet — a blind review round still open — or null. Absent: never embargoed. */
  embargoOf?(runtime: string, sessionId: string): string | null
  /**
   * Something the desk posted reached the forge: told before anything else,
   * whether or not the conversation can record it, so a trigger reading the
   * forge back never answers the desk's own comment as a person's.
   */
  posted?(reference: ForgeReference): Promise<void>
}

export interface ForgePlaneOptions {
  /**
   * Runs `gh`, for the identity. Overridable so a test can answer as a forge
   * would, and so the packaged app can point at the copy it found.
   */
  readonly gh?: GhRunner
  /** How long an identity answer stands before `gh` is asked again. */
  readonly identityTtlMs?: number
}

export type GhRunner = (args: readonly string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>

const run = promisify(execFile)

/** `gh` on PATH, the way the plugin reaches it: `execFile`, never a shell. */
export const ghOnPath: GhRunner = async (args) => {
  try {
    const result = await run('gh', [...args], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 })
    return { stdout: result.stdout.toString(), stderr: result.stderr.toString(), exitCode: 0 }
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number | string; message?: string }
    return {
      stdout: failure.stdout?.toString() ?? '',
      stderr: failure.stderr?.toString() ?? failure.message ?? '',
      exitCode: typeof failure.code === 'number' ? failure.code : 1,
    }
  }
}

/**
 * The one sentence every agent is told, in the channel its vendor built for
 * standing instructions. One sentence and no paragraph, because the tools'
 * own descriptions carry the rest, and because a longer briefing on every
 * conversation is a tax the person did not ask to pay. Named tools, so an
 * agent that reads it knows what to call; "rather than gh", so the agent
 * that already knows `gh` understands the trade.
 */
export const FORGE_INSTRUCTION =
  'Use the HarnessDesk git_push, pr_create, pr_update, pr_review and pr_merge tools for forge work, never gh; each is held to this seat’s ceiling. A board reviewer records its verdict with record_review; when the round closes, the desk handles publication according to the person’s posting setting. A read-ceiling reviewer cannot post a forge review or comment; return a standalone review to the person to publish.'

const DEFAULT_IDENTITY_TTL_MS = 5 * 60_000

/** What `gh` says when nobody is signed in, in the words it has used across versions. */
const NOT_SIGNED_IN = /not logged in|not logged into|authentication|gh auth login|HTTP 401/i

export class ForgePlane implements ForgeEngine {
  readonly #gh: GhRunner
  readonly #identityTtlMs: number
  #identity: { readonly at: number; readonly value: ForgeIdentity } | null = null
  #asking: Promise<ForgeIdentity> | null = null

  constructor(
    private readonly port: ForgePort,
    options: ForgePlaneOptions = {},
  ) {
    this.#gh = options.gh ?? ghOnPath
    this.#identityTtlMs = options.identityTtlMs ?? DEFAULT_IDENTITY_TTL_MS
  }

  readonly #standing = new Set<string>()
  #live(scope: ForgeScope): void {
    gitSteerContext.getStore()?.signal?.throwIfAborted()
    if (!scope.runtime || !scope.sessionId || !scope.plugin || scope.signal?.aborted || !scope.signal) {
      throw new Error('This forge call does not belong to a live invocation.')
    }
  }
  async #context(scope: ForgeScope, verb: ForgeVerb, args: unknown) {
    gitSteerContext.getStore()?.signal?.throwIfAborted()
    this.#live(scope)
    validateForgeArgs(verb, args)
    const gateway = this.port.gitGateway
    const checkout = await this.port.checkoutOf?.(scope)
    const seat = await this.seat(scope)
    if (!gateway || !checkout || !seat) throw new Error('No project and seat could be confirmed for this invocation.')
    const requester: GitRequester = scope.actor === 'human' ? { kind: 'person', id: 'person' } : {
      kind: 'session', id: `${scope.runtime}/${scope.sessionId}`,
      seat: { label: seat.label, role: seat.role, round: seat.round, team: seat.team },
      conversation: { runtime: scope.runtime!, sessionId: scope.sessionId! } }
    const repository = await gateway.pins.pinned(checkout.root)
    if (!['record', 'attribute', 'repository', 'associatedPullRequest'].includes(verb)) {
      try {
        if (scope.actor === 'context') throw new Error('Context resolution cannot write to the forge.')
        if (!this.port.admitWrite) throw new Error('The host has no forge write ceiling gate.')
        if (!gitSteerContext.getStore()?.admitted) await this.port.admitWrite(verb, scope, args)
        const allowed = await this.publicationAllowed(scope)
        if (!allowed.ok) throw new Error(allowed.reason)
      } catch (error) {
        if (repository) await gateway.refuse(this.#op(verb, args), { repository, requester, ...this.#address(args) }, String(error))
        throw error
      }
    }
    return { gateway, checkout, requester, repository }
  }
  #op(verb: ForgeVerb, args: unknown): import('./git-gateway/index.js').GitRecordEntry['op'] {
    if (verb === 'comment') return (args as ForgeComment)?.subject === 'issue' ? 'issue.comment' : 'pr.comment'
    const op = { push: 'push', create: 'pr.create', update: 'pr.update', merge: 'pr.merge', review: 'pr.review' } as const
    if (verb === 'record' || verb === 'attribute' || verb === 'repository' || verb === 'associatedPullRequest') throw new Error('A forge read has no write operation.')
    return op[verb]
  }
  #address(args: unknown): { number?: number } {
    const number = (args as { number?: unknown } | null)?.number
    return Number.isSafeInteger(number) && Number(number) > 0 ? { number: Number(number) } : {}
  }
  /** Refusals before plugin execution still belong in a known project's record. */
  async refuseTool(tool: string, args: unknown, scope: ForgeScope, reason: string, since = Date.now()): Promise<void> {
    const verb = ({ git_push: 'push', pr_create: 'create', pr_update: 'update', pr_merge: 'merge', pr_review: 'review', pr_comment: 'comment', issue_comment: 'comment' } as Partial<Record<string, ForgeVerb>>)[tool]
    if (!verb || !this.port.gitGateway) return
    const checkout = await this.port.checkoutOf?.(scope)
    const repository = checkout && await this.port.gitGateway.pins.pinned(checkout.root)
    if (!repository) return
    const requester: GitRequester = scope.actor === 'human' ? { kind: 'person', id: 'person' } : { kind: 'session', id: `${scope.runtime}/${scope.sessionId}` }
    const op = tool === 'issue_comment' ? 'issue.comment' : this.#op(verb, args)
    const address = this.#address(args)
    const rows = await this.port.gitGateway.record({ repository, ...address, limit: 100 })
    if (rows.some(row => row.op === op && row.at >= since && row.outcome !== 'intent' && row.requester.kind === requester.kind && row.requester.id === requester.id)) return
    await this.port.gitGateway.refuse(op, { repository, requester, ...address }, reason)
  }
  async #destination(scope: ForgeScope, verb: ForgeVerb, args: unknown) {
    const ctx = await this.#context(scope, verb, args)
    if (!ctx.repository) throw new Error('This project has no pinned repository. Call git_push and approve its repository first.')
    if (!await ctx.gateway.originMatches(ctx.checkout.cwd, ctx.repository)) {
      const reason = `The checkout origin differs from the pinned repository ${ctx.repository}; nothing was written.`
      await ctx.gateway.refuse(this.#op(verb, args), { repository: ctx.repository, requester: ctx.requester, ...this.#address(args) }, reason)
      throw new Error(reason)
    }
    return { ...ctx, repository: ctx.repository }
  }
  #beforeWrite(scope: ForgeScope, gateway: GitGateway, root: string, cwd: string, repository: string) {
    return async () => {
      this.#live(scope)
      if (await gateway.pins.pinned(root) !== repository || !await gateway.originMatches(cwd, repository)) throw new Error('git-gateway-repository-changed: The pinned repository or checkout origin changed; nothing was written.')
      this.#live(scope)
    }
  }
  async push(args: ForgePush, scope: ForgeScope): Promise<ForgeWriteResult> {
    const ctx = await this.#context(scope, 'push', args)
    const { gateway, checkout, requester } = ctx
    const proposed = await gateway.proposedRepository(checkout.cwd)
    const repository = ctx.repository ?? proposed
    if (!repository) throw new Error('The checkout origin does not propose a GitHub repository to pin.')
    const previousSha = args.expect === 'create' ? null : args.expect.head
    const target = { repository, branch: args.branch, sha: args.sha, previousSha, requester, steeredFrom: gitSteerContext.getStore()?.command }
    let executing = false
    try {
      if (ctx.repository && !await gateway.originMatches(checkout.cwd, ctx.repository)) throw new Error(`The checkout origin ${proposed ?? '(unrecognised)'} differs from the pinned repository ${ctx.repository}; nothing was written.`)
      const inspected = await gateway.inspectCheckout(checkout.cwd)
      const steered = gitSteerContext.getStore()?.push
      const sourceBranch = steered?.branch === args.branch && steered.sha === args.sha ? steered.sourceBranch : args.branch
      if (inspected.branch !== sourceBranch || inspected.sha !== args.sha) throw new Error('git-gateway-reviewed-sha-mismatch')
      const push = { ...target, objectStore: inspected.objectStore, tree: inspected.tree }
      // An unpinned origin is only a proposal until the person approves it.
      let assessment = ctx.repository ? await gateway.assessPush(push) : null
      const standingKey = `${requester.id}\0${checkout.root}\0${args.branch}`
      const history = await gateway.record({ repository, branch: args.branch, limit: 1000 })
      const ownCreation = history.some(row => row.op === 'push' && row.outcome === 'ok' && row.previousSha === null && row.requester.kind === 'session' && row.requester.id === requester.id)
      const owned = previousSha === null ? false : await gateway.attribute(repository, args.branch, previousSha)
      const continuation = owned !== 'outside' && owned !== false && owned.kind === 'session' && owned.id === requester.id && ownCreation
      let approval: GitApproval = { by: 'standing', at: Date.now() }
      let rewrite = assessment !== null && assessment.head !== null && !assessment.fastForward
      if (!ctx.repository || rewrite || !(continuation || this.#standing.has(standingKey))) {
        const approved = gitSteerContext.getStore()?.approved
        const answer = approved?.repository === repository && approved.branch === args.branch && approved.sha === args.sha && !rewrite ? 'allowed' : await this.port.askPerson?.(scope, {
          gateway: true, summary: `Push ${args.branch} to ${repository}`,
          reason: `${!ctx.repository ? 'Approve and pin this repository for the project. ' : ''}${rewrite ? 'This rewrites the branch. ' : ''}Push from HarnessDesk’s own copy, as you, and keep a record. The checkout’s git settings are not used.`,
          facts: [{ label: 'Repository', value: repository }, { label: 'Branch', value: args.branch }, { label: 'Head', value: args.sha }],
          options: [{ id: 'allow', label: 'Push', intent: 'approve' }, { id: 'standing', label: 'Push this branch without asking', intent: 'approveAlways' }, { id: 'refuse', label: "Don't push", intent: 'deny' }],
        }, gitSteerContext.getStore()?.signal)
        if (answer !== 'allowed' && answer !== 'standing') throw new Error(answer === 'unanswered' ? 'Push question timed out; nothing was written.' : 'Push refused: the person did not approve it.')
        if (answer === 'standing') this.#standing.add(standingKey)
        this.#live(scope)
        approval = { by: 'person', at: Date.now() }
        if (!ctx.repository) await gateway.pins.pin(checkout.root, repository, requester)
      }
      this.#live(scope)
      if (!assessment) {
        if (!await gateway.originMatches(checkout.cwd, repository)) throw new Error('The checkout origin differs from the pinned repository; nothing was written.')
        assessment = await gateway.assessPush(push)
        rewrite = assessment.head !== null && !assessment.fastForward
        if (rewrite) {
          const answer = await this.port.askPerson?.(scope, { gateway: true, summary: `Push ${args.branch} to ${repository}`,
            reason: 'This rewrites the branch. Push the reviewed head from HarnessDesk’s own copy, as you, and keep a record.',
            facts: [{ label: 'Repository', value: repository }, { label: 'Branch', value: args.branch }, { label: 'Head', value: args.sha }],
            options: [{ id: 'allow', label: 'Push', intent: 'approve' }, { id: 'refuse', label: "Don't push", intent: 'deny' }] }, gitSteerContext.getStore()?.signal)
          if (answer !== 'allowed') throw new Error(answer === 'unanswered' ? 'Push question timed out; nothing was written.' : 'Push refused: the person did not approve the rewrite.')
          this.#live(scope)
        }
      }
      gitSteerContext.getStore()?.signal?.throwIfAborted()
      executing = true
      await gateway.push({ ...push, steeredFrom: gitSteerContext.getStore()?.command, approval, ...(rewrite ? { allowRewrite: true } : {}) }, { beforePush: async () => {
        this.#live(scope)
        const current = await gateway.inspectCheckout(checkout.cwd)
        if (current.branch !== sourceBranch || current.sha !== args.sha || current.tree !== inspected.tree) throw new Error('git-gateway-reviewed-sha-mismatch')
        if (await gateway.pins.pinned(checkout.root) !== repository || !await gateway.originMatches(checkout.cwd, repository)) throw new Error('git-gateway-repository-changed')
      } })
      return { output: `Pushed ${args.branch} to ${repository} at ${args.sha}.`, repository }
    } catch (error) {
      if (!executing && await gateway.pins.pinned(checkout.root) === repository) await gateway.refuse('push', target, error instanceof Error ? error.message : String(error))
      throw error
    }
  }
  readonly pullRequest = {
    create: async (args: ForgeCreate, scope: ForgeScope): Promise<ForgeWriteResult> => {
      const { gateway, checkout, requester, repository } = await this.#destination(scope, 'create', args)
      const current = await gateway.inspectCheckout(checkout.cwd)
      if (current.branch !== args.head || await gateway.remoteHead(repository, args.head) !== current.sha) {
        const reason = 'Push this branch with git_push before opening its pull request.'
        await gateway.refuse('pr.create', { repository, requester, branch: args.head }, reason)
        throw new Error(reason)
      }
      this.#live(scope)
      return { output: await gateway.createPullRequest({ ...args, branch: args.head, repository, requester, steeredFrom: gitSteerContext.getStore()?.command, beforeWrite: this.#beforeWrite(scope, gateway, checkout.root, checkout.cwd, repository) }), repository }
    },
    update: async (args: ForgeUpdate, scope: ForgeScope): Promise<ForgeWriteResult> => {
      const { gateway, checkout, requester, repository } = await this.#destination(scope, 'update', args)
      this.#live(scope)
      return { output: await gateway.updatePullRequest({ ...args, repository, requester, steeredFrom: gitSteerContext.getStore()?.command, beforeWrite: this.#beforeWrite(scope, gateway, checkout.root, checkout.cwd, repository) }), repository }
    },
    merge: async (args: ForgeMerge, scope: ForgeScope): Promise<ForgeWriteResult> => {
      const { gateway, checkout, requester, repository } = await this.#destination(scope, 'merge', args)
      let approval: GitApproval = { by: 'ceiling', at: Date.now() }
      const guarded = this.port.guardedMerge?.(scope) ?? false
      const target = { repository, number: args.number, head: args.head }
      const generation = guarded ? this.port.mergeGeneration?.() : undefined
      const fence = guarded ? this.port.mergeFence?.(scope, target) : null
      const binding = guarded ? await this.port.mergeAuthority?.(scope, target) : null
      this.#live(scope)
      if (guarded && (!binding || generation === undefined || !fence || this.port.mergeGeneration?.() !== generation || this.port.mergeFence?.(scope, target) !== fence)) {
        const reason = 'This Flow merge requires a fresh review of its current pull request target.'
        await gateway.refuse('pr.merge', { repository, requester, number: args.number, sha: args.head }, reason)
        throw new Error(reason)
      }
      if (!guarded) {
        const answer = await this.port.askPerson?.(scope, { gateway: true, summary: `Merge pull request #${args.number} in ${repository}`,
          reason: `Merge head ${args.head}. No fresh review proof is checked for this manual approval.`, facts: [{ label: 'Repository', value: repository }, { label: 'Branch', value: await gateway.pullRequestHeadRef(repository, args.number) }, { label: 'Head', value: args.head }],
          options: [{ id: 'allow', label: 'Merge', intent: 'approve' }, { id: 'refuse', label: "Don't merge", intent: 'deny' }] }, gitSteerContext.getStore()?.signal)
        if (answer !== 'allowed') {
          await gateway.refuse('pr.merge', { repository, requester, number: args.number, sha: args.head }, 'Merge refused: the person did not approve it.')
          throw new Error(answer === 'unanswered' ? 'Merge question timed out; nothing was written.' : 'Merge refused: the person did not approve it.')
        }
        approval = { by: 'person', at: Date.now() }
      }
      this.#live(scope)
      const checkAuthority = binding ? async () => {
        this.#live(scope)
        if (!this.port.guardedMerge?.(scope) || this.port.mergeGeneration?.() !== generation || this.port.mergeFence?.(scope, target) !== fence) return false
        const current = await this.port.mergeAuthority?.(scope, target)
        this.#live(scope)
        return this.port.mergeGeneration?.() === generation && this.port.mergeFence?.(scope, target) === fence && !!current && current.repository === binding.repository && current.number === binding.number && current.head === binding.head && current.baseRef === binding.baseRef && current.baseTip === binding.baseTip
      } : undefined
      const beforeSpawn = () => {
        this.#live(scope)
        if (binding && (this.port.mergeGeneration?.() !== generation || this.port.mergeFence?.(scope, target) !== fence)) throw new Error('The merge authority changed before submission. Start a fresh review.')
      }
      return { output: await gateway.mergePullRequest({ ...args, repository, requester, steeredFrom: gitSteerContext.getStore()?.command, approval, beforeWrite: this.#beforeWrite(scope, gateway, checkout.root, checkout.cwd, repository), beforeSpawn, ...(binding ? { reviewedTarget: binding, checkAuthority } : {}) }), repository }
    },
  }
  async review(args: ForgeReview, scope: ForgeScope): Promise<ForgeWriteResult> {
    const { gateway, checkout, requester, repository } = await this.#destination(scope, 'review', args)
    this.#live(scope)
    return { output: await gateway.review({ ...args, repository, requester, steeredFrom: gitSteerContext.getStore()?.command, beforeWrite: this.#beforeWrite(scope, gateway, checkout.root, checkout.cwd, repository) }), repository }
  }
  async comment(args: ForgeComment, scope: ForgeScope): Promise<ForgeWriteResult> {
    const { gateway, checkout, requester, repository } = await this.#destination(scope, 'comment', args)
    this.#live(scope)
    return { output: await gateway.comment({ ...args, repository, requester, steeredFrom: gitSteerContext.getStore()?.command, beforeWrite: this.#beforeWrite(scope, gateway, checkout.root, checkout.cwd, repository) }), repository }
  }
  async repository(scope: ForgeScope): Promise<string | null> {
    return (await this.#context(scope, 'repository', {})).repository
  }
  async associatedPullRequest(scope: ForgeScope): Promise<ForgeAssociatedPullRequest> {
    const { gateway, checkout, requester, repository } =
      await this.#context(scope, 'associatedPullRequest', {})
    if (scope.actor !== 'agent' || requester.kind !== 'session' || !requester.conversation) {
      throw new Error('A live agent conversation is required to resolve its pull request.')
    }
    if (!repository) {
      throw new Error('This project has no pinned repository. Call git_push and approve its repository first.')
    }
    const checkDestination = async (): Promise<void> => {
      this.#live(scope)
      if (await gateway.pins.pinned(checkout.root) !== repository ||
          !await gateway.originMatches(checkout.cwd, repository)) {
        throw new Error('git-gateway-repository-changed: The pinned repository or checkout origin changed.')
      }
      this.#live(scope)
    }
    await checkDestination()
    const result = await gateway.associatedPullRequest(repository, {
      runtime: requester.conversation.runtime,
      sessionId: requester.conversation.sessionId,
    }, scope.signal)
    await checkDestination()
    return result
  }
  async record(args: ForgeRecordQuery, scope: ForgeScope) {
    const { gateway, repository } = await this.#context(scope, 'record', args)
    return repository ? gateway.record({ ...args, repository, limit: args.limit ?? 100 }) : []
  }
  async attribute(args: ForgeAttribute, scope: ForgeScope) {
    const { gateway, repository } = await this.#context(scope, 'attribute', args)
    return repository ? gateway.attribute(repository, args.branch, args.sha) : 'outside' as const
  }

  /** The standing instruction for an agent, or nothing when the tools it names are not offered. */
  instructions(): string {
    return this.port.toolsOffered() ? FORGE_INSTRUCTION : ''
  }

  async seat(scope: ForgeScope): Promise<ForgeSeat | null> {
    if (!scope.runtime || !scope.sessionId) return null
    const agent = this.port.agentOf(scope.runtime)
    if (!agent) return null
    const options = this.port.optionsOf(scope.runtime, scope.sessionId)
    if (options === null) return null
    return { ...seatOf(agent.name, options, agent.version), ...this.port.teamOf?.(scope.runtime, scope.sessionId) }
  }

  /**
   * How the desk reaches the forge right now: the person's `gh`, as whom.
   * Cached for a while — every publication asks — and asked once at a time,
   * so a burst of tool calls does not fan out into a burst of API calls.
   */
  async identity(_scope?: ForgeScope): Promise<ForgeIdentity> {
    const now = Date.now()
    if (this.#identity && now - this.#identity.at < this.#identityTtlMs) return this.#identity.value
    if (this.#asking) return this.#asking
    this.#asking = this.#askGh().then((value) => {
      this.#identity = { at: Date.now(), value }
      this.#asking = null
      return value
    })
    return this.#asking
  }

  async #askGh(): Promise<ForgeIdentity> {
    const result = await this.#gh(['api', 'user', '--jq', '.login'])
    const login = result.stdout.trim()
    if (result.exitCode === 0 && login !== '') {
      return { via: 'gh', login, available: true, reason: null }
    }
    const said = `${result.stderr} ${result.stdout}`.trim()
    const reason =
      /ENOENT|not found|spawn gh/i.test(said) || said === ''
        ? 'gh is not installed, or not on the PATH HarnessDesk was started with.'
        : NOT_SIGNED_IN.test(said)
          ? 'gh is not signed in: run `gh auth login`.'
          : said.split('\n')[0] ?? 'gh could not answer.'
    return { via: 'gh', login: null, available: false, reason }
  }

  /** Forgets the cached identity — after a sign-in the desk drove, say. */
  forgetIdentity(): void {
    this.#identity = null
  }

  /**
   * Whether the calling conversation may put words on the forge now. An
   * embargo, in addition to every permission and ceiling: a Seat reviewing in
   * a blind round that has not closed publishes nothing — its findings go out
   * with the round, together. A call that names no conversation cannot be a
   * blind reviewer's, and is answered by the gates that already hold it.
   */
  async publicationAllowed(scope: ForgeScope): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!scope.runtime || !scope.sessionId) return { ok: true }
    const reason = this.port.embargoOf?.(scope.runtime, scope.sessionId) ?? null
    return reason === null ? { ok: true } : { ok: false, reason }
  }

  async publish(reference: ForgeReference, scope: ForgeScope): Promise<void> {
    if (!scope.runtime || !scope.sessionId) {
      throw new Error('A publication is recorded against a conversation, and this call named none.')
    }
    // The supervisor checks a child's reference at its boundary; this is the
    // same check for a built-in, which reaches the plane directly.
    if (!isForgeReference(reference)) {
      throw new Error('The publication is not a forge reference: kind, repo, number, url and via are required, in their types.')
    }
    await this.port.posted?.(reference).catch(() => {})
    const now = Date.now()
    const item: PublicationItem = {
      id: itemId(`publication-${randomUUID()}`),
      type: 'publication',
      reference,
      startedAt: now,
      completedAt: now,
    }
    if (!this.port.record(scope.runtime, scope.sessionId, item)) {
      throw new Error(`No conversation ${scope.sessionId} is open on ${scope.runtime} to record the publication in.`)
    }
  }
}
