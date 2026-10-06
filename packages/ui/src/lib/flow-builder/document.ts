import { SHAPE_LAYOUT_LIMIT, type FlowPolicy, type FlowPolicyRole, type FlowPolicyRule } from '@harnessdesk/protocol'

import { flowLayout } from '../flow-layout'
import { flowModel, type FlowRuleView, type FlowStep } from '../flow-model'
import { boundedPosition, readGraphPositions, type GraphPoint } from '../shapes'

/** A canvas identity is independent of the editable name in the Flow file. */
export interface StepIdentity { readonly id: string; readonly role: string }
export interface RuleIdentity { readonly id: string; readonly rule: string }
export interface BuilderNote { readonly id: string; readonly text: string; readonly position: GraphPoint }

/**
 * FlowPolicy stays the only executable document. Positions and notes are
 * inert layout metadata; canvas identities and source provenance live only
 * for this editing session. Read an incoming source with the host first,
 * then pass its policy and exact bytes together here.
 */
export interface BuilderDocument {
  readonly policy: FlowPolicy
  readonly steps: readonly StepIdentity[]
  readonly rules: readonly RuleIdentity[]
  readonly positions: Readonly<Record<string, GraphPoint>>
  readonly notes: readonly BuilderNote[]
  readonly invalidPositions: boolean
  readonly invalidNotes: boolean
  readonly nextId: number
  readonly original?: { readonly policy: FlowPolicy; readonly source: string }
}

export const recordOf = (value: unknown): Record<string, unknown> | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
)

/** Compare a value, optionally requiring every object level to have the same keys. */
const matchesOwnedFields = (actual: unknown, expected: unknown, exact = false): boolean => {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length
      && expected.every((value, index) => matchesOwnedFields(actual[index], value, exact))
  }
  const expectedRecord = recordOf(expected)
  if (expectedRecord) {
    const actualRecord = recordOf(actual)
    if (!actualRecord) return false
    const entries = Object.entries(expectedRecord)
    if (exact && (Object.keys(actualRecord).length !== entries.length || entries.some(([key]) => !Object.hasOwn(actualRecord, key)))) return false
    return entries.every(([key, value]) => matchesOwnedFields(actualRecord[key], value, exact))
  }
  return Object.is(actual, expected)
}

/** The graph and data wrappers may carry canvas state; model fields may not. */
const matchesGraphData = (actual: unknown, expected: unknown): boolean => {
  const actualRecord = recordOf(actual)
  const expectedRecord = recordOf(expected)
  return actualRecord !== null && expectedRecord !== null
    && Object.entries(expectedRecord).every(([key, value]) => (
      matchesOwnedFields(actualRecord[key], value, key === 'role' || key === 'rule' || key === 'view')
    ))
}

const readNotes = (policy: FlowPolicy): { notes: BuilderNote[]; invalid: boolean } => {
  const raw = recordOf(recordOf(policy.layout)?.['builder'])?.['notes']
  if (raw === undefined) return { notes: [], invalid: false }
  if (!Array.isArray(raw)) return { notes: [], invalid: true }
  const notes: BuilderNote[] = []
  const seen = new Set<string>()
  let invalid = raw.length > SHAPE_LAYOUT_LIMIT
  for (const entry of raw.slice(0, SHAPE_LAYOUT_LIMIT)) {
    const note = recordOf(entry)
    const id = note?.['id']
    const text = note?.['text']
    const position = recordOf(note?.['position'])
    const x = position?.['x']
    const y = position?.['y']
    const point = typeof x === 'number' && typeof y === 'number' ? boundedPosition(x, y) : null
    if (typeof id !== 'string' || !/^note-\d+$/.test(id) || seen.has(id) || typeof text !== 'string' || text.length > 2000 || !point || point.x !== x || point.y !== y) {
      invalid = true
      continue
    }
    seen.add(id)
    notes.push({ id, text, position: point })
  }
  return { notes, invalid }
}

export const createDocument = (policy: FlowPolicy, source?: string): BuilderDocument => {
  let nextId = 1
  const steps = policy.roles.map((role) => ({ id: `step-${nextId++}`, role: role.id }))
  const rules = policy.rules.map((rule) => ({ id: `rule-${nextId++}`, rule: rule.id }))
  const hand = readGraphPositions(policy)
  const model = flowModel(policy)
  // Explicit positions are used exactly, including negative coordinates.
  // Compute missing positions from the existing layout, without its display normalization.
  const auto = new Map(flowLayout({ ...model, positions: {} }).nodes.map((node) => [
    node.id,
    boundedPosition(node.box.x, node.box.y)!,
  ]))
  const positions = Object.fromEntries(steps.map((step) => [step.id, (Object.hasOwn(hand.positions, step.role) ? hand.positions[step.role] : undefined) ?? auto.get(step.role)!]))
  const read = readNotes(policy)
  const noteIds = new Set(read.notes.map((note) => note.id))
  while (noteIds.has(`note-${nextId}`)) nextId += 1
  return {
    policy, steps, rules, positions, notes: read.notes, nextId,
    invalidPositions: hand.invalid, invalidNotes: read.invalid,
    ...(source === undefined ? {} : { original: { policy, source } }),
  }
}

