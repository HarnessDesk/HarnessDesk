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

import { TOOL_ACTIONS, toolCeiling } from './tools.js'

/** What the tool gate needs from the host. */
export interface CeilingGatePort {
  ceilingOf(runtime: string, sessionId: string): SeatCeiling | null
  say(runtime: string, sessionId: string, text: string): void
}

export interface GatedCall {
  readonly tool: string
  readonly needs: CeilingLevel
  readonly scope: ScopeQuery
}

export type Admission = { readonly admitted: true } | { readonly admitted: false; readonly refusal: string }

const WORD: Readonly<Record<CeilingLevel, string>> = { read: 'Read', edit: 'Edit', publish: 'Publish', merge: 'Merge' }

/** A refusal says what the seat may do, never the tool's wire name. */
export const refusalOf = (tool: string, needs: CeilingLevel, level: CeilingLevel): string => {
  const action = TOOL_ACTIONS[tool]
  return `${WORD[needs]} refused: this seat may ${level}, not ${needs}${action ? ` — ${action} needs a seat that may ${needs}` : ''}.`
}

export class CeilingGate {
  constructor(private readonly port: CeilingGatePort) {}

  async admit(call: GatedCall): Promise<Admission> {
    const { runtime, sessionId } = call.scope
    if (runtime === undefined || sessionId === undefined) return { admitted: true }
    const ceiling = this.port.ceilingOf(String(runtime), String(sessionId))
    if (!ceiling || reaches(ceiling.level, call.needs)) return { admitted: true }
    const refusal = refusalOf(call.tool, call.needs, ceiling.level)
    this.port.say(String(runtime), String(sessionId), refusal)
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
        const admitted = await gate.admit({ tool: tool.name, needs: toolCeiling(tool, plugin), scope })
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
