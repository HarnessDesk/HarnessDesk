import { Service, type Context } from '@deepseek-ai/cordis'

import type { ForgeAssociatedPullRequest, ForgePush, ForgeCreate, ForgeUpdate, ForgeMerge, ForgeReview, ForgeComment, ForgeRecordQuery, ForgeAttribute, ForgeRequester, ForgeGitEntry, ForgeWriteResult, ForgeVerb, ForgeReference, ScopeQuery } from '@harnessdesk/protocol'

import { currentBrowserIdentity } from './browser-scopes.js'
import { invocationScope } from './forge-invocation.js'

import type { HostRuntime } from './runtime.js'

/** The host owns forge writes and credentials; plugins receive a scoped capability.
 * Signing and transcript publication retain the original publish grant. */

export interface ForgeSeat {
  readonly role: string | null
  readonly round: number | null
  readonly team: string | null
  /** The agent's presentation name — "Codex", "Gemini CLI" — never a runtime id. */
  readonly agent: string
  /** The agent's own version, when it said one. */
  readonly version: string | null
  /**
   * The model by the agent's own label, or null when the agent's choice is
   * its automatic one: "Gemini CLI", not "Gemini CLI Auto".
   */
  readonly model: string | null
  /** The effort level's label, when the seat has one and it is set. */
  readonly effort: string | null
  readonly thinking: boolean
  /** The seat as one label — "Codex GPT-5.6-Sol · High" — for a template's `{seat}`. */
  readonly label: string
}

export interface ForgeIdentity {
  /** How the desk reaches the forge right now. */
  readonly via: 'gh' | 'app'
  /** The forge login it publishes as, when it can say. */
  readonly login: string | null
  /** False when the forge cannot be reached from this desk — with the reason. */
  readonly available: boolean
  readonly reason: string | null
}

export interface ForgeScope {
  readonly actor?: 'agent' | 'human' | 'context'
  readonly turnId?: string
  readonly runtime?: string
  readonly sessionId?: string
  /** Host-owned invocation lifetime, never a tool argument. */
  readonly invocation?: string
  readonly signal?: AbortSignal
  /** Which plugin instance is calling; stamped by the service. */
  readonly plugin?: string
}

export type { ForgeAssociatedPullRequest, ForgePush, ForgeCreate, ForgeUpdate, ForgeMerge, ForgeReview, ForgeComment, ForgeRecordQuery, ForgeAttribute, ForgeRequester, ForgeGitEntry, ForgeWriteResult, ForgeVerb } from '@harnessdesk/protocol'

