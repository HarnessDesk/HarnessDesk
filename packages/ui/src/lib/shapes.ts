import {
  SHAPE_BINDING_VALUES,
  SHAPE_LAYOUT_LIMIT,
  SHAPE_POSITION_LIMIT,
  type CeilingLevel, type FlowAgentRole, type FlowCheck, type FlowPolicy, type FlowPolicyRole, type FlowPolicyRule, type FlowThen, type ShapeBindingValue,
} from '@harnessdesk/protocol'

/**
 * Small, pure helpers the ordered editor and its graph share: building a
 * default step or rule, keeping a rename's references together, and finding
 * what a role is used by. None of this decides what is valid — the render
 * call (`authoring/shape/render`, `writeShape` on the host) is the one judge
 * of that, the same parser the dry run and the engine read. This is only the
 * shape a fresh row starts from and the bookkeeping a rename or a removal
 * needs before it asks the host anything.
 */

/** Every step kind, named in the plain word the editor shows for it. */
export const ROLE_KIND_WORDS: Readonly<Record<FlowPolicyRole['kind'], string>> = {
  agent: 'Agent', check: 'Check', person: 'Person',
}
export const ROLE_KINDS: readonly FlowPolicyRole['kind'][] = ['agent', 'check', 'person']

/** A role or rule id from a label a person typed, made unique against what already exists. */
export const uniqueId = (base: string, taken: ReadonlySet<string>, fallback = 'step'): string => {
  const slug = base.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || fallback
  if (!taken.has(slug)) return slug
  for (let n = 2; ; n += 1) {
    const next = `${slug}-${n}`.slice(0, 48)
    if (!taken.has(next)) return next
  }
}

const DEFAULT_CHECK: FlowCheck = { run: '', timeout: 900, exits: { '0': 'pass' }, otherwise: 'fail' }

export const defaultAgentRole = (id: string): FlowAgentRole => ({
  id, kind: 'agent', uses: [], seats: [], isolate: false, grant: 'read', independentOf: [],
})
export const defaultCheckRole = (id: string): FlowPolicyRole => ({ id, kind: 'check', check: DEFAULT_CHECK })
export const defaultPersonRole = (id: string): FlowPolicyRole => ({ id, kind: 'person', outcomes: ['done'] })

/** A fresh row of the chosen kind — never guessing an Agent, a command or an outcome the file would have to invent. */
export const defaultRole = (kind: FlowPolicyRole['kind'], id: string): FlowPolicyRole => (
  kind === 'agent' ? defaultAgentRole(id) : kind === 'check' ? defaultCheckRole(id) : defaultPersonRole(id)
)

export const defaultThen = (role: string, title = 'Continue'): FlowThen => ({ role, title })
export const defaultRule = (id: string, on: string, targetRole: string): FlowPolicyRule => ({ id, on, then: defaultThen(targetRole) })

/**
 * An empty valid draft: one person step and nothing else. No Agent is
 * guessed and no startup happens while authoring — the decision "Your own
 * shape starts from a chosen file or an empty valid draft with a person
 * step."
 */
export const emptyShapePolicy = (name = 'Your own shape'): FlowPolicy => ({
  version: 2,
  name,
  inputs: [{ id: 'task', label: 'Task' }],
  roles: [{ id: 'review', kind: 'person', outcomes: ['done'] }],
  rules: [],
  seed: { role: 'review', title: '{{task}}' },
  messaging: 'board-only',
  wait: 240,
})

/**
 * Renaming a role updates every place that names it, together: the decision
 * "Renaming a role shows the affected seed/rules and updates references
 * together in the draft." Reordering never calls this — only an actual id
 * change does, and roles/rules stay addressed by that id, never by array
 * position.
 */
export const renameRoleReferences = (policy: FlowPolicy, from: string, to: string): FlowPolicy => {
  if (from === to) return policy
  return {
    ...policy,
    roles: policy.roles.map((role) => (
      role.kind === 'agent' && role.independentOf.includes(from)
        ? { ...role, independentOf: role.independentOf.map((id) => (id === from ? to : id)) }
        : role
    )),
    rules: policy.rules.map((rule) => ({
      ...rule,
      on: rule.on === from ? to : rule.on,
      then: { ...rule.then, role: rule.then.role === from ? to : rule.then.role },
    })),
    seed: { ...policy.seed, role: policy.seed.role === from ? to : policy.seed.role },
  }
}

/** Every rule that names this role, on either side — what removal checks before it refuses. */
export const rulesReferencing = (policy: FlowPolicy, roleId: string): readonly FlowPolicyRule[] =>
  policy.rules.filter((rule) => rule.on === roleId || rule.then.role === roleId)

/** Whether removing this role is safe: nothing left still points at it, and it is not the seed. */
export const roleRemovable = (policy: FlowPolicy, roleId: string): boolean =>
  policy.seed.role !== roleId && rulesReferencing(policy, roleId).length === 0

export const CEILINGS: readonly CeilingLevel[] = ['read', 'edit', 'publish', 'merge']

/** A short list of words, one per line — the same idiom `AgentFields` uses for `answers`/`produces`. */
export const wordLines = (words: readonly string[]): string => words.join('\n')
export const parseWordLines = (text: string): string[] => text.split('\n').map((line) => line.trim()).filter(Boolean)

