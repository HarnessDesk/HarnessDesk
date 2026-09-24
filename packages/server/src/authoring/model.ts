import {
  AGENT_DESCRIPTION_LIMIT,
  AGENT_NAME_LIMIT,
  DEFAULT_FLOW_BUDGET,
  isCeilingLevel,
  SEAT_PREFERENCE_LIMIT,
  SHAPE_BINDING_VALUES,
  SHAPE_LAYOUT_LIMIT,
  SHAPE_POSITION_LIMIT,
  START_CONTEXT_KINDS,
  type AgentDefinition,
  type AgentFieldEdit,
  type AuthoringIssue,
  type FlowPolicy,
  type FlowSeat,
  type ShapeBindingValue,
  type ShapeLayout,
  type StartContext,
  type TriggerDefinition,
} from '@harnessdesk/protocol'

import { parseAgentDefinition } from '../agent-def.js'
import { asRecord, seatSpec, seatWritesCompactly } from '../flow.js'
import { parseFlowPolicy, serializeFlowPolicy } from '../flow-policy.js'
import { AGAIN_TITLE, parseTriggers } from '../intake/definition.js'
import { replaceAgentLine } from './agent-line.js'

/**
 * The authoring model: how a person's edit becomes bytes of a file each
 * owning parser already reads — an `AGENT.md` field, a phase-6 flow, a
 * phase-8 trigger list — and how a flow's reserved `layout:` becomes the
 * front door's shortcuts.
 *
 * Nothing here invents a format, and nothing here is believed on its own:
 * every source this returns has been read back by the parser that owns it and
 * compared with what was asked for, and anything that would read back
 * differently is refused rather than written. Metadata read from a layout
 * offers a shortcut; it never grants, seats or routes anything.
 */

// ------------------------------------------------------------------ shared

/** Key order does not matter; undefined fields are absent. What "the same value" means for a parsed document. */
const canonical = (value: unknown): string => JSON.stringify(value, (_key, raw: unknown) => {
  const record = asRecord(raw)
  if (!record) return raw
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]))
})

const CONTROL = /[\u0000-\u001f\u007f]/
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/** One line of text as a double-quoted scalar every reader here decodes to the same string, or a refusal. */
const quoted = (text: string, what: string): string => {
  if (CONTROL.test(text)) throw new FieldRefusal(`${what} cannot hold a line break, tab or control character.`, `Write ${what} on one line of plain text.`)
  if (LONE_SURROGATE.test(text)) throw new FieldRefusal(`${what} is not valid text.`, `Retype ${what}.`)
  return JSON.stringify(text)
}

class FieldRefusal extends Error {
  constructor(message: string, readonly fix: string) { super(message) }
}

const OPEN_FILE = 'Open the file to change it there.'

// ------------------------------------------------------------ Agent fields

const WORD_LIMIT = 64
const WORD_CHARS = 200

const words = (values: readonly string[], what: string): string[] => {
  if (values.length > WORD_LIMIT) throw new FieldRefusal(`List at most ${WORD_LIMIT} ${what}.`, `Remove ${what} until ${WORD_LIMIT} remain.`)
  return values.map((value) => {
    const word = value.trim()
    if (!word) throw new FieldRefusal(`An entry in ${what} is empty.`, 'Remove the empty entry.')
    if (word.length > WORD_CHARS) throw new FieldRefusal(`An entry in ${what} is longer than ${WORD_CHARS} characters.`, 'Shorten it.')
    return word
  })
}

