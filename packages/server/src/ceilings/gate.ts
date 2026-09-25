import {
  reaches,
  type CapabilityContribution,
  type CapabilityRegistry,
  type CeilingLevel,
  type ContributionId,
  type ContributionKind,
  type ExtensionEvent,
  type HookInvocation,
  type HookVerdict,
  type PluginInstance,
  type ScopeQuery,
  type SeatCeiling,
  type ToolResult,
} from '@harnessdesk/protocol'

import type { TurnCause } from './cause.js'
import { publishesToForge, TOOL_WORDS, toolCeiling } from './tools.js'

/** What the tool gate needs from the host. */
export interface CeilingGatePort {
  /** `null` means a reported delegated caller lost its authoritative root. */
  rootOf(runtime: string, sessionId: string): Conversation | null
  ceilingOf(runtime: string, sessionId: string): SeatCeiling | null
  causeOf(runtime: string, sessionId: string, turnId?: string): TurnCause
  nameOf(runtime: string, sessionId: string): string
  say(runtime: string, sessionId: string, text: string): void
  askPerson(runtime: string, sessionId: string, question: HeldQuestion): Promise<'allowed' | 'refused' | 'unanswered'>
  /** Why a conversation may not publish to a forge yet — a blind review round still open — or null. */
  embargoOf?(runtime: string, sessionId: string): string | null
}

export interface Conversation {
  readonly runtime: string
  readonly sessionId: string
}

export interface HeldQuestion {
  readonly summary: string
  readonly reason: string
}

export interface GatedCall {
  readonly tool: string
  readonly needs: CeilingLevel
  readonly scope: ScopeQuery
  /** True for a desk tool that posts to a forge: a blind round's embargo holds it back, for the caller and its root. */
  readonly publishes?: boolean
  /**
   * Discovery, not a call: the same ceiling and embargo are applied, but
   * nothing is said into the conversation and no person is asked — a
   * listing a person would have to be asked about is simply not shown, and
   * the call itself asks if it is ever made.
   */
  readonly quiet?: boolean
}

export type Admission = { readonly admitted: true } | { readonly admitted: false; readonly refusal: string }

export const unresolvedDelegationRefusal = 'Delegated tool call refused: its root conversation could not be confirmed.'

const WORD: Readonly<Record<CeilingLevel, string>> = { read: 'Read', edit: 'Edit', publish: 'Publish', merge: 'Merge' }

/** A refusal says what the seat may do, never the tool's wire name. */
export const refusalOf = (tool: string, needs: CeilingLevel, level: CeilingLevel): string => {
  const doing = TOOL_WORDS[tool]?.doing
  return `${WORD[needs]} refused: this seat may ${level}, not ${needs}${doing ? ` — ${doing} needs a seat that may ${needs}` : ''}.`
}

const askOf = (tool: string, needs: CeilingLevel): string => TOOL_WORDS[tool]?.ask ?? `use a tool that needs a seat that may ${needs}`

export const heldWords = (tool: string, needs: CeilingLevel, sender: { readonly name: string; readonly level: CeilingLevel }, receiver: string) => {
  const ask = askOf(tool, needs)
  return {
    question: {
      summary: `${sender.name} asked ${receiver} to ${ask}.`,
      reason: `${sender.name} may ${sender.level}, and a message cannot carry a ceiling across: what it may not do itself, it may not ask another agent to do for it. Allow it once, or refuse it.`,
    },
    waiting: `Waiting for you: ${sender.name} asked ${receiver} to ${ask}, which is beyond what ${sender.name} may do.`,
    allowed: `You allowed ${receiver} to ${ask} for ${sender.name}.`,
    refused: `You refused: ${receiver} will not ${ask} for ${sender.name}. Nothing was done — say so, and go on without it.`,
    unanswered: `Nobody answered, so nothing was done: ${sender.name} may ${sender.level}, and to ${ask} for it needs the person. End your turn, and say that this waits for the person.`,
  }
}

