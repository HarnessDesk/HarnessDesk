import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { LEAD_LIMITS, type GoalView, type FlowPreview, type LeadAcceptanceContract, type LeadPermissionPolicy, type LeadProject, type Sha } from '@harnessdesk/protocol'
import { createLeadJournal, leadBudgetProjection, leadDraftCaps, LEAD_MESSAGES_DEFAULTS, LEAD_REVIEWED_RESULT, parseLeadSeatChoices,
  type LeadAcceptanceEvidence, type LeadJournal, type LeadState, type LeadPermissionCall, type LeadResolvedTool, type LeadSeatChoices, type MessagesPrice } from '@harnessdesk/lead'
import { readChecksAt } from '../evidence/checks-file.js'
import { atomicJson } from '../goals/store.js'
import { LeadFileJournal } from './journal.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { rawPushUrl, githubRepositoryFromUrl, HARDENED_GIT_CONFIG } from '../git-hardening.js'
import { leadRefusal } from './controls.js'

/** Price per million tokens in micro-dollars, per model the Lead may be set to. An unlisted model is
 * refused before a request, so a typo in Settings cannot bill at a guessed rate. */
export const LEAD_PRICES: Readonly<Record<string, MessagesPrice>> = Object.freeze({
  [LEAD_MESSAGES_DEFAULTS.model]: { inputUsdMicrosPerMillion: 2_000_000, outputUsdMicrosPerMillion: 10_000_000,
    cacheReadUsdMicrosPerMillion: 200_000, cacheWriteUsdMicrosPerMillion: 2_500_000 },
})
/** One thread per desk in this slice; its journal lives under the host's own state directory. */
export const LEAD_THREAD = 'desk'
export type LeadPlanUnfit = 'lead-plan-unseatable' | 'lead-plan-not-independent'
/** A new desk's first goal: the spending limit Off (the portable ceiling, which still trips the overflow stop) and
 * the round cap, which is not optional. */
export const LEAD_DEFAULT_CAPS = Object.freeze({ usdMicros: LEAD_LIMITS.maxUsdMicros, rounds: 16 })
/** The dollar cap every desk started with before the spending limit could be Off. */
export const LEAD_LEGACY_DEFAULT_USD_MICROS = 1_000_000
/**
 * The limit a desk that predates the setting migrates to, recorded once. Money stays out of sight until it blocks
 * work, so the default is Off: a desk whose standing caps (what the next goal starts from) still hold exactly the old
 * default never chose a figure and becomes Off, as does a new desk. Any other figure was chosen, through Settings or
 * an approved plan, and is kept as the person's limit. The goal in hand is widened to Off only while its cap is still
 * the untouched default and no plan with that figure on its card was approved; otherwise it keeps its cap to its end.
 */
export const leadSpendLimitMigration = (state: LeadState): { readonly usdMicros: number | null; readonly applyToGoal: boolean } => {
  const standing = state.raisedFrom ?? state.budget?.caps
  if (!standing || !state.budget) return { usdMicros: null, applyToGoal: false }
  // The ceiling is what Off means now, so a desk that already stood at it was never limited below it.
  if (standing.usdMicros >= LEAD_LIMITS.maxUsdMicros) return { usdMicros: null, applyToGoal: false }
  if (standing.usdMicros !== LEAD_LEGACY_DEFAULT_USD_MICROS) return { usdMicros: standing.usdMicros, applyToGoal: false }
  return { usdMicros: null, applyToGoal: state.contract === null && state.budget.caps.usdMicros === LEAD_LEGACY_DEFAULT_USD_MICROS &&
    !['accepted', 'declined'].includes(state.phase) }
}
const FRESHNESS_MS = 60_000
const PROJECT_FILE = 'project.json'