const seatValue = (seat: FlowSeat): string => {
  const runtime = seat.runtime.trim()
  if (!runtime) throw new FieldRefusal('A seat needs a runtime.', 'Choose which runtime this seat opens.')
  const clean: FlowSeat = {
    runtime,
    ...(seat.model?.trim() ? { model: seat.model.trim() } : {}),
    ...(seat.effort?.trim() ? { effort: seat.effort.trim() } : {}),
    ...(seat.thinking === true ? { thinking: true } : {}),
  }
  if (seatWritesCompactly(clean)) return quoted(seatSpec(clean), 'A seat')
  // The long form, for a model whose name the compact grammar would split.
  const fields = [`runtime: ${quoted(clean.runtime, 'A runtime')}`]
  if (clean.model) fields.push(`model: ${quoted(clean.model, 'A model')}`)
  if (clean.effort) fields.push(`effort: ${quoted(clean.effort, 'An effort')}`)
  if (clean.thinking) fields.push('thinking: true')
  return `{ ${fields.join(', ')} }`
}

/** The value one row edit writes, encoded here and never taken from a caller as text. */
const encodeField = (edit: AgentFieldEdit): { readonly encoded: string; readonly value: unknown } => {
  switch (edit.key) {
    case 'name': {
      const name = edit.value.trim()
      if (!name) throw new FieldRefusal('An Agent needs a name.', 'Type a name.')
      if (name.length > AGENT_NAME_LIMIT) throw new FieldRefusal(`A name is at most ${AGENT_NAME_LIMIT} characters.`, 'Shorten the name.')
      return { encoded: quoted(name, 'The name'), value: name }
    }
    case 'description': {
      const description = edit.value.trim()
      if (description.length > AGENT_DESCRIPTION_LIMIT) {
        throw new FieldRefusal(`A description is at most ${AGENT_DESCRIPTION_LIMIT} characters.`, 'Shorten the description.')
      }
      return { encoded: quoted(description, 'The description'), value: description }
    }
    case 'ceiling': {
      const level: string = edit.value
      if (typeof level !== 'string' || !isCeilingLevel(level)) throw new FieldRefusal('A ceiling is read, edit, publish or merge.', 'Choose one of the four.')
      return { encoded: level, value: level }
    }
    case 'answers':
    case 'produces': {
      const list = words(edit.value, edit.key)
      return { encoded: `[${list.map((word) => quoted(word, `An entry in ${edit.key}`)).join(', ')}]`, value: list }
    }
    case 'prefer': {
      if (edit.value.length > SEAT_PREFERENCE_LIMIT) {
        throw new FieldRefusal(`An Agent may prefer at most ${SEAT_PREFERENCE_LIMIT} seats.`, 'Remove seats until eight remain.')
      }
      const encoded = edit.value.map(seatValue)
      return { encoded: `[${encoded.join(', ')}]`, value: null }
    }
    default:
      throw new FieldRefusal('This field is edited in the file.', OPEN_FILE)
  }
}

const FIELD_OF: Readonly<Record<AgentFieldEdit['key'], keyof AgentDefinition>> = {
  name: 'name', description: 'description', ceiling: 'ceiling', answers: 'answers', produces: 'produces', prefer: 'prefer',
}

/**
 * One row of an Agent, changed in its own file. The whole file is read by the
 * Agent parser before and after the splice: the edited field must read back
 * as exactly the value asked for, and every other field — the brief, the
 * ceiling a hostile name might spell, the warnings a reader was already shown
 * — exactly as it was. Anything else refuses and returns the source
 * untouched, with the file editor as the way forward.
 */
