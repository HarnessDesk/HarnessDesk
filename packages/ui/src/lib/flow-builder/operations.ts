import type { FlowPolicyRole, FlowPolicyRule, FlowSeat } from '@harnessdesk/protocol'

import { boundedPosition, defaultRole, defaultRule, renameRoleReferences, uniqueId, type GraphPoint } from '../shapes'
import { flowLayout } from '../flow-layout'
import { flowModel } from '../flow-model'
import { recordOf, withNotes, withPositions, type BuilderDocument } from './document'

export type BuilderStepKind = FlowPolicyRole['kind'] | 'agents' | 'note'

// Setting an unchanged field must not make an untouched file dirty or add an undo entry.
const sameValue = (a: unknown, b: unknown): boolean => {
  const key = (value: unknown) => JSON.stringify(value, (_key, raw: unknown) => {
    const record = recordOf(raw)
    return record ? Object.fromEntries(Object.keys(record).sort().map((name) => [name, record[name]])) : raw
  })
  return key(a) === key(b)
}

const stepOf = (document: BuilderDocument, id: string) => {
  const step = document.steps.find((one) => one.id === id)
  if (!step) throw new Error('There is no executable step with this canvas identity')
  return step
}
const ruleOf = (document: BuilderDocument, id: string) => {
  const rule = document.rules.find((one) => one.id === id)
  if (!rule) throw new Error('There is no rule with this canvas identity')
  return rule
}

const allocated = (document: BuilderDocument, prefix: 'step' | 'rule' | 'note'): { id: string; nextId: number } => {
  let nextId = document.nextId
  const taken = new Set([...document.steps, ...document.rules, ...document.notes].map((one) => one.id))
  while (taken.has(`${prefix}-${nextId}`)) nextId += 1
  return { id: `${prefix}-${nextId}`, nextId: nextId + 1 }
}

export const addStep = (document: BuilderDocument, kind: BuilderStepKind, name: string, position?: GraphPoint): BuilderDocument => {
  const identity = allocated(document, kind === 'note' ? 'note' : 'step')
  if (kind === 'note') {
    const point = position ? boundedPosition(position.x, position.y) : { x: 32, y: 32 }
    if (!point) return document
    return withNotes({ ...document, nextId: identity.nextId }, [...document.notes, { id: identity.id, text: name, position: point }])
  }
  // Leave room for uniqueId's suffix even when the label is very long.
  const id = uniqueId(name.slice(0, 40), new Set(document.policy.roles.map((role) => role.id)))
  const role = kind === 'agents' ? { ...defaultRole('agent', id), count: 2 } : defaultRole(kind, id)
  const policy = { ...document.policy, roles: [...document.policy.roles, role] }
  const auto = flowLayout({ ...flowModel(policy), positions: {} }).nodes.find((node) => node.id === id)!.box
  const point = position ? boundedPosition(position.x, position.y) : { x: auto.x, y: auto.y }
  if (!point) return document
  const next = {
    ...document, nextId: identity.nextId, policy,
    steps: [...document.steps, { id: identity.id, role: id }],
    positions: { ...document.positions, [identity.id]: point },
  }
  // Only a deliberate placement writes positions; auto layout on read/add stays a view default.
  return position ? withPositions(next, next.positions) : next
}

/** Drawing an answer opens one round; evidence and richer guards can be set separately. */
export const connectSteps = (document: BuilderDocument, from: string, to: string, word?: string): BuilderDocument => {
  const on = stepOf(document, from).role
  const target = stepOf(document, to).role
  const identity = allocated(document, 'rule')
  const id = uniqueId(`${on}-to-${target}`.slice(0, 40), new Set(document.policy.rules.map((rule) => rule.id)), 'rule')
  const rule = { ...defaultRule(id, on, target), ...(word ? { when: { every: [word] } } : {}) }
  return {
    ...document, nextId: identity.nextId,
    policy: { ...document.policy, rules: [...document.policy.rules, rule] },
    rules: [...document.rules, { id: identity.id, rule: id }],
  }
}

const updateRule = (document: BuilderDocument, id: string, change: (rule: FlowPolicyRule) => FlowPolicyRule): BuilderDocument => {
  const name = ruleOf(document, id).rule
  const index = document.policy.rules.findIndex((rule) => rule.id === name)
  const before = document.policy.rules[index]!
  const after = change(before)
  if (after === before) return document
  return { ...document, policy: { ...document.policy, rules: document.policy.rules.map((rule, at) => at === index ? after : rule) } }
}

/** Replace the condition in the engine's own vocabulary, never parse an expression. */
export const setRuleCondition = (document: BuilderDocument, id: string, when: FlowPolicyRule['when']): BuilderDocument => (
  updateRule(document, id, (rule) => {
    if (sameValue(rule.when, when)) return rule
    const { when: _before, ...rest } = rule
    return when === undefined ? rest : { ...rest, when }
  })
)

/** One answer word replaces outcome clauses, keeping every evidence guard. Null removes only the answers. */
export const setRuleWord = (document: BuilderDocument, id: string, word: string | null, quantifier: 'every' | 'any' = 'every'): BuilderDocument => {
  const rule = document.policy.rules.find((one) => one.id === ruleOf(document, id).rule)!
  const evidence = rule.when?.evidence
  const when = { ...(word === null ? {} : { [quantifier]: [word] }), ...(evidence?.length ? { evidence } : {}) }
  return setRuleCondition(document, id, Object.keys(when).length ? when : undefined)
}

export const renameRule = (document: BuilderDocument, id: string, name: string): BuilderDocument => {
  const before = ruleOf(document, id)
  if (before.rule === name) return document
  if (document.policy.rules.some((rule) => rule.id === name)) throw new Error('A rule with this name already exists')
  return {
    ...updateRule(document, id, (rule) => ({ ...rule, id: name })),
    rules: document.rules.map((rule) => rule.id === id ? { ...rule, rule: name } : rule),
  }
}

