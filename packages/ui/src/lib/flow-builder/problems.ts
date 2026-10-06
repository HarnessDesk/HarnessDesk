import type { FlowPolicy } from '@harnessdesk/protocol'

import { flowModel } from '../flow-model'
import type { BuilderDocument } from './document'

const isUnconditional = (rule: FlowPolicy['rules'][number]): boolean => (
  !rule.when?.every?.length && !rule.when?.any?.length && !rule.when?.evidence?.length
)

export interface BuilderFacts { readonly steps: number; readonly rules: number; readonly seats: number }
export const builderFacts = (document: BuilderDocument): BuilderFacts => {
  const model = flowModel(document.policy)
  return { steps: model.steps.length, rules: model.rules.length, seats: model.steps.reduce((sum, step) => sum + (step.kind === 'agent' ? step.count : 0), 0) }
}

export interface BuilderProblem {
  readonly kind: 'unreachable' | 'dangling-rule' | 'shadowed' | 'independent-of' | 'unseated' | 'missing-seed' | 'no-finish' | 'layout'
  readonly text: string
  /** Stable canvas identities let the header and the card address the same problem. */
  readonly step?: string
  readonly rule?: string
}

/**
 * Structural editing advisories only. The host remains the judge on Save
 * and Dry run: this cannot resolve Agent files, seating, answer vocabularies
 * or evidence. In particular an empty list is never a validity verdict.
 */
export const builderProblems = (document: BuilderDocument): readonly BuilderProblem[] => {
  const { policy } = document
  const steps = new Map(document.steps.map((step) => [step.role, step.id]))
  const problems: BuilderProblem[] = []
  const seedExists = steps.has(policy.seed.role)
  if (!seedExists) problems.push({ kind: 'missing-seed', text: 'The starting step is missing' })
  for (const [index, rule] of policy.rules.entries()) {
    if (!steps.has(rule.on) || !steps.has(rule.then.role)) problems.push({ kind: 'dangling-rule', rule: document.rules[index]!.id, text: 'This rule names a missing step' })
  }
  const outgoing = new Map<string, { readonly rule: FlowPolicy['rules'][number]; readonly index: number }[]>()
  for (const [index, rule] of policy.rules.entries()) outgoing.set(rule.on, [...(outgoing.get(rule.on) ?? []), { rule, index }])
  const effective = new Map<string, { readonly rule: FlowPolicy['rules'][number]; readonly index: number }[]>()
  for (const [role, rules] of outgoing) {
    const firstUnconditional = rules.findIndex(({ rule }) => isUnconditional(rule))
    effective.set(role, firstUnconditional < 0 ? rules : rules.slice(0, firstUnconditional + 1))
    if (firstUnconditional >= 0) {
      for (const { index } of rules.slice(firstUnconditional + 1)) {
        problems.push({
          kind: 'shadowed', rule: document.rules[index]!.id,
          text: 'An earlier unconditional rule always matches first',
        })
      }
    }
  }
  const reached = new Set<string>()
  if (seedExists) {
    const pending = [policy.seed.role]
    while (pending.length) {
      const role = pending.pop()!
      if (!steps.has(role) || reached.has(role)) continue
      reached.add(role)
      for (const { rule } of effective.get(role) ?? []) pending.push(rule.then.role)
    }
  }
  for (const role of policy.roles) {
    const step = steps.get(role.id)!
    if (seedExists && !reached.has(role.id)) problems.push({ kind: 'unreachable', step, text: 'Nothing reaches this step' })
    // An Agent's own preference can fill seats: no explicit override is not a problem.
    if (role.kind === 'agent' && !role.uses.length) problems.push({ kind: 'unseated', step, text: 'This step has no Agent to take its seats' })
  }
  const hasPredecessorPath = (from: string, target: string): boolean => {
    const pending = [from]
    const seen = new Set<string>()
    while (pending.length) {
      const role = pending.pop()!
      if (role === target) return true
      if (seen.has(role)) continue
      seen.add(role)
      for (const { rule } of outgoing.get(role) ?? []) pending.push(rule.then.role)
    }
    return false
  }
  for (const role of policy.roles) {
    if (role.kind !== 'agent') continue
    const step = steps.get(role.id)!
    for (const parent of role.independentOf) {
      if (parent !== role.id && !hasPredecessorPath(parent, role.id)) {
        problems.push({ kind: 'independent-of', step, text: `"${parent}" has no predecessor path to ${role.id}` })
      }
    }
  }
  // The first matching rule runs. Nothing matching ends a run, so a guarded
  // loop can finish even without a terminal node. An unconditional rule
  // shadows every later rule from that step; never count those as an exit.
  const visited = new Set<string>()
  const canFinish = (role: string): boolean => {
    if (!steps.has(role) || visited.has(role)) return false
    visited.add(role)
    const rules = effective.get(role) ?? []
    if (rules.length === 0 || !isUnconditional(rules[rules.length - 1]!.rule)) return true
    return rules.some(({ rule }) => canFinish(rule.then.role))
  }
  if (steps.has(policy.seed.role) && !canFinish(policy.seed.role)) problems.push({ kind: 'no-finish', text: 'There is no way to finish from the starting step' })
  if (document.invalidPositions || document.invalidNotes) problems.push({ kind: 'layout', text: 'Some saved layout could not be read; the file is unchanged' })
  return problems
}
