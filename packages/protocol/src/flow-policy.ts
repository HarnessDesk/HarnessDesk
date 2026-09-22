import type { AgentDefinition, AgentEntry } from './agent.js'
import type { CeilingLevel } from './evidence.js'
import type { Flow, FlowCheck, FlowInput, FlowProblem, FlowSeat, FlowThen } from './flow.js'

/** The second-generation, Agent-routed flow document. */
export interface FlowAgentRole {
  readonly id: string
  readonly kind: 'agent'
  readonly uses: readonly string[]
  readonly seats: readonly FlowSeat[]
  readonly count?: number
  readonly isolate: boolean
  readonly grant: CeilingLevel
  readonly independentOf: readonly string[]
}

export type FlowPolicyRole = FlowAgentRole
  | { readonly id: string; readonly kind: 'check'; readonly check: FlowCheck }
  | { readonly id: string; readonly kind: 'person'; readonly outcomes: readonly string[] }

export type FlowEvidenceGuard =
  | { readonly check: string }
  | { readonly ci: 'green' }
  | { readonly review: string }
  | { readonly pr: 'open' | 'merged' }
  | { readonly diff: true }

export interface FlowPolicyRule {
  readonly id: string
  readonly on: string
  readonly when?: {
    readonly every?: readonly string[]
    readonly any?: readonly string[]
    readonly evidence?: readonly FlowEvidenceGuard[]
  }
  readonly then: FlowThen
}

export interface FlowPolicy {
  readonly version: 2
  readonly name: string
  readonly description?: string
  readonly inputs: readonly FlowInput[]
  readonly roles: readonly FlowPolicyRole[]
  readonly rules: readonly FlowPolicyRule[]
  readonly seed: FlowThen
  readonly messaging: 'board-only' | 'members'
  readonly wait: number
  readonly rearm?: number
  readonly layout?: unknown
}

export type FlowDocument =
  | { readonly format: 'legacy'; readonly flow: Flow }
  | { readonly format: 'agents'; readonly flow: FlowPolicy }

export interface FlowBinding {
  readonly role: string
  readonly index: number
  readonly agent: AgentDefinition
  readonly origin: AgentEntry['origin']
  readonly digest: string
  readonly seats: readonly FlowSeat[]
  readonly grant: CeilingLevel
}

export interface CompiledFlow {
  readonly document: FlowDocument
  readonly bindings: readonly FlowBinding[]
  readonly problems: readonly FlowProblem[]
}