export function editAgentSource(source: string, id: string, edit: AgentFieldEdit): { source: string; issues: readonly AuthoringIssue[] } {
  const refuse = (text: string, fix: string = OPEN_FILE) => ({ source, issues: [{ at: edit.key, text, fix }] })
  const before = parseAgentDefinition(source, id)
  if (!before.agent) {
    const errors = before.problems.filter((one) => one.level === 'error')
    return { source, issues: (errors.length ? errors : [{ at: 'file', text: 'This Agent could not be read.' }]).map((one) => ({ at: one.at, text: one.text, fix: 'Open the file and correct it before editing a field.' })) }
  }
  if (edit.key === 'ceiling' && before.agent.ceilingFrom === 'permission') {
    return refuse('This Agent still says permission:, which is read differently from a ceiling.', 'Update it to a ceiling from the Agent page first, then change it here.')
  }
  let encoded: { readonly encoded: string; readonly value: unknown }
  try {
    encoded = encodeField(edit)
  } catch (error) {
    return error instanceof FieldRefusal ? refuse(error.message, error.fix) : refuse(String(error))
  }
  let next: string
  try {
    next = replaceAgentLine(source, edit.key, encoded.encoded)
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error))
  }
  const after = parseAgentDefinition(next, id)
  if (!after.agent) return refuse('The file would not read as an Agent after this change, so nothing was changed.')
  const field = FIELD_OF[edit.key]
  const wanted = edit.key === 'prefer' ? after.agent.prefer : encoded.value
  if (edit.key === 'prefer') {
    const asked = edit.value.map((seat) => seatSpec({ runtime: seat.runtime.trim(), ...(seat.model?.trim() ? { model: seat.model.trim() } : {}), ...(seat.effort?.trim() ? { effort: seat.effort.trim() } : {}), ...(seat.thinking ? { thinking: true } : {}) }))
    if (canonical(after.agent.prefer.map(seatSpec)) !== canonical(asked)) return refuse('These seats would read back differently, so nothing was changed.')
  }
  const expected = { ...before.agent, [field]: wanted }
  if (canonical(after.agent) !== canonical(expected)) {
    return refuse('This value would change more than its own field, so nothing was changed.')
  }
  const known = new Set(before.problems.map((one) => one.at))
  const added = after.problems.filter((one) => !known.has(one.at))
  if (added.length > 0) return refuse(`This change would add a problem to the file: ${added[0]!.text}`)
  return { source: next, issues: [] }
}

// ------------------------------------------------------------- shape layout

const LAYOUT_FIX = 'Correct the layout entry in the file, or remove it; the flow still runs without it.'
const FRONT_DOOR_KEYS = new Set(['order', 'contexts', 'bindings'])
const BINDING_KEYS = new Set(['input', 'value'])
const POSITION_KEYS = new Set(['x', 'y'])
const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

const frontDoorOf = (raw: unknown, policy: FlowPolicy, issues: AuthoringIssue[]): ShapeLayout['frontDoor'] | undefined => {
  const refuse = (at: string, text: string): undefined => {
    issues.push({ at: `layout.frontDoor${at}`, text: `This flow’s front-door shortcut is off: ${text}`, fix: LAYOUT_FIX })
    return undefined
  }
  const record = asRecord(raw)
  if (!record) return refuse('', 'it is not a map.')
  for (const key of Object.keys(record)) {
    if (!FRONT_DOOR_KEYS.has(key)) return refuse(`.${key}`, `"${key}" is not read here, and layout never grants or seats anything.`)
  }
  const out: { order?: number; contexts?: StartContext['kind'][]; bindings?: { input: string; value: ShapeBindingValue }[] } = {}
  if (record['order'] !== undefined) {
    const order = record['order']
    if (typeof order !== 'number' || !Number.isSafeInteger(order) || order < 0 || order > 1000) return refuse('.order', 'order is a whole number from 0 to 1000.')
    out.order = order
  }
  if (record['contexts'] !== undefined) {
    const contexts = record['contexts']
    if (!Array.isArray(contexts) || contexts.length === 0 || contexts.length > START_CONTEXT_KINDS.length) return refuse('.contexts', 'contexts is a short list of what a start can be about.')
    const seen = new Set<string>()
    for (const kind of contexts) {
      if (typeof kind !== 'string' || !(START_CONTEXT_KINDS as readonly string[]).includes(kind)) return refuse('.contexts', `"${String(kind)}" is not project, branch, pull-request, diff or working-diff.`)
      if (seen.has(kind)) return refuse('.contexts', `"${kind}" is listed twice.`)
      seen.add(kind)
    }
    out.contexts = contexts as StartContext['kind'][]
  }
  if (record['bindings'] !== undefined) {
    const bindings = record['bindings']
    if (!Array.isArray(bindings) || bindings.length > SHAPE_LAYOUT_LIMIT) return refuse('.bindings', `bindings is a list of at most ${SHAPE_LAYOUT_LIMIT} inputs.`)
    const declared = new Set(policy.inputs.map((input) => input.id))
    const seen = new Set<string>()
    const list: { input: string; value: ShapeBindingValue }[] = []
    for (const [index, rawBinding] of bindings.entries()) {
      const binding = asRecord(rawBinding)
      if (!binding || Object.keys(binding).some((key) => !BINDING_KEYS.has(key))) return refuse(`.bindings[${index}]`, 'a binding names one input and one value.')
      const input = binding['input']
      const value = binding['value']
      if (typeof input !== 'string' || !declared.has(input)) return refuse(`.bindings[${index}].input`, `"${String(input)}" is not one of this flow’s inputs.`)
      if (seen.has(input)) return refuse(`.bindings[${index}].input`, `"${input}" is bound twice.`)
      if (typeof value !== 'string' || !(SHAPE_BINDING_VALUES as readonly string[]).includes(value)) {
        return refuse(`.bindings[${index}].value`, 'a binding’s value is branch, base, head, pr or diff.')
      }
      seen.add(input)
      list.push({ input, value: value as ShapeBindingValue })
    }
    out.bindings = list
  }
  return out
}

