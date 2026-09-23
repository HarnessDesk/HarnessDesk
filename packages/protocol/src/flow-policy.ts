import type { AgentDefinition, AgentEntry } from './agent.js'
import type { CeilingLevel } from './evidence.js'
import type { Flow, FlowCheck, FlowInput, FlowProblem, FlowRun, FlowSeat, FlowThen } from './flow.js'

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

/**
 * One round of a run on a Goal: the cards it opened, the Seats that hold
 * them, and the evidence it was opened on. `cause` is the idempotency key the
 * round was opened under, so a repeated notice can never open it twice.
 */
export interface FlowRoundState {
  readonly n: number
  readonly role: string
  readonly cards: readonly number[]
  readonly seats: readonly string[]
  readonly evidence: readonly string[]
  readonly state: 'opening' | 'running' | 'waiting-evidence' | 'closed'
  readonly cause: string
}

/**
 * One piece of external work a run did or tried to do, journaled before it
 * started. `uncertain` means the desk stopped between starting it and
 * learning how it ended, and a person has to look before it is tried again.
 */
export interface FlowOperation {
  readonly key: string
  readonly kind: 'seat' | 'turn' | 'check' | 'round'
  readonly state: 'prepared' | 'started' | 'finished' | 'uncertain'
  readonly card: number | null
  readonly seat: string | null
}

/**
 * A flow run as execution state attached to one Goal. Its membership is the
 * Goal's Seats; this holds no member list of its own.
 */
export interface FlowExecution {
  readonly version: 2
  readonly id: string
  readonly goal: string
  readonly document: FlowDocument
  readonly state: 'running' | 'settled' | 'stopped' | 'stalled'
  readonly rounds: readonly FlowRoundState[]
  readonly operations: readonly FlowOperation[]
  readonly legacyRun: FlowRun | null
  readonly reason: string | null
}
