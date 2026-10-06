import { SHAPE_LAYOUT_LIMIT, SHAPE_LAYOUT_SIZE_LIMIT, type FlowPolicyRole, type FlowPolicyRule, type FlowSeat } from '@harnessdesk/protocol'

import { boundedPosition, defaultRole, defaultRule, renameRoleReferences, uniqueId, type GraphPoint } from '../shapes'
import { FLOW_CARD_H, FLOW_CARD_W, FLOW_ROW_GAP, flowLayout } from '../flow-layout'
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

const FLOW_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const FLOW_SLOT_LIMIT = 32
const requireFlowId = (value: string, subject: string): void => {
  if (!FLOW_ID.test(value)) throw new Error(`${subject} must use 1–64 letters, digits, - or _`)
}
const requireFlowAnswer = (value: string): void => {
  if (value.trim() === '' || value.length > 200) throw new Error('A rule answer must be non-empty and at most 200 characters')
}
const requireFlowAnswers = (when: FlowPolicyRule['when']): void => {
  for (const words of [when?.every, when?.any]) {
    if (!words) continue
    if (words.length > 64) throw new Error('A rule answer list can have at most 64 entries')
    words.forEach(requireFlowAnswer)
  }
}

const isUnconditional = (rule: FlowPolicyRule): boolean => (
  !rule.when?.every?.length && !rule.when?.any?.length && !rule.when?.evidence?.length
)

const withCheckedNotes = (document: BuilderDocument, notes: BuilderDocument['notes']): BuilderDocument => {
  if (notes.length > SHAPE_LAYOUT_LIMIT) throw new Error(`A Flow can have at most ${SHAPE_LAYOUT_LIMIT} notes`)
  if (notes.some((note) => note.text.length > 2000)) throw new Error('A note must be 2,000 characters or fewer')
  const next = withNotes(document, notes)
  if ((JSON.stringify(next.policy.layout)?.length ?? 0) > SHAPE_LAYOUT_SIZE_LIMIT) throw new Error('Builder notes would make layout exceed 64 KiB')
  return next
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
    if (document.notes.length >= SHAPE_LAYOUT_LIMIT) throw new Error(`A Flow can have at most ${SHAPE_LAYOUT_LIMIT} notes`)
    if (name.length > 2000) throw new Error('A note must be 2,000 characters or fewer')
    const point = position ? boundedPosition(position.x, position.y) : { x: 32, y: 32 }
    if (!point) return document
    return withCheckedNotes({ ...document, nextId: identity.nextId }, [...document.notes, { id: identity.id, text: name, position: point }])
  }
  // Leave room for uniqueId's suffix even when the label is very long.
  const id = uniqueId(name.slice(0, 40), new Set(document.policy.roles.map((role) => role.id)))
  const role = kind === 'agents' ? { ...defaultRole('agent', id), count: 2 } : defaultRole(kind, id)
  const policy = { ...document.policy, roles: [...document.policy.roles, role] }
  const placed = Object.fromEntries(document.steps.map((step) => [step.role, document.positions[step.id]!]))
  const autoLayout = flowLayout({ ...flowModel(policy), positions: placed })
  const auto = autoLayout.nodes.find((node) => node.id === id)!.box
  const firstPlaced = document.steps[0]
  const firstBox = firstPlaced ? autoLayout.nodes.find((node) => node.id === firstPlaced.role)!.box : null
  const firstPoint = firstPlaced ? document.positions[firstPlaced.id]! : null
  const offset = firstBox && firstPoint ? { x: firstBox.x - firstPoint.x, y: firstBox.y - firstPoint.y } : { x: 0, y: 0 }
  let point = position ? boundedPosition(position.x, position.y) : boundedPosition(auto.x - offset.x, auto.y - offset.y)
  if (!point) return document
  if (!position) {
    const overlapsPlacedStep = (candidate: GraphPoint): boolean => Object.values(document.positions).some((other) => (
      candidate.x < other.x + FLOW_CARD_W && candidate.x + FLOW_CARD_W > other.x
      && candidate.y < other.y + FLOW_CARD_H && candidate.y + FLOW_CARD_H > other.y
    ))
    while (overlapsPlacedStep(point)) {
      const nextPoint = boundedPosition(point.x, point.y + FLOW_CARD_H + FLOW_ROW_GAP)
      if (!nextPoint || nextPoint.y === point.y) throw new Error('There is no free position for another step')
      point = nextPoint
    }
  }
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
  if (word !== undefined) requireFlowAnswer(word)
  const on = stepOf(document, from).role
  const target = stepOf(document, to).role
  const identity = allocated(document, 'rule')
  const id = uniqueId(`${on}-to-${target}`.slice(0, 40), new Set(document.policy.rules.map((rule) => rule.id)), 'rule')
  const rule = { ...defaultRule(id, on, target), ...(word === undefined ? {} : { when: { every: [word] } }) }
  const at = word !== undefined
    ? document.policy.rules.findIndex((existing) => existing.on === on && isUnconditional(existing))
    : -1
  const index = at < 0 ? document.policy.rules.length : at
  const policyRules = [...document.policy.rules]
  policyRules.splice(index, 0, rule)
  const identities = [...document.rules]
  identities.splice(index, 0, { id: identity.id, rule: id })
  return {
    ...document, nextId: identity.nextId,
    policy: { ...document.policy, rules: policyRules },
    rules: identities,
  }
}

