import type { FlowExecution, FlowRoundState, GoalView, TriggerFact } from '@harnessdesk/protocol'

import { TriggerRefusal, type TriggerStartRequest } from '../flow-execution.js'
import type { TriggerGoalRequest } from '../goals/plane.js'
import type { AdmissionEffects } from './admission.js'
import type { IntakeOperation } from './store.js'

/**
 * A firing's effects, in their one order: its Goal, what it observed, its
 * round — then, once all three are recorded as applied, its dispatch. Each
 * effect is idempotent on the ids the operation reserved, so a restart that
 * finds the operation prepared runs it again from the top and lands on the
 * same Goal, the same fact and the same round.
 */

/** The Goal plane's host-only trigger creation. */
export interface TriggerGoalPort {
  ensureTriggerGoal(input: TriggerGoalRequest): Promise<GoalView>
}

/** The flow engine's host-only trigger adapters. */
export interface TriggerExecutionPort {
  startTriggered(input: TriggerStartRequest): Promise<FlowExecution>
  againTriggered(run: string, key: string, evidence: readonly string[]): Promise<FlowRoundState>
  resumeTriggered(run: string): Promise<void>
}

/** The evidence plane's firing observation: host-observed pull-request facts only. */
export interface IntakeObservationPort {
  observeTrigger(firing: string, goal: string, fact: TriggerFact): Promise<readonly string[]>
}

export interface IntakeApplyPort {
  ensureGoal(operation: IntakeOperation): Promise<void>
  observe(operation: IntakeOperation): Promise<readonly string[]>
  /** The round the operation intends; a reason for a person when the run could not take it. */
  ensureRound(operation: IntakeOperation, evidence: readonly string[]): Promise<string | null>
  applied(operation: IntakeOperation, attention: string | null): Promise<void>
  enableDispatch(operation: IntakeOperation): Promise<void>
}

/** The effects in order. An applied operation only has its dispatch released again. */
export async function applyAdmission(operation: IntakeOperation, port: IntakeApplyPort): Promise<void> {
  if (operation.state === 'applied') {
    await port.enableDispatch(operation)
    return
  }
  await port.ensureGoal(operation)
  const evidence = await port.observe(operation)
  const attention = await port.ensureRound(operation, evidence)
  await port.applied(operation, attention)
  await port.enableDispatch(operation)
}

export interface IntakeTargets {
  readonly goals: TriggerGoalPort
  readonly flows: TriggerExecutionPort
  readonly evidence: IntakeObservationPort
  /**
   * Every gate dispatch passes, checked at the moment of release: machine
   * pause, the arm still standing, budgets, named waits. Null when it may go.
   */
  gate(operation: IntakeOperation): Promise<string | null>
}

/**
 * A firing's effects over the real Goal plane, flow engine and evidence
 * plane; `Admission` runs them through `applyAdmission` and journals the
 * steps between.
 */
export class IntakeEffects implements AdmissionEffects {
  readonly #targets: IntakeTargets

  constructor(targets: IntakeTargets) {
    this.#targets = targets
  }

  #payload(operation: IntakeOperation): NonNullable<IntakeOperation['payload']> {
    if (!operation.payload) throw new Error('This firing’s journal entry lost what it was decided on.')
    return operation.payload
  }

  async ensureGoal(operation: IntakeOperation): Promise<void> {
    // A later firing joins the Goal its group's first firing made: nothing to make.
    if (operation.mode !== 'start') return
    await this.#targets.goals.ensureTriggerGoal({
      key: operation.key, id: operation.goal,
      input: {
        root: operation.project, sentence: this.#payload(operation).sentence,
        origin: { kind: 'trigger', trigger: operation.trigger, event: operation.key },
      },
    })
  }

  observe(operation: IntakeOperation): Promise<readonly string[]> {
    return this.#targets.evidence.observeTrigger(operation.key, operation.goal, this.#payload(operation).fact)
  }

  async ensureRound(operation: IntakeOperation, evidence: readonly string[]): Promise<string | null> {
    const payload = this.#payload(operation)
    try {
      if (operation.mode === 'start') {
        const run = await this.#targets.flows.startTriggered({
          key: operation.key, id: operation.run, goal: operation.goal, root: operation.project,
          closureDigest: payload.binding.closure, definition: payload.definition, fact: payload.fact, evidence,
        })
        return run.state === 'stopped' ? run.reason : operation.attention
      }
      if (operation.mode === 'again') await this.#targets.flows.againTriggered(operation.run, operation.key, evidence)
    } catch (error) {
      // The run could not take this firing, for a reason a person reads: recorded, never retried as a failure.
      if (error instanceof TriggerRefusal) return error.message
      throw error
    }
    return operation.attention
  }

  async release(operation: IntakeOperation): Promise<{ readonly released: true } | { readonly released: false; readonly reason: string }> {
    // Nothing of this firing's own waits to be sent: its input is recorded, and the person is told.
    if (operation.mode === 'record') return { released: true }
    const refused = await this.#targets.gate(operation)
    if (refused !== null) return { released: false, reason: refused }
    await this.#targets.flows.resumeTriggered(operation.run)
    return { released: true }
  }
}