export const leadContractDigest = (value: LeadAcceptanceContract): string => {
  const { digest: _digest, ...scope } = value
  return createHash('sha256').update(JSON.stringify(scope, (_key, value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)).digest('hex')
}

/** The digest every plan is frozen with: sha256 of its canonical JSON, the way the approval cards name it. */
export const freezeLeadPlan = async (value: LeadAcceptanceContract): Promise<LeadAcceptanceContract> => {
  if (value.steps.some(step => step.flow !== 'lead-reviewed-result' || step.sourceRevision !== LEAD_REVIEWED_RESULT.revision))
    throw Object.assign(new Error('lead-plan-refused'), { wireCode: 'lead-plan-refused' })
  let publicationRepository: string | null = null
  try {
    const { stdout } = await promisify(execFile)('git', ['-C', value.project.path, ...HARDENED_GIT_CONFIG, 'remote'], { timeout: 20_000 })
    const remotes = stdout.trim().split('\n').filter(Boolean)
    const remote = remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0]! : ''
    if (remote) publicationRepository = githubRepositoryFromUrl(await rawPushUrl(value.project.path, remote))
  } catch { /* A local-only plan grants no publication destination. */ }
  const pinned = { ...value, publicationRepository }
  return { ...pinned, digest: leadContractDigest(pinned) }
}

/** A project's identity is its path, so a restart names the same project without storing anything else. */
export const leadProjectOf = (path: string): LeadProject => ({ id: `project-${createHash('sha256').update(path).digest('hex').slice(0, 16)}`, path })