const positionsOf = (raw: unknown, policy: FlowPolicy, issues: AuthoringIssue[]): ShapeLayout['positions'] | undefined => {
  const refuse = (at: string, text: string): undefined => {
    issues.push({ at: `layout.positions${at}`, text: `Saved positions are ignored: ${text}`, fix: LAYOUT_FIX })
    return undefined
  }
  const record = asRecord(raw)
  if (!record) return refuse('', 'they are not a map of role to { x, y }.')
  const keys = Object.keys(record)
  if (keys.length > SHAPE_LAYOUT_LIMIT) return refuse('', `at most ${SHAPE_LAYOUT_LIMIT} roles have a position.`)
  const roles = new Set(policy.roles.map((role) => role.id))
  const out: Record<string, { x: number; y: number }> = {}
  for (const key of keys) {
    if (PROTOTYPE_KEYS.has(key)) return refuse(`.${key}`, `"${key}" is not a role.`)
    if (!roles.has(key)) return refuse(`.${key}`, `there is no role called "${key}".`)
    const point = asRecord(record[key])
    if (!point || Object.keys(point).some((name) => !POSITION_KEYS.has(name))) return refuse(`.${key}`, 'a position is { x, y } and nothing else.')
    const x = point['x']
    const y = point['y']
    const bounded = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= SHAPE_POSITION_LIMIT
    if (!bounded(x) || !bounded(y)) return refuse(`.${key}`, `a position is two numbers from -${SHAPE_POSITION_LIMIT} to ${SHAPE_POSITION_LIMIT}.`)
    out[key] = { x, y }
  }
  return out
}

/**
 * What a flow's `layout:` offers the authoring surfaces, each recognized part
 * checked on its own: a part that is wrong is dropped with a reason, the
 * others and the flow itself stay. Unknown siblings are left in the file and
 * ignored here.
 */
export function readShapeLayout(policy: FlowPolicy): { readonly layout: ShapeLayout; readonly issues: readonly AuthoringIssue[] } {
  const issues: AuthoringIssue[] = []
  if (policy.layout === undefined || policy.layout === null) return { layout: {}, issues }
  const record = asRecord(policy.layout)
  if (!record) {
    issues.push({ at: 'layout', text: 'This flow’s layout is not a map, so its shortcuts and positions are ignored.', fix: LAYOUT_FIX })
    return { layout: {}, issues }
  }
  const frontDoor = record['frontDoor'] === undefined ? undefined : frontDoorOf(record['frontDoor'], policy, issues)
  const positions = record['positions'] === undefined ? undefined : positionsOf(record['positions'], policy, issues)
  return { layout: { ...(frontDoor ? { frontDoor } : {}), ...(positions ? { positions } : {}) }, issues }
}

