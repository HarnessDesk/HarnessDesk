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
  type FlowStartTarget,
  type SeatPlan,
  type SeatReason,
  type StartContext,
} from '@harnessdesk/protocol'

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
  /**
   * A front-door target read again from the host, as the canonical facts it
   * was bound to — commits, a diff, a working tree's snapshot. Asked at
   * redemption: a target that moved since the preview refuses the start.
   */
  resolveTarget?(context: StartContext): Promise<string>
  /** A retried check's own run: its saved source and inputs, read back for the equality check — never a new choice. */
  storedRun?(run: string): Promise<{ readonly source: string; readonly vars: Readonly<Record<string, string>> } | null>
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
  readonly compiled: CompiledFlow
  readonly seats: readonly FlowPreviewSeat[]
  readonly commands: FlowPreview['commands']
  readonly expires: number
  /** Set only for a check-retry preview: the uncertain run/card this token is additionally bound to. */
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
  ): Promise<FlowPreview> {
    this.#sweep()
    await this.#port.confine(root)
    let actualSource = source
    let actualVars = vars
    if (retry) {
      const saved = (await this.#port.storedRun?.(retry.run)) ?? null
      if (!saved) return emptyPreview([{ level: 'error', at: 'run', text: CHANGED_PREVIEW }])
      if (saved.source !== source || JSON.stringify(saved.vars) !== JSON.stringify(vars)) {
        return emptyPreview([{ level: 'error', at: 'run', text: CHANGED_PREVIEW }])
      }
      actualSource = saved.source
      actualVars = saved.vars
    }
    if (retry && frontDoor) return emptyPreview([{ level: 'error', at: 'run', text: CHANGED_PREVIEW }])
    const built = await this.#build(root, actualSource, false, frontDoor !== undefined)
    const errors = built.problems.filter((one) => one.level === 'error')
    let token: string | null = null
    // An unparsed document is the empty legacy placeholder: never a token.
    if (errors.length === 0 && built.compiled.document.format === 'agents') {
      token = randomUUID()
      this.#tokens.set(token, {
        root, source: actualSource, vars: actualVars, compiled: built.compiled, seats: built.seats, commands: built.commands,
        expires: this.#port.now() + TOKEN_TTL_MS, ...(retry ? { retryOf: retry } : {}), ...(frontDoor ? { frontDoor } : {}), consumed: false,
      })
    }
    return { ...built, token }
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
  async #build(root: string, source: string, unattended = false, requireHeld = false, againRole: string | null = null): Promise<Omit<FlowPreview, 'token'>> {
    const problems: FlowProblem[] = []
    const parsed = parseFlowPolicy(source)
    problems.push(...parsed.problems)
    if (!parsed.document) {
      const { token: _none, ...empty } = emptyPreview(problems)
      return empty
    }
    const agents = await this.#port.agents(root)
    const projectCheckRuns = await this.#unresolvedCheckRuns(root, parsed.document)
    const compiled = compileFlowPolicy(parsed.document, agents, projectCheckRuns)
    problems.push(...compiled.problems)
    // Only the Agent format starts a new Goal (`startGoal` refuses the old
    // one), so the old one is never handed a token that could only fail.
    if (compiled.document.format !== 'agents') problems.push({ level: 'error', at: 'format', text: LEGACY_START })
    const seats: FlowPreviewSeat[] = []
    if (compiled.document.format === 'agents') {
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
        const lane = role.isolate || atPredecessor.has(role.id)
        const checkout = await this.#port.checkoutPath?.(root, lane) ?? root
        // A lane does not exist until the run opens it, so nothing can read its
        // configuration yet; it is cut from this project, whose own is the best
        // prediction. Where the lane's turns out different, the run stops at the
        // seat with that reason rather than trying another candidate.
        const providerRoot = root
        if (role.independentOf.length > 0 && !plan.blocked) {
          const writerProviders = role.independentOf.flatMap((id) => providersByRole.get(id) ?? [null])
          // A regular start can still be previewed when none of its predecessor
          // providers can be read at all. The runner will make the same
          // independence decision when that role is reached; turning an
          // unreadable provider into a preview-time refusal here would make an
          // ordinary dry run fail where it did before this check existed. A
          // held-only front door remains strict because its token promises the
          // whole opening plan.
          const canJudgeIndependence = requireHeld || writerProviders.some((one) => one !== null)
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
            // An unreadable provider is not a known clash: an ordinary start may
            // go ahead, warned, and the run decides when the step is reached. A
            // held-only front door promises its whole plan, so it stays strict.
            if (!reason || (reason.kind === 'unknownProvider' && !requireHeld)) {
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
            if (reason?.kind === 'unknownProvider' && !requireHeld) warnUnknown(selected.label)
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
          role: role.id, index: binding.index, agent: binding.agent.id, plan, isolate: role.isolate,
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
    return { compiled, seats, commands, guards, messaging, problems }
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
    token: string, root: string, source: string, vars: Readonly<Record<string, string>>,
  ): Promise<{ readonly compiled: CompiledFlow; readonly commands: FlowPreview['commands']; readonly frontDoor: FrontDoorBinding | null } | null> {
    this.#sweep()
    const held = this.#tokens.get(token)
    if (!held || held.consumed) return null
    held.consumed = true
    if (held.expires < this.#port.now()) return null
    if (held.root !== root || held.source !== source || JSON.stringify(held.vars) !== JSON.stringify(vars)) return null
    // Re-read under the same policy it was minted under: a strict token is only ever compared with a strict dry run.
    await this.#port.confine(root)
    const fresh = await this.#build(root, source, false, held.frontDoor !== undefined)
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
    return { compiled: held.compiled, commands: held.commands, frontDoor: held.frontDoor ?? null }
  }

  /** The uncertain run/card a check-retry token is bound to, without consuming it — `flow/check/retry`'s own validation. */
  retryTarget(token: string): { readonly run: string; readonly card: number } | null {
    this.#sweep()
    return this.#tokens.get(token)?.retryOf ?? null
  }
}
