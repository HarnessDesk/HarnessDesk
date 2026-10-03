import { randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'

import {
  type AgentEntry,
  type CeilingLevel,
  type CompiledFlow,
  type FlowDocument,
  type FlowEvidenceGuard,
  type FlowPreview,
  type FlowPreviewSeat,
  type FlowProblem,
  type FlowSeat,
  type FlowRunOptions,
  type FlowStartTarget,
  type SeatPlan,
  type SeatReason,
  type StartContext,
} from '@harnessdesk/protocol'

import type { CheckRetry } from './flow-execution.js'
import { rolesAtPredecessor } from './flow-handed.js'
import { INDEPENDENT_PROVIDER, independentProviderReason } from './flow-provider.js'
import { checkGuardNames, compileFlowPolicy, parseFlowPolicy, reviewsIn } from './flow-policy.js'

/**
 * The dry run: a non-executing statement of what a flow would do, and the
 * one token `flow/start-goal` redeems.
 *
 * Nothing here opens a session, allocates a lane, sends a turn, runs a
 * command or creates a Goal — every read is the same kind `agent/seat/dry`
 * already makes, and the same absence of side effects is what lets a person
 * read this before pressing Start.
 *
 * The token authorizes exactly the frozen `(root, source, vars)` it was
 * minted for: `redeem` refuses a caller that supplies anything else, even a
 * token that is otherwise live. What only an open Goal or an open seat can
 * still prove — a brief's digest, a seat's actual runtime — remains
 * `FlowExecutions`'s own re-check at the moment it matters; this token
 * guards the text, not a repeated future read of the world.
 */

/** What the host reads to build one preview. */
export interface FlowPreviewPort {
  /** Refuses the project unless it is a folder or repository already open. Asked before anything else is read. */
  confine(root: string): Promise<void>
  /** The Agent roster this preview resolves against, project-first. */
  agents(root: string): Promise<readonly AgentEntry[]>
  /** One Agent's seat plan for the exact seats and grant a role names; `requireHeld` passes over every seat that cannot hold. */
  previewAgent(root: string, agent: string, seats: readonly FlowSeat[], grant: CeilingLevel, options?: { readonly unattended?: boolean; readonly requireHeld?: true; readonly includeCandidateCeilings?: true }): Promise<SeatPlan>
  /** Reads the provider a runtime would use in this checkout; null means independence cannot be proven. */
  providerOf?(runtime: string, cwd: string): Promise<string | null>
  /** The checkout whose runtime configuration an opened role would read. */
  checkoutPath?(root: string, lane: boolean): Promise<string>
  /** Predicts whether this candidate will get HarnessDesk's tool server in its actual flow checkout. */
  pluginToolsProblem?(runtime: string, root: string, lane: boolean): Promise<string | null>
  /** Whether this runtime asks per MCP tool and the host cannot answer for it. */
  perToolMcpApproval?(runtime: string): boolean
  /**
   * A front-door target read again from the host, as the canonical facts it
   * was bound to — commits, a diff, a working tree's snapshot. Asked at
   * redemption: a target that moved since the preview refuses the start.
   */
  resolveTarget?(context: StartContext): Promise<string>
  /** A retried check's own run: its saved source and inputs, read back for the equality check — never a new choice. */
  previewCheck?(run: string, card: number): Promise<CheckRetry>
  storedRun?(run: string): Promise<{ readonly source: string; readonly vars: Readonly<Record<string, string>>; readonly compiled?: CompiledFlow } | null>
  /**
   * The project's own declared checks (`.harnessdesk/checks.yml`), as the
   * commands they run — asked only when this flow's own roles leave a
   * `check:` evidence guard unexplained, since a guard may legitimately name
   * one of those instead of a check this flow declares (#1094).
   */
  projectChecks?(root: string): Promise<readonly string[]>
  now(): number
}

const TOKEN_TTL_MS = 10 * 60_000
export const CHANGED_PREVIEW = 'This flow or its seating changed. Review the dry run again before starting.'

interface HeldPreview {
  readonly root: string
  readonly source: string
  readonly vars: Readonly<Record<string, string>>
  readonly attended: boolean
  readonly overrides: NonNullable<FlowRunOptions['seats']>
  readonly compiled: CompiledFlow
  readonly seats: readonly FlowPreviewSeat[]
  readonly commands: FlowPreview['commands']
  readonly expires: number
  /** Set only for a check-retry preview: the finished or interrupted run/card this token is additionally bound to. */
  readonly retryCheck?: CheckRetry
  readonly retryOf?: { readonly run: string; readonly card: number }
  /** Set only for a front-door preview: the policy and target the start is bound to, read from here and never from a request. */
  readonly frontDoor?: FrontDoorBinding
  consumed: boolean
}

/**
 * What a front-door token binds beyond the text: every Seat must hold its
 * ceiling, the target's resolved facts, and the empty Goal it lands on at the
 * revision its preview saw (or none).
 */
export interface FrontDoorBinding {
  readonly requireHeld: true
  /**
   * `facts` is the canonical form a start compares against a fresh read;
   * `resolved` is what the run is handed — null for a plain project, which
   * works where the project is.
   */
  readonly target: { readonly context: StartContext; readonly facts: string; readonly resolved: FlowStartTarget | null }
  readonly goal: { readonly id: string; readonly revision: number } | null
}

/** The one comparable shape a token's fingerprint is taken of: the winning seat and its candidate, never the whole passed-over list. */
const fingerprint = (input: { compiled: CompiledFlow; seats: readonly FlowPreviewSeat[]; commands: FlowPreview['commands'] }): string =>
  JSON.stringify({
    compiled: input.compiled,
    commands: input.commands,
    seats: input.seats.map((seat) => ({
      role: seat.role, index: seat.index, agent: seat.agent, isolate: seat.isolate,
      blocked: seat.plan.blocked, winner: seat.plan.winner === null ? null : seat.plan.candidates[seat.plan.winner] ?? null,
      ceiling: seat.plan.ceiling,
    })),
  })

/** Why an old-format flow's preview carries no start token: the one thing that makes it startable here. */
export const LEGACY_START = 'This flow uses the old format, so it cannot start a new Goal. Update it from the project’s Flows list first.'

const emptyPreview = (problems: readonly FlowProblem[]): FlowPreview => ({
  token: null,
  compiled: { document: { format: 'legacy', flow: { name: '', roles: [], rules: [], inputs: [], seed: { role: '', title: '' }, wait: 0 } }, bindings: [], problems: [] },
  seats: [], commands: [], guards: [], messaging: 'board-only', problems,
})

const guardsOf = (compiled: CompiledFlow): FlowPreview['guards'] => {
  if (compiled.document.format !== 'agents') return []
  return compiled.document.flow.rules.map((rule) => ({
    rule: rule.id,
    unevidenced: !rule.when?.evidence?.length,
    requires: (rule.when?.evidence ?? []) as readonly FlowEvidenceGuard[],
  }))
}

const commandsOf = (root: string, compiled: CompiledFlow): FlowPreview['commands'] => {
  if (compiled.document.format !== 'agents') return []
  const out: { role: string; run: string; cwd: string; timeout: number }[] = []
  for (const role of compiled.document.flow.roles) {
    if (role.kind !== 'check') continue
    const cwd = role.check.cwd ? (isAbsolute(role.check.cwd) ? role.check.cwd : join(root, role.check.cwd)) : root
    out.push({ role: role.id, run: role.check.run, cwd, timeout: role.check.timeout })
  }
  return out
}

export class FlowPreviews {
  readonly #port: FlowPreviewPort
  #tokens = new Map<string, HeldPreview>()

  constructor(port: FlowPreviewPort) {
    this.#port = port
  }

  #sweep(): void {
    const now = this.#port.now()
    for (const [token, held] of this.#tokens) if (held.expires < now || held.consumed) this.#tokens.delete(token)
  }

  async preview(
    root: string,
    source: string,
    vars: Readonly<Record<string, string>> = {},
    retry?: { readonly run: string; readonly card: number },
    frontDoor?: FrontDoorBinding,
    options: FlowRunOptions = {},
  ): Promise<FlowPreview> {
    this.#sweep()
    options = structuredClone(options)
    await this.#port.confine(root)
    let actualSource = source
    let actualVars = vars
    let retryCompiled: CompiledFlow | undefined
    if (retry) {
      const saved = (await this.#port.storedRun?.(retry.run)) ?? null
      if (!saved) return emptyPreview([{ level: 'error', at: 'run', text: CHANGED_PREVIEW }])
      if (saved.source !== source || JSON.stringify(saved.vars) !== JSON.stringify(vars)) {
        return emptyPreview([{ level: 'error', at: 'run', text: CHANGED_PREVIEW }])
      }
      actualSource = saved.source
      actualVars = saved.vars
      retryCompiled = saved.compiled
    }
    if (retry && (frontDoor || options.attended !== undefined || Object.keys(options.seats ?? {}).length > 0)) return emptyPreview([{ level: 'error', at: 'run', text: CHANGED_PREVIEW }])
    let retryCheck: CheckRetry | undefined
    if (retry && this.#port.previewCheck) {
      try {
        retryCheck = await this.#port.previewCheck(retry.run, retry.card)
      } catch (error) {
        return emptyPreview([{ level: 'error', at: 'run', text: error instanceof Error ? error.message : String(error) }])
      }
    }
    const built = retryCheck && retryCompiled?.document.format === 'agents'
      ? { compiled: retryCompiled, seats: [], commands: [retryCheck.command], guards: [], messaging: retryCompiled.document.flow.messaging, problems: [] }
      : await this.#build(root, actualSource, options.attended === false, frontDoor !== undefined, null, options.seats)
    if (built.compiled.document.format === 'agents' && built.compiled.document.flow.base &&
      frontDoor && (frontDoor.goal || frontDoor.target.resolved)) {
      return { ...built, token: null, problems: [...built.problems, { level: 'error', at: 'base', text: 'A Flow with a remote base starts a new Goal from the project. Remove base to review a target or reuse a Goal.' }] }
    }
    const errors = built.problems.filter((one) => one.level === 'error')
    let token: string | null = null
    // An unparsed document is the empty legacy placeholder: never a token.
    if (errors.length === 0 && built.compiled.document.format === 'agents') {
      token = randomUUID()
      this.#tokens.set(token, {
        root, source: actualSource, vars: structuredClone(actualVars), attended: options.attended !== false, overrides: options.seats ?? {}, compiled: built.compiled, seats: built.seats, commands: built.commands,
        expires: this.#port.now() + TOKEN_TTL_MS, ...(retry ? { retryOf: retry } : {}), ...(retryCheck ? { retryCheck } : {}), ...(frontDoor ? { frontDoor } : {}), consumed: false,
      })
    }
    const warnings: FlowProblem[] = []
    if (token && this.#port.perToolMcpApproval) {
      const warnedRoles = new Set<string>()
      for (const seat of built.seats) {
        if (seat.plan.blocked || seat.plan.winner === null || warnedRoles.has(seat.role)) continue
        const selected = seat.plan.candidates[seat.plan.winner]
        if (!selected || !this.#port.perToolMcpApproval(selected.seat.runtime)) continue
        warnedRoles.add(seat.role)
        warnings.push({
          level: 'warning',
          at: `roles.${seat.role}.seat`,
          text: 'The first time, this agent asks once for each HarnessDesk tool it uses.',
        })
      }
    }
    return { ...built, ...(options.attended !== undefined ? { attended: options.attended } : {}), commands: retryCheck ? [retryCheck.command] : built.commands, problems: [...built.problems, ...warnings], token }
  }

  /**
   * The same statement a person's dry run makes, for arming a trigger: every
   * Seat, command, guard and problem, and **no start token**. A trigger's
   * consent is a different, durable authority owned by `TriggerConsent`; the
   * one-shot token a person presses Start with is never minted for it, so
   * neither can be redeemed as the other.
   */
  async freeze(root: string, source: string, options: { readonly unattended?: boolean; readonly againRole?: string | null } = {}): Promise<FlowPreview> {
    await this.#port.confine(root)
    return { ...(await this.#build(root, source, options.unattended === true, false, options.againRole ?? null)), token: null }
  }

  /**
   * The project's own declared check commands, read only when this flow
   * names a `check:` evidence guard that no check role's id or command
   * already explains (#1094) — never for a flow with nothing left to
   * explain, and never allowed to block a preview: this is advisory
   * validation, not the gate that runs one, so a project check file that
   * cannot be read here simply answers no project checks.
   */
  async #unresolvedCheckRuns(root: string, document: FlowDocument): Promise<readonly string[]> {
    if (document.format !== 'agents' || !this.#port.projectChecks) return []
    const known = checkGuardNames(document.flow)
    const unresolved = document.flow.rules.some((rule) =>
      (rule.when?.evidence ?? []).some((guard) => 'check' in guard && !known.has(guard.check)))
    if (!unresolved) return []
    try { return await this.#port.projectChecks(root) } catch { return [] }
  }

  /**
   * Everything a preview says, read once; mints nothing. `unattended` seats
   * each role as a trigger's Goal would be seated — under this machine's
   * unattended ceiling policy — so what an arm shows is what will run.
   */
  async #build(root: string, source: string, unattended = false, requireHeld = false, againRole: string | null = null, overrides: NonNullable<FlowRunOptions['seats']> = {}): Promise<Omit<FlowPreview, 'token'>> {
    const problems: FlowProblem[] = []
    const parsed = parseFlowPolicy(source)
    problems.push(...parsed.problems)
    if (!parsed.document) {
      const { token: _none, ...empty } = emptyPreview(problems)
      return empty
    }
    const agents = await this.#port.agents(root)
    const projectCheckRuns = await this.#unresolvedCheckRuns(root, parsed.document)
    const compiled = compileFlowPolicy(parsed.document, agents, projectCheckRuns, overrides)
    problems.push(...compiled.problems)
    // Only the Agent format starts a new Goal (`startGoal` refuses the old
    // one), so the old one is never handed a token that could only fail.
    if (compiled.document.format !== 'agents') problems.push({ level: 'error', at: 'format', text: LEGACY_START })
    const seats: FlowPreviewSeat[] = []
    if (compiled.document.format === 'agents') {
      const base = compiled.document.flow.base
      if (base) problems.push({ level: 'warning', at: 'base', text: `At Start, fetch remote "${base.remote}" (${base.branch ?? 'default branch'}). Seats open in managed worktrees from that commit; the project checkout stays where it is.` })
      const atPredecessor = rolesAtPredecessor(compiled, againRole)
      type AgentRole = Extract<(typeof compiled.document.flow.roles)[number], { readonly kind: 'agent' }>
      const raw: {
        readonly role: AgentRole
        readonly binding: (typeof compiled.bindings)[number]
        readonly plan: SeatPlan
      }[] = []
      for (const role of compiled.document.flow.roles) {
        if (role.kind !== 'agent') continue
        const bindings = compiled.bindings.filter((one) => one.role === role.id).sort((a, b) => a.index - b.index)
        for (const binding of bindings) {
          const plan = await this.#port.previewAgent(root, binding.agent.id, binding.seats, binding.grant, {
            ...(unattended ? { unattended: true } : {}),
            ...(requireHeld ? { requireHeld: true as const } : {}),
            includeCandidateCeilings: true,
          })
          raw.push({ role, binding, plan })
        }
      }
      const providerCache = new Map<string, Promise<string | null>>()
      const provider = (runtime: string, cwd: string): Promise<string | null> => {
        const key = `${runtime}\u0000${cwd}`
        let pending = providerCache.get(key)
        if (!pending) {
          pending = this.#port.providerOf?.(runtime, cwd).catch(() => null) ?? Promise.resolve(null)
          providerCache.set(key, pending)
        }
        return pending
      }
      const providersByRole = new Map<string, (string | null)[]>()
      const rawByRole = new Map<string, typeof raw>()
      for (const entry of raw) rawByRole.set(entry.role.id, [...(rawByRole.get(entry.role.id) ?? []), entry])
      // A role may be listed before its independent predecessor. Resolve those
      // dependencies first so later checks see each predecessor's final winner.
      const ordered: typeof raw = []
      const visited = new Set<string>()
      const visiting = new Set<string>()
      const visit = (id: string): void => {
        if (visited.has(id) || visiting.has(id)) return
        visiting.add(id)
        const role = rawByRole.get(id)?.[0]?.role
        for (const dependency of role?.independentOf ?? []) visit(dependency)
        visiting.delete(id)
        visited.add(id)
        ordered.push(...(rawByRole.get(id) ?? []))
      }
      for (const { role } of raw) visit(role.id)
      for (const { role, binding, plan: originalPlan } of ordered) {
        let plan = originalPlan
        // `rolesAtPredecessor` uses the same `handedCheckout` rule as a run;
        // either an isolated role or a role opened on handed work reads its lane.
        const lane = role.isolate || compiled.document.flow.base !== undefined || atPredecessor.has(role.id)
        const checkout = await this.#port.checkoutPath?.(root, lane) ?? root
        // A lane does not exist until the run opens it, so nothing can read its
        // configuration yet; it is cut from this project, whose own is the best
        // prediction. Where the lane's turns out different, the run stops at the
        // seat with that reason rather than trying another candidate.
        const providerRoot = root
        if (role.independentOf.length > 0 && !plan.blocked) {
          const writerProviders = role.independentOf.flatMap((id) => providersByRole.get(id) ?? [null])
          // When no predecessor provider can be read at all, the runner makes the
          // independence decision when this role is reached; the preview warns
          // rather than refusing a start it cannot judge.
          const canJudgeIndependence = writerProviders.some((one) => one !== null)
          if (!canJudgeIndependence) problems.push({
            level: 'warning',
            at: `roles.${role.id}`,
            text: `Can’t read which provider ${role.independentOf.join(', ')} uses here, so independence is checked when this step is reached.`,
          })
          const knownWriters = new Set<string | null>(writerProviders.length === 0 ? [null] : writerProviders)
          const warned = new Set<string>()
          const warnUnknown = (label: string) => {
            if (warned.has(label)) return
            warned.add(label)
            problems.push({
              level: 'warning',
              at: `roles.${role.id}`,
              text: `Can’t confirm that ${label} uses a different provider from ${role.independentOf.join(', ')}, so independence is checked when this step is reached.`,
            })
          }
          const candidates = [...plan.candidates]
          let winner: number | null = canJudgeIndependence ? null : plan.winner
          for (let index = 0; canJudgeIndependence && index < candidates.length; index += 1) {
            const candidate = candidates[index]!
            if (candidate.state === 'passed') continue
            // Match execution's pre-open candidate filter, which reads the
            // Goal checkout before the selected Seat is opened.
            const ownProvider = await provider(candidate.seat.runtime, root)
            const reason = independentProviderReason(ownProvider, knownWriters)
            // An unreadable provider is not a known clash: the start may go
            // ahead, warned, and the run decides when the step is reached —
            // independence is judged at that step, not in the opening plan.
            if (!reason || reason.kind === 'unknownProvider') {
              if (reason) warnUnknown(candidate.label)
              winner = index
              break
            }
            const additional = candidate.reason ? [...(candidate.alsoPassed ?? []), reason] : candidate.alsoPassed ?? []
            candidates[index] = {
              ...candidate,
              state: 'passed',
              reason: candidate.reason ?? reason,
              fix: candidate.reason ? candidate.fix : { kind: 'seats' },
              ...(additional.length ? { alsoPassed: additional } : {}),
            }
          }
          let postOpenStall = false
          if (canJudgeIndependence && winner !== null) {
            const selected = candidates[winner]!
            const actualProvider = await provider(selected.seat.runtime, providerRoot)
            const reason = independentProviderReason(actualProvider, knownWriters)
            if (reason?.kind === 'unknownProvider') warnUnknown(selected.label)
            else if (reason) {
              candidates[winner] = {
                ...selected,
                state: 'passed',
                reason: selected.reason ?? reason,
                fix: selected.reason ? selected.fix : { kind: 'seats' },
                ...(selected.reason ? { alsoPassed: [...(selected.alsoPassed ?? []), reason] } : {}),
              }
              winner = null
              postOpenStall = true
            }
          }
          plan = {
            ...plan,
            candidates,
            winner,
            ...(postOpenStall ? { blocked: INDEPENDENT_PROVIDER } : {}),
            ceiling: winner === null ? null : candidates[winner]?.ceiling ?? plan.ceiling,
          }
        }
        const selected = plan.winner === null ? null : plan.candidates[plan.winner]
        providersByRole.set(role.id, [
          ...(providersByRole.get(role.id) ?? []),
          selected ? await provider(selected.seat.runtime, providerRoot) : null,
        ])
        seats.push({
          role: role.id, index: binding.index, agent: binding.agent.id, plan, isolate: role.isolate || compiled.document.flow.base !== undefined,
          ...(atPredecessor.has(role.id) ? { atPredecessor: atPredecessor.get(role.id)! } : {}), reviews: reviewsIn(binding),
        })
        if (!plan.blocked && plan.winner !== null && this.#port.pluginToolsProblem) {
          const selected = plan.candidates[plan.winner]!
          const toolProblem = await this.#port.pluginToolsProblem(selected.seat.runtime, root, lane)
          if (toolProblem) problems.push({
            level: 'error',
            at: `roles.${role.id}.seat`,
            text: toolProblem,
          })
        }
        if (plan.blocked) {
          problems.push({ level: 'error', at: `roles.${role.id}`, text: plan.blocked })
        } else if (plan.winner === null) {
          // Every candidate passed over now: a fact about this machine at this moment, not about the flow.
          problems.push({ level: 'error', at: `roles.${role.id}`, text: `No seat could be opened for “${binding.agent.id}”.`, availability: true })
        }
      }
    }
    const commands = commandsOf(root, compiled)
    const guards = guardsOf(compiled)
    const messaging = compiled.document.format === 'agents' ? compiled.document.flow.messaging : 'board-only'
    const shown = compiled.document.format === 'agents' ? Object.fromEntries(compiled.document.flow.roles.flatMap(role => role.kind === 'agent' && Object.hasOwn(overrides, role.id)
      ? [[role.id, { file: role.seats, run: overrides[role.id]! }]] : [])) : {}
    return { compiled, seats, commands, guards, messaging, problems, ...(Object.keys(shown).length ? { overrides: shown } : {}) }
  }

  /**
   * Redeems a token once, for the exact `(root, source, vars)` it was minted
   * for and only once the world it described is re-confirmed unchanged —
   * every Agent's resolved content, its winning seat, and every check's exact
   * command and directory, freshly read again and compared to what was
   * frozen. Consumed here regardless of the outcome, so a token can never be
   * tried twice. Null is the caller's one refusal for every way this can
   * fail: unknown, expired, already spent, a different start input, or the
   * world having moved since the preview was taken.
   */
  async redeem(
    token: string, root: string, source: string, vars: Readonly<Record<string, string>>, options: FlowRunOptions = {},
  ): Promise<{ readonly compiled: CompiledFlow; readonly commands: FlowPreview['commands']; readonly frontDoor: FrontDoorBinding | null; readonly attended: boolean; readonly overrides: NonNullable<FlowRunOptions['seats']> } | null> {
    this.#sweep()
    const held = this.#tokens.get(token)
    if (!held || held.consumed) return null
    held.consumed = true
    if (held.expires < this.#port.now()) return null
    if (held.root !== root || held.source !== source || JSON.stringify(held.vars) !== JSON.stringify(vars)) return null
    // A token authorizes the exact seats and attendance. Neither a client nor a changed request can widen it.
    const canonical = (value: NonNullable<FlowRunOptions['seats']>) => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))))
    if (held.attended !== (options.attended !== false) || canonical(held.overrides) !== canonical(options.seats ?? {})) return null
    // Re-read under the same policy it was minted under: a strict token is only ever compared with a strict dry run.
    await this.#port.confine(root)
    if (held.retryOf && held.retryCheck) {
      const saved = await this.#port.storedRun?.(held.retryOf.run)
      if (!saved || saved.source !== source || JSON.stringify(saved.vars) !== JSON.stringify(vars) || !this.#port.previewCheck) return null
      try {
        const fresh = await this.#port.previewCheck(held.retryOf.run, held.retryOf.card)
        if (JSON.stringify(fresh) !== JSON.stringify(held.retryCheck)) return null
      } catch { return null }
      return { compiled: held.compiled, commands: held.commands, frontDoor: null, attended: held.attended, overrides: held.overrides }
    }
    const fresh = await this.#build(root, source, !held.attended, held.frontDoor !== undefined, null, held.overrides)
    if (fresh.problems.some((one) => one.level === 'error')) return null
    if (fingerprint({ compiled: fresh.compiled, seats: fresh.seats, commands: fresh.commands }) !== fingerprint(held)) return null
    if (held.frontDoor) {
      // The target read again from the host, now: a branch that moved, a diff that changed, needs a new preview.
      if (!this.#port.resolveTarget) return null
      let facts: string
      try {
        facts = await this.#port.resolveTarget(held.frontDoor.target.context)
      } catch {
        return null
      }
      if (facts !== held.frontDoor.target.facts) return null
    }
    return { compiled: held.compiled, commands: held.commands, frontDoor: held.frontDoor ?? null, attended: held.attended, overrides: held.overrides }
  }

  /** The uncertain run/card a check-retry token is bound to, without consuming it — `flow/check/retry`'s own validation. */
  retryCheck(token: string): CheckRetry | undefined {
    this.#sweep()
    return this.#tokens.get(token)?.retryCheck
  }

  retryTarget(token: string): { readonly run: string; readonly card: number } | null {
    this.#sweep()
    return this.#tokens.get(token)?.retryOf ?? null
  }
}