const updateRule = (document: BuilderDocument, id: string, change: (rule: FlowPolicyRule) => FlowPolicyRule): BuilderDocument => {
  ruleOf(document, id)
  const index = document.rules.findIndex((rule) => rule.id === id)
  const before = document.policy.rules[index]!
  const after = change(before)
  if (after === before) return document
  return { ...document, policy: { ...document.policy, rules: document.policy.rules.map((rule, at) => at === index ? after : rule) } }
}

/** Replace the condition in the engine's own vocabulary, never parse an expression. */
export const setRuleCondition = (document: BuilderDocument, id: string, when: FlowPolicyRule['when']): BuilderDocument => {
  requireFlowAnswers(when)
  return updateRule(document, id, (rule) => {
    if (sameValue(rule.when, when)) return rule
    const { when: _before, ...rest } = rule
    return when === undefined ? rest : { ...rest, when }
  })
}

/** One answer word replaces outcome clauses, keeping every evidence guard. Null removes only the answers. */
export const setRuleWord = (document: BuilderDocument, id: string, word: string | null, quantifier: 'every' | 'any' = 'every'): BuilderDocument => {
  ruleOf(document, id)
  if (word !== null) requireFlowAnswer(word)
  const index = document.rules.findIndex((one) => one.id === id)
  const rule = document.policy.rules[index]!
  const evidence = rule.when?.evidence
  const when = { ...(word === null ? {} : { [quantifier]: [word] }), ...(evidence?.length ? { evidence } : {}) }
  return setRuleCondition(document, id, Object.keys(when).length ? when : undefined)
}

export const renameRule = (document: BuilderDocument, id: string, name: string): BuilderDocument => {
  const before = ruleOf(document, id)
  if (before.rule === name) return document
  requireFlowId(name, `Rule "${before.rule}" name`)
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
  if (note) return note.text === name ? document : withCheckedNotes(document, document.notes.map((one) => one.id === id ? { ...one, text: name } : one))
  const from = stepOf(document, id).role
  if (from === name) return document
  requireFlowId(name, `Step "${from}" name`)
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
  ruleOf(document, id)
  const index = document.rules.findIndex((rule) => rule.id === id)
  return {
    ...document,
    rules: document.rules.filter((_rule, at) => at !== index),
    policy: { ...document.policy, rules: document.policy.rules.filter((_rule, at) => at !== index) },
  }
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
  const removedRuleIndexes = new Set<number>()
  const rules = document.policy.rules.filter((rule, index) => {
    if (!dependent(rule)) return true
    removedRuleIndexes.add(index)
    return false
  })
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
    rules: document.rules.filter((_rule, index) => !removedRuleIndexes.has(index)),
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

const reconciledCount = (selected: number, other: number, current: number | undefined): number | undefined => {
  const width = Math.max(selected, other)
  return width > 1 && current !== undefined ? width : current
}

/** An empty override means the named Agent's own seating preferences, as on the ordered editor. */
export const setSeat = (document: BuilderDocument, id: string, seats: readonly FlowSeat[]): BuilderDocument => updateAgent(document, id, (role) => ({
  ...role,
  seats,
  count: reconciledCount(seats.length, role.uses.length, role.count),
}))
export const setAgent = (document: BuilderDocument, id: string, uses: readonly string[]): BuilderDocument => updateAgent(document, id, (role) => ({
  ...role,
  uses,
  count: reconciledCount(uses.length, role.seats.length, role.count),
}))
/** Set the explicit width used when neither the Agent nor seat list defines one. */
export const setCount = (document: BuilderDocument, id: string, count: number | undefined): BuilderDocument => updateAgent(document, id, (role) => {
  if (count !== undefined && (!Number.isSafeInteger(count) || count < 1 || count > FLOW_SLOT_LIMIT)) {
    throw new Error(`Count must be a whole number from 1 to ${FLOW_SLOT_LIMIT}.`)
  }
  const listWidth = Math.max(role.uses.length, role.seats.length)
  if (count !== undefined && listWidth > 1 && count !== listWidth) {
    throw new Error(`Count must match the ${listWidth}-entry Agent or seat list.`)
  }
  if (role.count === count) return role
  const { count: _before, ...rest } = role
  return count === undefined ? rest : { ...rest, count }
})

/** Pick the executable step that starts this draft, preserving its title and other seed fields. */
export const setSeed = (document: BuilderDocument, id: string): BuilderDocument => {
  const role = stepOf(document, id).role
  return document.policy.seed.role === role ? document : {
    ...document,
    policy: { ...document.policy, seed: { ...document.policy.seed, role } },
  }
}