export function shapeLayout(policy: FlowPolicy): ShapeLayout {
  return readShapeLayout(policy).layout
}

// ------------------------------------------------------------ flow and triggers

/**
 * A shape as the flow file phase 6 reads: its normalized serialization, read
 * back and compared. A value the file cannot carry exactly — a control
 * character in a name, a number YAML would read as text — is refused, never
 * written as something else.
 */
export function writeShape(policy: FlowPolicy): string {
  const text = serializeFlowPolicy(policy)
  const parsed = parseFlowPolicy(text)
  if (!parsed.document || parsed.document.format !== 'agents') {
    const first = parsed.problems.find((one) => one.level === 'error')
    throw new Error(`This shape could not be written as a flow: ${first ? `${first.at}: ${first.text}` : 'it does not read back'}.`)
  }
  if (canonical(parsed.document.flow) !== canonical({ ...policy, budget: policy.budget ?? DEFAULT_FLOW_BUDGET })) {
    throw new Error('This shape could not be written exactly: a value in it would read back differently. Change that value and save again.')
  }
  return text
}

const slugOrQuoted = (text: string): string => (/^[a-z0-9][a-z0-9_-]{0,63}$/.test(text) ? text : JSON.stringify(text))
const list = (values: readonly string[]): string => `[${values.map(slugOrQuoted).join(', ')}]`

const triggerLines = (definition: TriggerDefinition): string[] => {
  if (definition.again !== null && definition.on.kind === 'schedule') {
    throw new Error('Each schedule slot opens its own Goal, so again has nothing to continue. Remove again from this schedule.')
  }
  if (definition.again !== null && (definition.again.title !== AGAIN_TITLE || (definition.again.detail ?? null) !== null)) {
    throw new Error('again names only the role a later firing opens; its card title is fixed.')
  }
  const lines = [`- id: ${slugOrQuoted(definition.id)}`, `  on: ${definition.on.kind}`, `  events: ${list(definition.on.events)}`]
  if (definition.on.kind === 'schedule') lines.push(`  every: ${String(definition.on.everyMinutes)}`)
  if (definition.label) lines.push(`  label: [${definition.label.map((label) => JSON.stringify(label)).join(', ')}]`)
  if (definition.from) lines.push(`  from: ${definition.from}`)
  lines.push('flow' in definition.opens ? `  opens: { flow: ${slugOrQuoted(definition.opens.flow)} }` : `  opens: { agent: ${slugOrQuoted(definition.opens.agent)} }`)
  lines.push(`  goal: ${list(definition.goal)}`)
  if (definition.again) lines.push(`  again: { role: ${slugOrQuoted(definition.again.role)} }`)
  lines.push(`  dedupe: ${list(definition.dedupe)}`, `  concurrency: ${String(definition.concurrency)}`)
  if (definition.on.kind === 'pull-request') lines.push(`  forks: ${definition.forks}`)
  const budget = definition.budget
  lines.push(`  budget: { usd: ${String(budget.usd)}, rounds: ${String(budget.rounds)}, hours: ${String(budget.hours)}, without-progress: ${String(budget.withoutProgress)} }`)
  return lines
}

/**
 * A project's triggers in Intake's own vocabulary, read back by
 * `parseTriggers` and compared definition by definition. Nothing here arms,
 * consents or reads a preference: a written trigger runs nowhere until a
 * person commits it and arms it.
 */
export function writeTriggers(definitions: readonly TriggerDefinition[]): string {
  // No triggers is an empty file: the reader takes nothing as an empty list, and has no top-level `[]`.
  const text = definitions.length === 0 ? '' : `${definitions.flatMap(triggerLines).join('\n')}\n`
  const parsed = parseTriggers(text)
  if (parsed.problems.length > 0) {
    const first = parsed.problems[0]!
    throw new Error(`${first.text} ${first.fix}`)
  }
  if (canonical(parsed.definitions) !== canonical(definitions)) {
    throw new Error('These triggers could not be written exactly: a setting would read back differently. Check each trigger and save again.')
  }
  return text
}