/** `exits:` as one line per code — "0: pass" — the plain-text form the check editor shows and edits. */
export const exitLines = (exits: Readonly<Record<string, string>>): string =>
  Object.entries(exits).map(([code, outcome]) => `${code}: ${outcome}`).join('\n')
export const parseExitLines = (text: string): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const match = /^(\d+)\s*:\s*(.+)$/.exec(trimmed)
    if (match) out[match[1]!] = match[2]!.trim()
  }
  return out
}

// ------------------------------------------------------------------- graph

export type GraphPoint = { readonly x: number; readonly y: number }
const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const asRecord = (value: unknown): Record<string, unknown> | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
)

/**
 * `layout.positions`, read defensively for display: an unrecognized shape,
 * an unknown role, a prototype key or a coordinate outside
 * `SHAPE_POSITION_LIMIT` is dropped rather than shown or crashing the
 * canvas — the decision "ignore invalid untrusted layout only for safe read
 * display... never erase it on read" (this never writes anything; the file's
 * own bytes are untouched either way). `invalid` says whether anything was
 * dropped, so the graph can show that it happened without guessing what a
 * broken entry meant.
 */
export const readGraphPositions = (policy: FlowPolicy): { readonly positions: Readonly<Record<string, GraphPoint>>; readonly invalid: boolean } => {
  const layout = asRecord(policy.layout)
  const raw = layout ? asRecord(layout['positions']) : null
  if (!raw) return { positions: {}, invalid: false }
  const roles = new Set(policy.roles.map((role) => role.id))
  const positions: Record<string, GraphPoint> = {}
  let invalid = false
  const keys = Object.keys(raw).slice(0, SHAPE_LAYOUT_LIMIT)
  if (Object.keys(raw).length > SHAPE_LAYOUT_LIMIT) invalid = true
  for (const key of keys) {
    if (PROTOTYPE_KEYS.has(key) || !roles.has(key)) { invalid = true; continue }
    const point = asRecord(raw[key])
    const x = point?.['x']
    const y = point?.['y']
    const bounded = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= SHAPE_POSITION_LIMIT
    if (point && bounded(x) && bounded(y) && Object.keys(point).every((name) => name === 'x' || name === 'y')) {
      positions[key] = { x, y }
    } else {
      invalid = true
    }
  }
  return { positions, invalid }
}

/** A position a drag or a keyboard move may propose: finite, bounded, and rounded to a whole number the file can spell exactly. */
export const boundedPosition = (x: number, y: number): GraphPoint | null => {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  const clamp = (value: number): number => Math.max(-SHAPE_POSITION_LIMIT, Math.min(SHAPE_POSITION_LIMIT, Math.round(value)))
  return { x: clamp(x), y: clamp(y) }
}

/**
 * `layout` with `positions` replaced, every other field — `frontDoor`, or a
 * sibling tool's own key — preserved exactly. The one path both the drag
 * handle and the keyboard Move fields commit through.
 */
export const withGraphPositions = (policy: FlowPolicy, positions: Readonly<Record<string, GraphPoint>>): FlowPolicy => {
  const layout = asRecord(policy.layout) ?? {}
  return { ...policy, layout: { ...layout, positions } }
}

/** Stable, deterministic rows — the view default used until a person actually moves a node; never written on its own. */
export const defaultGraphPosition = (index: number): GraphPoint => ({ x: 40, y: 40 + index * 96 })

// -------------------------------------------------------------- front door

/**
 * Which of a shape's inputs `layout.frontDoor.bindings` fills from the start
 * context's own facts (a branch, a base, a head, a pull request), read
 * defensively for display — exactly the `readGraphPositions` idiom: an
 * unrecognized shape, a prototype key, or a binding naming an input this
 * policy does not have is dropped rather than trusted. This never decides
 * what the host actually binds; it only tells a screen which of the inputs it
 * is about to render came from the context rather than from a person, so it
 * can show that one as the fact it is instead of a field that looks editable
 * and refuses the edit.
 */
export const boundInputIds = (policy: FlowPolicy): ReadonlySet<string> => new Set(boundInputValues(policy).keys())

/**
 * The same reading as `boundInputIds`, naming which resolved fact — a
 * branch, a base, a head, a pull request, a diff — each bound input takes.
 * `head` and `base` are commits; a screen that shows one short still owes
 * the exact value somewhere a person can read it, since this is the only
 * place that knows which bound inputs are shas and which are not.
 */
export const boundInputValues = (policy: FlowPolicy): ReadonlyMap<string, ShapeBindingValue> => {
  const layout = asRecord(policy.layout)
  const frontDoor = layout ? asRecord(layout['frontDoor']) : null
  const raw = frontDoor ? frontDoor['bindings'] : null
  if (!Array.isArray(raw)) return new Map()
  const ids = new Set(policy.inputs.map((input) => input.id))
  const kinds: readonly string[] = SHAPE_BINDING_VALUES
  const bound = new Map<string, ShapeBindingValue>()
  for (const entry of raw.slice(0, SHAPE_LAYOUT_LIMIT)) {
    const record = asRecord(entry)
    const id = record?.['input']
    const value = record?.['value']
    if (typeof id === 'string' && !PROTOTYPE_KEYS.has(id) && ids.has(id) && typeof value === 'string' && kinds.includes(value)) {
      bound.set(id, value as ShapeBindingValue)
    }
  }
  return bound
}