/** No serialization here: the caller hands this policy to the host's render. */
export const documentPolicy = (document: BuilderDocument): FlowPolicy => document.policy

export type SourceRequest = { readonly kind: 'source'; readonly source: string } | { readonly kind: 'render'; readonly policy: FlowPolicy }

/** Untouched source keeps all its bytes; an edit asks the one owning renderer. Undo restores provenance too. */
export const sourceRequest = (document: BuilderDocument): SourceRequest => (
  document.original?.policy === document.policy
    ? { kind: 'source', source: document.original.source }
    : { kind: 'render', policy: document.policy }
)

export type BuilderNode = {
  readonly id: string
  readonly position: GraphPoint
  readonly data: { readonly kind: 'step'; readonly role: FlowPolicyRole; readonly view: FlowStep }
} | {
  readonly id: string
  readonly position: GraphPoint
  readonly data: { readonly kind: 'note'; readonly text: string }
}

export interface BuilderEdge {
  readonly id: string
  /** A broken rule is still an edge in the model, with a missing endpoint. */
  readonly source: string | null
  readonly target: string | null
  readonly data: { readonly rule: FlowPolicyRule; readonly view: FlowRuleView }
}
export interface BuilderGraph { readonly nodes: readonly BuilderNode[]; readonly edges: readonly BuilderEdge[] }

export const documentGraph = (document: BuilderDocument): BuilderGraph => {
  const model = flowModel(document.policy)
  const byRole = new Map(document.steps.map((step) => [step.role, step.id]))
  return {
    nodes: [
      ...document.steps.map((step, index): BuilderNode => ({
        id: step.id, position: document.positions[step.id]!,
        data: { kind: 'step', role: document.policy.roles[index]!, view: model.steps[index]! },
      })),
      ...document.notes.map((note): BuilderNode => ({ id: note.id, position: note.position, data: { kind: 'note', text: note.text } })),
    ],
    edges: document.rules.map((edge, index) => {
      const rule = document.policy.rules[index]!
      return { id: edge.id, source: byRole.get(rule.on) ?? null, target: byRole.get(rule.then.role) ?? null, data: { rule, view: model.rules[index]! } }
    }),
  }
}

/** Preserve unknown layout siblings; a deliberate note edit replaces only builder.notes. */
export const withNotes = (document: BuilderDocument, notes: readonly BuilderNote[]): BuilderDocument => {
  const layout = recordOf(document.policy.layout) ?? {}
  const builder = recordOf(layout['builder']) ?? {}
  return { ...document, notes, invalidNotes: false, policy: { ...document.policy, layout: { ...layout, builder: { ...builder, notes } } } }
}

/** Persist the positions of every step only when a person changes layout. */
export const withPositions = (document: BuilderDocument, positions: Readonly<Record<string, GraphPoint>>): BuilderDocument => {
  const layout = recordOf(document.policy.layout) ?? {}
  const byRole = Object.fromEntries(document.steps.map((step) => [step.role, positions[step.id]!]))
  return { ...document, positions, invalidPositions: false, policy: { ...document.policy, layout: { ...layout, positions: byRole } } }
}

/**
 * Reverse projection for position changes from a canvas. Semantic changes
 * go through operations, which keep references together and preserve rule
 * order. A stale or incomplete graph is refused instead of silently deleting
 * work; use deleteStep/deleteRule for deliberate deletions.
 */
export const graphDocument = (document: BuilderDocument, graph: BuilderGraph): BuilderDocument => {
  const expected = documentGraph(document)
  const seen = new Set<string>()
  for (const item of [...graph.nodes, ...graph.edges]) {
    if (seen.has(item.id)) throw new Error('Duplicate canvas identity')
    seen.add(item.id)
  }
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]))
  const edges = new Map(graph.edges.map((edge) => [edge.id, edge]))
  if (nodes.size !== expected.nodes.length || edges.size !== expected.edges.length) throw new Error('Use document operations to add or delete steps and rules')
  let next = document
  const positions = { ...document.positions }
  let positionsChanged = false
  const notes = [...document.notes]
  let notesChanged = false
  for (const before of expected.nodes) {
    const node = nodes.get(before.id)
    if (!node || !matchesGraphData(node.data, before.data)) throw new Error('Use document operations to edit a step')
    const point = boundedPosition(node.position.x, node.position.y)
    if (!point) throw new Error('A position must be finite')
    const position = {
      x: node.position.x === before.position.x ? before.position.x : point.x,
      y: node.position.y === before.position.y ? before.position.y : point.y,
    }
    if (position.x === before.position.x && position.y === before.position.y) continue
    if (before.data.kind === 'step') {
      positions[before.id] = position
      positionsChanged = true
    } else {
      const index = notes.findIndex((note) => note.id === before.id)
      notes[index] = { ...notes[index]!, position }
      notesChanged = true
    }
  }
  for (const before of expected.edges) {
    const edge = edges.get(before.id)
    if (!edge || edge.source !== before.source || edge.target !== before.target
      || !matchesGraphData(edge.data, before.data)) throw new Error('Use document operations to edit a rule')
  }
  if (positionsChanged) next = withPositions(next, positions)
  if (notesChanged) next = withNotes(next, notes)
  return next
}