/** Passive lookup shared by boot restoration and control reads; never creates a service or pins a selection. */
export const readRememberedLeadProject = async (home: string): Promise<LeadProject | null> => {
  let text: string
  try { text = await readFile(join(home, 'lead', PROJECT_FILE), 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    (value as { version?: unknown }).version !== 1 || typeof (value as { path?: unknown }).path !== 'string' ||
    !isAbsolute((value as { path: string }).path)) throw new Error('The remembered Lead project cannot be read safely.')
  return leadProjectOf((value as { path: string }).path)
}

type Fact = { readonly id: string; readonly fact: { readonly kind: string; readonly at?: string; readonly verdict?: string; readonly exit?: number | null; readonly timedOut?: boolean; readonly dirty?: boolean; readonly counted?: boolean; readonly name?: string; readonly run?: string; readonly digest?: string } }
type Card = { readonly card: number; readonly facts: readonly { readonly record: Fact; readonly freshness: { readonly state: string } }[] }

/** Evidence for one run at the revision its last review saw, from facts read through the host's gate right
 * now. Missing facts stay absent; stale and incomplete facts retain their own validity:
 * nothing here starts a check, tolerates a failed read or invents a figure. */
export const readLeadEvidence = async (journal: Pick<LeadJournal, 'state'>, runId: string,
  read: (call: LeadPermissionCall) => Promise<unknown>, now: () => number): Promise<LeadAcceptanceEvidence> => {
  const state = journal.state, contract = state.contract, owned = state.runs.find(one => one.runId === runId)
  const project = contract?.project ?? { id: '', path: '' }
  const unknown = (revision: string): LeadAcceptanceEvidence => ({ project, runId, contractDigest: contract?.digest ?? '', revision,
    observedAt: now(), complete: false, spendComplete: false, checks: [], reviews: [], findingsComplete: false, findings: [], diffs: [] })
  if (!contract || !owned || !state.budget) return unknown('')
  const execution = await read({ method: 'flow/execution', params: { run: runId } }) as { rounds?: { cards: number[] }[] }
  const cardIds = new Set((execution.rounds ?? []).flatMap(round => round.cards))
  const evidence = await read({ method: 'evidence/board', params: { room: owned.teamId } }) as { cards: Card[] }
  const board = await read({ method: 'goal/read', params: { goal: owned.teamId } }) as Pick<GoalView, 'board'>
  const recorded = evidence.cards.filter(card => cardIds.has(card.card)).flatMap(card => card.facts.map(one => ({ ...one, card: card.card })))
  // Older rounds remain evidence of an attempt; prefer a fact at the subject
  // revision for each question, without hiding a stale-only question.
  const revision = recorded.filter(one => one.record.fact.kind === 'review').at(-1)?.record.fact.at ?? ''
  const latest = new Map<string, (typeof recorded)[number]>()
  for (const one of recorded) {
    const key = `${one.record.fact.kind}:${one.record.fact.name ?? ''}`
    const before = latest.get(key)
    if (!before || one.record.fact.at === revision || before.record.fact.at !== revision) latest.set(key, one)
  }
  // A re-review replaces the earlier review round, including at the same commit.
  // Retain every reviewer within that round, rather than just its last fact.
  const reviewRound = [...(execution.rounds ?? [])].reverse().find(round => recorded.some(one => round.cards.includes(one.card) && one.record.fact.kind === 'review'))
  const reviewRecords = recorded.filter(one => one.record.fact.kind === 'review' && reviewRound?.cards.includes(one.card))
  const currentReviews = reviewRecords.filter(one => one.record.fact.at === revision)
  const facts = [...[...latest.values()].filter(one => one.record.fact.kind !== 'review'), ...(currentReviews.length ? currentReviews : reviewRecords)]
  const findings = await read({ method: 'finding/run', params: { goal: owned.teamId, run: runId } }) as { embargoed: boolean; blocking: boolean }
  const observedAt = now()
  const assertionOf = (kind: string, name?: string) => contract.assertions.find(one => one.kind === kind && one.id === name)?.id ??
    contract.assertions.find(one => one.kind === kind)?.id
  const needsCheck = contract.assertions.some(one => one.kind === 'check')
  const declared = needsCheck && revision ? await readChecksAt(project.path, revision as Sha) : null
  const checkRecords = facts.filter(one => one.record.fact.kind === 'check' &&
    (!declared || declared.checks.some(check => check.name === one.record.fact.name)))
  const matches = (record: Fact, check: { name: string; run: string }) => record.fact.name === check.name &&
    record.fact.run === check.run && record.fact.digest === declared?.digest
  const checks = checkRecords.map(one => {
    const { record } = one, assertionId = assertionOf('check', record.fact.name) ?? 'check'
    const required = declared?.checks.filter(check => assertionOf('check', check.name) === assertionId) ?? []
    return { assertionId, name: record.fact.name, id: record.id, revision: record.fact.at ?? '', observedAt,
      complete: one.freshness.state === 'fresh' && !!declared?.digest && declared.problems.length === 0 &&
        required.some(check => matches(record, check)) && required.every(check => checkRecords.some(other => matches(other.record, check))),
      exit: record.fact.exit ?? null, timedOut: record.fact.timedOut === true, dirty: record.fact.dirty === true, counted: record.fact.counted === true }
  })
  const reviewFacts = facts.flatMap(one => one.record.fact.kind === 'review' ? [{ assertionId: assertionOf('review') ?? 'review',
    id: one.record.id, revision: one.record.fact.at ?? '', observedAt, verdict: one.record.fact.verdict ?? '',
    complete: one.freshness.state === 'fresh' && board.board.intents.some(card => card.id === one.card && card.state === 'done'),
    text: [board.board.intents.find(card => card.id === one.card)?.note, board.board.intents.find(card => card.id === one.card)?.handoff].filter(Boolean).join('\n'),
  }] : [])
  // Completeness is about the reads, not whether their verdicts passed. Keep
  // stale facts so the evaluator can distinguish them from absent facts.
  const complete = !findings.embargoed
  return { project, runId, contractDigest: contract.digest, revision, observedAt, complete,
    spendComplete: leadBudgetProjection(state.budget, observedAt).spend === 'known', checks, reviews: reviewFacts,
    findingsComplete: !findings.embargoed, findings: findings.blocking ? [{ id: `${runId}:blocking`, revision, blocking: true, resolved: false }] : [], diffs: [] }
}

/** Whether a runtime may be named in a Lead plan: one that answers now, or one stopped while idle that seating starts
 * on demand. A runtime that cannot start (not installed, crashed) is never offered. */
/**
 * What a held preview of one plan step says about the plan, before providers are compared: a seat passed over
 * only because its provider matches, or cannot be told from, the one it must be independent of is the
 * independence answer (the fix is another provider); any other seat that cannot hold is unseatable.
 */
export const leadPreviewUnfit = (preview: FlowPreview | null): LeadPlanUnfit | null => {
  if (preview?.seats.some(seat => seat.plan.winner === null && seat.plan.candidates.length > 0 &&
    seat.plan.candidates.every(candidate => candidate.reason?.kind === 'sameProvider' || candidate.reason?.kind === 'unknownProvider'))) return 'lead-plan-not-independent'
  if (!preview || preview.token === null || preview.seats.length === 0 ||
    preview.seats.some(seat => seat.plan.blocked || seat.plan.ceiling?.hold !== 'held' || seat.plan.winner === null)) return 'lead-plan-unseatable'
  return null
}
export const leadSeatable = (health: { readonly state: string }): boolean =>
  health.state === 'ready' || health.state === 'idle' || health.state === 'starting'

/** What the Lead may name in a plan: every runtime that answers now or starts on demand, once for each role. The host still
 * checks a plan against its real seating before a card and again before a start. */
export const leadSeatChoices = (ready: readonly string[]): LeadSeatChoices | undefined =>
  ready.length === 0 ? undefined : parseLeadSeatChoices({ implement: ready.map(runtime => ({ runtime })), review: ready.map(runtime => ({ runtime })) })

export interface LeadAssemblyOptions {
  /** The host's state directory (`HARNESSDESK_HOME`); the journal and the chosen project live under it. */
  readonly home: string
  /** The folder the person last opened, or null when none is open. */
  readonly workspace: () => Promise<string | null>
  readonly readySeats: () => readonly string[]
  /** Why one planned step could never reach an accepted result, or null when it can: a seat that cannot hold the
   * ceiling its role is given (read from the same held preview a start redeems), or a review that cannot be shown
   * to come from another provider than the implementer's. Absent, a plan is frozen without asking. */
  readonly seatsHold?: (root: string, step: LeadAcceptanceContract['steps'][number]) => Promise<LeadPlanUnfit | null>
  /** One held preview the Lead's start may redeem: its token, source and expiry, or null. */
  readonly heldPreview: (token: string) => { readonly source: string; readonly expiresAt: number } | null
  readonly now: () => number
  /** Builds the service and its window controls for this journal and project (`Host.createLeadService`). */
  readonly create: (inputs: { readonly journal: LeadJournal; readonly project: LeadProject; readonly model: string
    readonly seats?: LeadSeatChoices; readonly prices: Readonly<Record<string, MessagesPrice>>
    readonly resolveTool: (call: LeadPermissionCall) => Promise<LeadResolvedTool>
    readonly freezePlan: typeof freezeLeadPlan
    readonly readEvidence: (runId: string, read: (call: LeadPermissionCall) => Promise<unknown>) => Promise<LeadAcceptanceEvidence> }) => Promise<void>
  readonly onError?: (error: unknown) => void
}

/** Builds the Lead once, the first time any `lead/*` method needs it, and never when the feature is off (the
 * host constructs this object only then). The project is the folder open at that moment and is remembered,
 * so a restart reopens the same thread rather than asking again. */
export class LeadAssembly {
  #built: Promise<void> | null = null
  #storage: LeadFileJournal | null = null
  constructor(private readonly options: LeadAssemblyOptions) {}

  ensure(project?: string): Promise<void> {
    this.#built ??= this.#build(project).catch((error: unknown) => { this.#built = null; throw error })
    return this.#built
  }

  /** Only the host's serialized idle automatic entry changes this before drafting a new goal. */
  async rememberProject(path: string): Promise<void> {
    if (!isAbsolute(path)) throw new Error('lead-project-missing')
    await mkdir(join(this.options.home, 'lead'), { recursive: true, mode: 0o700 })
    await atomicJson(join(this.options.home, 'lead', PROJECT_FILE), { version: 1, path })
  }

  /** A persisted thread restores its host watches at boot, without a provider request or a new goal. */
  async restore(): Promise<void> {
    if (await readRememberedLeadProject(this.options.home)) await this.ensure()
  }

  /** Releases the journal's lease once the host has closed the service; a restart reopens the same thread. */
  async close(): Promise<void> {
    await this.#built?.catch(() => {})
    const storage = this.#storage
    this.#storage = null
    await storage?.close()
  }

  async #project(preferred?: string): Promise<LeadProject> {
    const file = join(this.options.home, 'lead', PROJECT_FILE)
    const remembered = await readRememberedLeadProject(this.options.home)
    if (remembered) return remembered
    const path = preferred ?? await this.options.workspace()
    if (!path) throw leadRefusal('lead-project-missing')
    await mkdir(join(this.options.home, 'lead'), { recursive: true, mode: 0o700 })
    const temporary = `${file}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify({ version: 1, path }), { mode: 0o600 })
    await rename(temporary, file)
    return leadProjectOf(path)
  }

  async #build(preferred?: string): Promise<void> {
    const { options } = this
    const project = await this.#project(preferred)
    const storage = await LeadFileJournal.open(options.home, LEAD_THREAD)
    this.#storage = storage
    const journal = await createLeadJournal(storage)
    if (!journal.state.policy) await journal.setPolicy({ version: 1, revision: 1, mode: 'manage', rules: [] } satisfies LeadPermissionPolicy)
    if (journal.state.spendLimit === null) {
      const migrated = leadSpendLimitMigration(journal.state)
      await journal.recordSpendLimit(migrated.usdMicros, migrated.applyToGoal, options.now())
    }
    if (!journal.state.budget) await journal.updateBudget({ version: 1, type: 'initialize', now: options.now(), logicalGoalId: 'lead-goal',
      caps: leadDraftCaps(journal.state.spendLimit, LEAD_DEFAULT_CAPS), freshnessMs: FRESHNESS_MS })
    const seats = leadSeatChoices(options.readySeats())
    await options.create({ journal, project, model: LEAD_MESSAGES_DEFAULTS.model, prices: LEAD_PRICES,
      ...(seats ? { seats } : {}),
      // A plan whose seats cannot hold their ceilings would only fail at its start, after the person approved it.
      freezePlan: async contract => {
        if (contract.steps.some(step => step.flow !== 'lead-reviewed-result' || step.sourceRevision !== LEAD_REVIEWED_RESULT.revision))
          throw Object.assign(new Error('lead-plan-refused'), { wireCode: 'lead-plan-refused' })
        for (const step of contract.steps) {
          const unfit = await options.seatsHold?.(project.path, step)
          if (unfit) throw Object.assign(new Error(unfit), { wireCode: unfit })
        }
        // The card shows the dollars the plan will run with: the person's limit, never the Lead's own figure above it.
        return freezeLeadPlan({ ...contract, caps: leadDraftCaps(journal.state.spendLimit, contract.caps) })
      },
      resolveTool: async call => {
        const state = journal.state, params = call.params as Record<string, unknown>
        const current = state.steps.find(item => item.state === 'pending') ?? state.steps.find(item => item.state === 'admitted') ?? state.steps.at(-1)
        const step = state.contract?.steps.find(one => one.id === current?.id) ?? null
        const preview = call.method === 'flow/start-goal' && typeof params['token'] === 'string' ? options.heldPreview(params['token']) : null
        return { project, runId: typeof params['run'] === 'string' ? params['run'] : null, start: call.method === 'flow/start-goal' ? step : null,
          stepId: call.method.startsWith('lead/chat/') ? null : step?.id ?? null, ...(preview ? { preview: { token: params['token'] as string, ...preview } } : {}),
          context: { desk: state.policy!, projectPolicy: null, project, approved: null, budget: null, now: options.now(), policyInterpretation: 'idle' } }
      },
      readEvidence: (runId, read) => readLeadEvidence(journal, runId, read, options.now) })
  }
}