/** Shared by the in-process service and the untrusted child IPC boundary. */
export function validateForgeArgs(verb: ForgeVerb, input: unknown): void {
  const fail = () => { throw new Error('Invalid forge ' + verb + ' arguments.') }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail()
  const v = input as Record<string, unknown>
  const text = (x: unknown): x is string => typeof x === 'string' && !x.includes('\0')
  const sha = (x: unknown) => typeof x === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(x)
  const branch = (x: unknown) => text(x) && !!x && !x.startsWith('-') && !x.startsWith('/') && !x.endsWith('/') && !x.endsWith('.') &&
    x !== '@' && !/[\x00-\x20\x7f~^:?*\[\\]/.test(x) && !x.includes('..') && !x.includes('@{') && !x.includes('//') &&
    x.split('/').every(part => !part.startsWith('.') && !part.endsWith('.lock'))
  const allowed: Record<ForgeVerb, string[]> = { push: ['branch', 'sha', 'expect'], create: ['head', 'base', 'title', 'body', 'draft'],
    update: ['number', 'title', 'body', 'base'], merge: ['number', 'head', 'method', 'body'], review: ['number', 'event', 'body'],
    comment: ['subject', 'number', 'body'], record: ['branch', 'number', 'limit'], attribute: ['branch', 'sha'], repository: [], associatedPullRequest: [] }
  if (Object.keys(v).some(key => !allowed[verb].includes(key))) return fail()
  if (['update', 'merge', 'review', 'comment'].includes(verb) && (!Number.isSafeInteger(v.number) || Number(v.number) < 1)) return fail()
  if (v.number !== undefined && (!Number.isSafeInteger(v.number) || Number(v.number) < 1)) return fail()
  for (const key of ['title', 'body']) if (v[key] !== undefined && !text(v[key])) return fail()
  if (v.title !== undefined && !(v.title as string).trim()) return fail()
  for (const key of ['branch', 'base']) if (v[key] !== undefined && !branch(v[key])) return fail()
  if (verb === 'create' && (!branch(v.head) || !text(v.title) || !v.title.trim() || !text(v.body) || v.draft !== undefined && typeof v.draft !== 'boolean')) return fail()
  if (verb === 'update' && v.title === undefined && v.body === undefined && v.base === undefined) return fail()
  if (verb === 'push') {
    const expect = v.expect as { head?: unknown } | null
    if (!branch(v.branch) || !sha(v.sha) || v.expect !== 'create' && (!expect || typeof expect !== 'object' || Object.keys(expect).length !== 1 || !sha(expect.head))) return fail()
  }
  if (verb === 'attribute' && (!branch(v.branch) || !sha(v.sha))) return fail()
  if (verb === 'merge' && (!sha(v.head) || (typeof v.method !== 'string' || !['squash', 'merge', 'rebase'].includes(v.method)))) return fail()
  if (verb === 'review' && ((typeof v.event !== 'string' || !['approve', 'request-changes', 'comment'].includes(v.event)) || !text(v.body))) return fail()
  if (verb === 'comment' && ((typeof v.subject !== 'string' || !['pullRequest', 'issue'].includes(v.subject)) || !text(v.body))) return fail()
  if (v.limit !== undefined && (!Number.isSafeInteger(v.limit) || Number(v.limit) < 1 || Number(v.limit) > 1000)) return fail()
}

export interface ForgeEngine {
  repository(scope: ForgeScope): Promise<string | null>
  associatedPullRequest(scope: ForgeScope): Promise<ForgeAssociatedPullRequest>
  push(args: ForgePush, scope: ForgeScope): Promise<ForgeWriteResult>
  readonly pullRequest: {
    create(args: ForgeCreate, scope: ForgeScope): Promise<ForgeWriteResult>
    update(args: ForgeUpdate, scope: ForgeScope): Promise<ForgeWriteResult>
    merge(args: ForgeMerge, scope: ForgeScope): Promise<ForgeWriteResult>
  }
  review(args: ForgeReview, scope: ForgeScope): Promise<ForgeWriteResult>
  comment(args: ForgeComment, scope: ForgeScope): Promise<ForgeWriteResult>
  record(args: ForgeRecordQuery, scope: ForgeScope): Promise<readonly ForgeGitEntry[]>
  attribute(args: ForgeAttribute, scope: ForgeScope): Promise<ForgeRequester | 'outside'>
  /** The seat of the calling conversation, or null when the scope names none the host holds. */
  seat(scope: ForgeScope): Promise<ForgeSeat | null>
  /**
   * How the desk reaches the forge. The answer names no conversation; the
   * scope is there because every forge verb rides the invocation it was
   * called from, so that a plugin in the shared child cannot reach any of
   * them by speaking the wire protocol between invocations.
   */
  identity(scope: ForgeScope): Promise<ForgeIdentity>
  /** Records what the calling conversation published, into its transcript. */
  publish(reference: ForgeReference, scope: ForgeScope): Promise<void>
  /**
   * Whether the calling conversation may put words on the forge now: an
   * embargo decided by the host — a blind review round still open — in
   * addition to, never instead of, the permission and ceiling gates. Asked
   * before every forge mutation, with the same trusted invocation scope.
   */
  publicationAllowed(scope: ForgeScope): Promise<{ ok: true } | { ok: false; reason: string }>
}

const state: { engine: ForgeEngine | null } = { engine: null }

export const setForgeEngine = (engine: ForgeEngine | null): void => {
  state.engine = engine
}

const engine = (): ForgeEngine => {
  const found = state.engine
  if (!found) {
    throw new Error('This process has no forge plane: `ctx.forge` needs a running HarnessDesk host.')
  }
  return found
}

const asForgeScope = (scope: ScopeQuery | undefined, plugin: string): ForgeScope => {
  const trusted = invocationScope(plugin, scope)
  const identity = currentBrowserIdentity()
  const answer = { ...trusted.scope, actor: trusted.actor, plugin, ...(identity ? { invocation: identity.invocation } : {}) }
  Object.defineProperty(answer, 'signal', { value: trusted.signal, enumerable: false })
  return answer
}

export class ForgeService extends Service {
  static [Service.tracker] = { associate: 'forge', property: 'ctx' }

  constructor(
    ctx: Context,
    private readonly runtime: HostRuntime,
  ) {
    super(ctx, 'forge')
  }

  /** The permission and the identity of the asker, in one step, for the reason the team service does it. */
  private gate(write = false): string {
    const owner = this.runtime.owner(this.ctx)
    owner.gate.assertForge(write)
    return String(owner.instanceId)
  }

  private callScope(verb: ForgeVerb, args: unknown, scope?: ScopeQuery): ForgeScope {
    const reads: readonly ForgeVerb[] = ['record', 'attribute', 'repository', 'associatedPullRequest']
    const plugin = this.gate(!reads.includes(verb))
    const trusted = asForgeScope(scope, plugin)
    validateForgeArgs(verb, args)
    if (!reads.includes(verb) && trusted.actor === 'context') throw new Error('Context resolution cannot write to the forge.')
    return trusted
  }
  async repository(scope?: ScopeQuery): Promise<string | null> {
    return engine().repository(this.callScope('repository', {}, scope))
  }
  async associatedPullRequest(scope?: ScopeQuery): Promise<ForgeAssociatedPullRequest> {
    return engine().associatedPullRequest(this.callScope('associatedPullRequest', {}, scope))
  }
  async push(args: ForgePush, scope?: ScopeQuery): Promise<ForgeWriteResult> {
    args = structuredClone(args)
    return engine().push(args, this.callScope('push', args, scope))
  }
  // A getter preserves Cordis's caller context for the nested capability.
  get pullRequest() {
    return {
      create: async (args: ForgeCreate, scope?: ScopeQuery): Promise<ForgeWriteResult> => {
        args = structuredClone(args)
        return engine().pullRequest.create(args, this.callScope('create', args, scope))
      },
      update: async (args: ForgeUpdate, scope?: ScopeQuery): Promise<ForgeWriteResult> => {
        args = structuredClone(args)
        return engine().pullRequest.update(args, this.callScope('update', args, scope))
      },
      merge: async (args: ForgeMerge, scope?: ScopeQuery): Promise<ForgeWriteResult> => {
        args = structuredClone(args)
        return engine().pullRequest.merge(args, this.callScope('merge', args, scope))
      },
    }
  }
  async review(args: ForgeReview, scope?: ScopeQuery): Promise<ForgeWriteResult> {
    args = structuredClone(args)
    return engine().review(args, this.callScope('review', args, scope))
  }
  async comment(args: ForgeComment, scope?: ScopeQuery): Promise<ForgeWriteResult> {
    args = structuredClone(args)
    return engine().comment(args, this.callScope('comment', args, scope))
  }
  async record(args: ForgeRecordQuery, scope?: ScopeQuery): Promise<readonly ForgeGitEntry[]> {
    args = structuredClone(args)
    return engine().record(args, this.callScope('record', args, scope))
  }
  async attribute(args: ForgeAttribute, scope?: ScopeQuery): Promise<ForgeRequester | 'outside'> {
    args = structuredClone(args)
    return engine().attribute(args, this.callScope('attribute', args, scope))
  }

  async seat(scope?: ScopeQuery): Promise<ForgeSeat | null> {
    const plugin = this.gate()
    return engine().seat(asForgeScope(scope, plugin))
  }

  async identity(scope?: ScopeQuery): Promise<ForgeIdentity> {
    const plugin = this.gate()
    return engine().identity(asForgeScope(scope, plugin))
  }

  async publish(reference: ForgeReference, scope?: ScopeQuery): Promise<void> {
    const plugin = this.gate()
    await engine().publish(reference, asForgeScope(scope, plugin))
  }

  async publicationAllowed(scope?: ScopeQuery): Promise<{ ok: true } | { ok: false; reason: string }> {
    const plugin = this.gate()
    return engine().publicationAllowed(asForgeScope(scope, plugin))
  }
}
