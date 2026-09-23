import { randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'

import {
  type AgentEntry,
  type CeilingLevel,
  type CompiledFlow,
  type FlowEvidenceGuard,
  type FlowPreview,
  type FlowPreviewSeat,
  type FlowProblem,
  type FlowSeat,
  type SeatPlan,
} from '@harnessdesk/protocol'

import { compileFlowPolicy, parseFlowPolicy } from './flow-policy.js'

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
  /** One Agent's seat plan for the exact seats and grant a role names. */
  previewAgent(root: string, agent: string, seats: readonly FlowSeat[], grant: CeilingLevel): Promise<SeatPlan>
  /** A retried check's own run: its saved source and inputs, read back for the equality check — never a new choice. */
  storedRun?(run: string): Promise<{ readonly source: string; readonly vars: Readonly<Record<string, string>> } | null>
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
  consumed: boolean
}

/** The one comparable shape a token's fingerprint is taken of: the winning seat and its candidate, never the whole passed-over list. */
const fingerprint = (input: { compiled: CompiledFlow; seats: readonly FlowPreviewSeat[]; commands: FlowPreview['commands'] }): string =>
  JSON.stringify({
    compiled: input.compiled,
    commands: input.commands,
    seats: input.seats.map((seat) => ({
      role: seat.role, index: seat.index, agent: seat.agent, isolate: seat.isolate,
      blocked: seat.plan.blocked, winner: seat.plan.winner === null ? null : seat.plan.candidates[seat.plan.winner] ?? null,
    })),
  })

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
  ): Promise<FlowPreview> {
    this.#sweep()
    await this.#port.confine(root)
    let actualSource = source
    let actualVars = vars
    const problems: FlowProblem[] = []
    if (retry) {
      const saved = (await this.#port.storedRun?.(retry.run)) ?? null
      if (!saved) return emptyPreview([{ level: 'error', at: 'run', text: CHANGED_PREVIEW }])
      if (saved.source !== source || JSON.stringify(saved.vars) !== JSON.stringify(vars)) {
        return emptyPreview([{ level: 'error', at: 'run', text: CHANGED_PREVIEW }])
      }
      actualSource = saved.source
      actualVars = saved.vars
    }
    const parsed = parseFlowPolicy(actualSource)
    problems.push(...parsed.problems)
    if (!parsed.document) return emptyPreview(problems)
    const agents = await this.#port.agents(root)
    const compiled = compileFlowPolicy(parsed.document, agents)
    problems.push(...compiled.problems)
    const seats: FlowPreviewSeat[] = []
    if (compiled.document.format === 'agents') {
      for (const role of compiled.document.flow.roles) {
        if (role.kind !== 'agent') continue
        const bindings = compiled.bindings.filter((one) => one.role === role.id).sort((a, b) => a.index - b.index)
        for (const binding of bindings) {
          const plan = await this.#port.previewAgent(root, binding.agent.id, binding.seats, binding.grant)
          seats.push({ role: role.id, index: binding.index, agent: binding.agent.id, plan, isolate: role.isolate })
          if (plan.blocked || plan.winner === null) {
            problems.push({ level: 'error', at: `roles.${role.id}`, text: plan.blocked ?? `No seat could be opened for “${binding.agent.id}”.` })
          }
        }
      }
    }
    const commands = commandsOf(root, compiled)
    const guards = guardsOf(compiled)
    const messaging = compiled.document.format === 'agents' ? compiled.document.flow.messaging : 'board-only'
    const errors = problems.filter((one) => one.level === 'error')
    let token: string | null = null
    if (errors.length === 0) {
      token = randomUUID()
      this.#tokens.set(token, {
        root, source: actualSource, vars: actualVars, compiled, seats, commands, expires: this.#port.now() + TOKEN_TTL_MS,
        ...(retry ? { retryOf: retry } : {}), consumed: false,
      })
    }
    return { token, compiled, seats, commands, guards, messaging, problems }
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
  ): Promise<{ readonly compiled: CompiledFlow; readonly commands: FlowPreview['commands'] } | null> {
    this.#sweep()
    const held = this.#tokens.get(token)
    if (!held || held.consumed) return null
    held.consumed = true
    if (held.expires < this.#port.now()) return null
    if (held.root !== root || held.source !== source || JSON.stringify(held.vars) !== JSON.stringify(vars)) return null
    const fresh = await this.preview(root, source, vars)
    if (fresh.token === null) return null
    if (fingerprint({ compiled: fresh.compiled, seats: fresh.seats, commands: fresh.commands }) !== fingerprint(held)) return null
    return { compiled: held.compiled, commands: held.commands }
  }

  /** The uncertain run/card a check-retry token is bound to, without consuming it — `flow/check/retry`'s own validation. */
  retryTarget(token: string): { readonly run: string; readonly card: number } | null {
    this.#sweep()
    return this.#tokens.get(token)?.retryOf ?? null
  }
}