/**
 * The common rename helper owns seed, endpoints and independentOf. A builder
 * also carries split providers, check-id guards and position keys; update
 * those together without touching a check's command or an Agent's name.
 */
export const renameStep = (document: BuilderDocument, id: string, name: string): BuilderDocument => {
  const note = document.notes.find((one) => one.id === id)
  if (note) return note.text === name ? document : withNotes(document, document.notes.map((one) => one.id === id ? { ...one, text: name } : one))
  const from = stepOf(document, id).role
  if (from === name) return document
  if (document.policy.roles.some((role) => role.id === name)) throw new Error('A step with this name already exists')
  const oldRole = document.policy.roles.find((role) => role.id === from)!
  let policy = renameRoleReferences(document.policy, from, name)
  const splitOf = (then: FlowPolicyRule['then']) => then.split === from ? { ...then, split: name } : then
  policy = {
    ...policy,
    roles: policy.roles.map((role) => role.id === from ? { ...role, id: name } : role),
    seed: splitOf(policy.seed),
    rules: policy.rules.map((rule) => ({
      ...rule, then: splitOf(rule.then),
      ...(oldRole.kind === 'check' && rule.when?.evidence ? { when: {
        ...rule.when, evidence: rule.when.evidence.map((guard) => 'check' in guard && guard.check === from ? { check: name } : guard),
      } } : {}),
    })),
  }
  const layout = recordOf(policy.layout)
  const raw = recordOf(layout?.['positions'])
  if (layout && raw && Object.hasOwn(raw, from)) {
    policy = { ...policy, layout: { ...layout, positions: Object.fromEntries(Object.entries(raw).map(([key, value]) => [key === from ? name : key, value])) } }
  }
  return { ...document, policy, steps: document.steps.map((step) => step.id === id ? { ...step, role: name } : step) }
}

export const moveStep = (document: BuilderDocument, id: string, position: GraphPoint): BuilderDocument => {
  const point = boundedPosition(position.x, position.y)
  if (!point) return document
  const note = document.notes.find((one) => one.id === id)
  const before = note?.position ?? document.positions[stepOf(document, id).id]!
  if (point.x === before.x && point.y === before.y) return document
  return note
    ? withNotes(document, document.notes.map((one) => one.id === id ? { ...one, position: point } : one))
    : withPositions(document, { ...document.positions, [id]: point })
}

export const deleteRule = (document: BuilderDocument, id: string): BuilderDocument => {
  const name = ruleOf(document, id).rule
  return { ...document, rules: document.rules.filter((rule) => rule.id !== id), policy: { ...document.policy, rules: document.policy.rules.filter((rule) => rule.id !== name) } }
}

/**
 * Delete dependent transitions as a whole: dropping one guard or a split
 * alone would widen what can run. A deleted seed remains a missing seed,
 * never an implicitly chosen new start. Unrelated downstream steps stay so
 * the person can reconnect them, with an unreachable advisory.
 */
export const deleteStep = (document: BuilderDocument, id: string): BuilderDocument => {
  if (document.notes.some((one) => one.id === id)) return withNotes(document, document.notes.filter((one) => one.id !== id))
  const name = stepOf(document, id).role
  const removed = document.policy.roles.find((role) => role.id === name)!
  const dependent = (rule: FlowPolicyRule): boolean => rule.on === name || rule.then.role === name || rule.then.split === name
    || (removed.kind === 'check' && (rule.when?.evidence?.some((guard) => 'check' in guard && (guard.check === name || guard.check === removed.check.run)) ?? false))
  const rules = document.policy.rules.filter((rule) => !dependent(rule))
  const retained = new Set(rules.map((rule) => rule.id))
  let policy = {
    ...document.policy, rules,
    roles: document.policy.roles.filter((role) => role.id !== name).map((role) => role.kind === 'agent' && role.independentOf.includes(name)
      ? { ...role, independentOf: role.independentOf.filter((parent) => parent !== name) } : role),
  }
  const layout = recordOf(policy.layout)
  const raw = recordOf(layout?.['positions'])
  if (layout && raw && Object.hasOwn(raw, name)) policy = { ...policy, layout: { ...layout, positions: Object.fromEntries(Object.entries(raw).filter(([key]) => key !== name)) } }
  return {
    ...document, policy, steps: document.steps.filter((step) => step.id !== id),
    rules: document.rules.filter((rule) => retained.has(rule.rule)),
    positions: Object.fromEntries(Object.entries(document.positions).filter(([key]) => key !== id)),
  }
}

const updateAgent = (document: BuilderDocument, id: string, update: (role: Extract<FlowPolicyRole, { kind: 'agent' }>) => FlowPolicyRole): BuilderDocument => {
  const name = stepOf(document, id).role
  const before = document.policy.roles.find((role) => role.id === name)!
  if (before.kind !== 'agent') throw new Error('Only an Agent step has Agents and seats')
  const after = update(before)
  if (sameValue(before, after)) return document
  return { ...document, policy: { ...document.policy, roles: document.policy.roles.map((role) => role === before ? after : role) } }
}

/** An empty override means the named Agent's own seating preferences, as on the ordered editor. */
export const setSeat = (document: BuilderDocument, id: string, seats: readonly FlowSeat[]): BuilderDocument => updateAgent(document, id, (role) => ({ ...role, seats }))
export const setAgent = (document: BuilderDocument, id: string, uses: readonly string[]): BuilderDocument => updateAgent(document, id, (role) => ({ ...role, uses }))