export class CeilingGate {
  constructor(private readonly port: CeilingGatePort) {}

  async admit(call: GatedCall): Promise<Admission> {
    const { runtime, sessionId } = call.scope
    if (runtime === undefined || sessionId === undefined) return { admitted: true }
    const root = this.port.rootOf(String(runtime), String(sessionId))
    if (root === null) return { admitted: false, refusal: unresolvedDelegationRefusal }
    if (call.publishes) {
      // A delegated call is held to its root's embargo too: a blind reviewer cannot publish through a helper.
      const embargo = this.port.embargoOf?.(String(runtime), String(sessionId)) ?? this.port.embargoOf?.(root.runtime, root.sessionId) ?? null
      if (embargo) {
        if (!call.quiet) this.port.say(root.runtime, root.sessionId, embargo)
        return { admitted: false, refusal: embargo }
      }
    }
    const ceiling = this.port.ceilingOf(root.runtime, root.sessionId)
    if (ceiling && !reaches(ceiling.level, call.needs)) {
      const refusal = refusalOf(call.tool, call.needs, ceiling.level)
      if (!call.quiet) this.port.say(root.runtime, root.sessionId, refusal)
      return { admitted: false, refusal }
    }
    if (!reaches(call.needs, 'publish')) return { admitted: true }
    const own = root.runtime === String(runtime) && root.sessionId === String(sessionId)
    const turnId = own && call.scope.turnId !== undefined ? String(call.scope.turnId) : undefined
    const cause = this.port.causeOf(root.runtime, root.sessionId, turnId)
    if (cause.kind !== 'message' || !cause.ceiling || reaches(cause.ceiling.level, call.needs)) return { admitted: true }
    const words = heldWords(call.tool, call.needs, { name: cause.from.name, level: cause.ceiling.level }, this.port.nameOf(root.runtime, root.sessionId))
    if (call.quiet) return { admitted: false, refusal: words.waiting }
    this.port.say(root.runtime, root.sessionId, words.waiting)
    const answer = await this.port.askPerson(root.runtime, root.sessionId, words.question)
    if (answer === 'allowed') {
      this.port.say(root.runtime, root.sessionId, words.allowed)
      return { admitted: true }
    }
    const refusal = answer === 'refused' ? words.refused : words.unanswered
    this.port.say(root.runtime, root.sessionId, refusal)
    return { admitted: false, refusal }
  }
}

/** The capability registry with one ceiling gate in front of all tool calls. */
export class GatedRegistry implements CapabilityRegistry {
  constructor(
    private readonly inner: CapabilityRegistry,
    private readonly gate: () => CeilingGate | null,
  ) {}

  list<K extends ContributionKind>(kind: K, query?: ScopeQuery): readonly Extract<CapabilityContribution, { kind: K }>[] {
    return this.inner.list(kind, query)
  }

  plugins(): readonly PluginInstance[] {
    return this.inner.plugins()
  }

  async invokeTool(id: ContributionId, args: unknown, scope: ScopeQuery): Promise<ToolResult> {
    const gate = this.gate()
    if (gate) {
      const tool = this.inner.list('tool', scope).find((one) => one.id === id)
      if (tool) {
        const plugin = this.inner.plugins().find((one) => one.instanceId === tool.owner)
        const admitted = await gate.admit({ tool: tool.name, needs: toolCeiling(tool, plugin), scope, publishes: publishesToForge(tool, plugin) })
        if (!admitted.admitted) return { ok: false, error: admitted.refusal }
      }
    }
    return this.inner.invokeTool(id, args, scope)
  }

  runHooks(invocation: HookInvocation): Promise<HookVerdict> {
    return this.inner.runHooks(invocation)
  }

  resolveContext(query: ScopeQuery): Promise<readonly { label: string; text: string }[]> {
    return this.inner.resolveContext(query)
  }

  subscribe(listener: (event: ExtensionEvent) => void): () => void {
    return this.inner.subscribe(listener)
  }
}
