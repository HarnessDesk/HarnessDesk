/**
 * Autonomy and rules: what the Lead may do on its own, and the person's own words about how it works.
 *
 * Every figure here is the host's. The Lead has no tool that reads or writes them; the host consults them at the point
 * where it would act, and the rule sections reach the model only inside the standing instructions of a new conversation
 * epoch. Nothing a rule says can widen what the host admits.
 */
import { arrayOf, isNumber, isObject, isString, literalUnion, ValidationError, type Validator } from './validate.js'

/** The five things the Lead does without being asked. */
export const LEAD_AUTONOMY_KINDS = ['desk-change', 'stuck', 'repeat', 'mention', 'brief'] as const
export type LeadAutonomyKind = typeof LEAD_AUTONOMY_KINDS[number]
/** Off does nothing. Observe records what it would have done in the wake ledger and does nothing. Act does it. */
export const LEAD_AUTONOMY_MODES = ['off', 'observe', 'act'] as const
export type LeadAutonomyMode = typeof LEAD_AUTONOMY_MODES[number]
export type LeadAutonomyModes = Readonly<Record<LeadAutonomyKind, LeadAutonomyMode>>
export const LEAD_AUTONOMY_DEFAULTS: LeadAutonomyModes = Object.freeze({ 'desk-change': 'act', stuck: 'act', repeat: 'act', mention: 'act', brief: 'act' })
export const LEAD_AUTONOMY_LABELS: Readonly<Record<LeadAutonomyKind, { readonly title: string; readonly hint: string }>> = Object.freeze({
  'desk-change': { title: 'Desk-change reports', hint: 'Speak up when work the Lead follows changes.' },
  stuck: { title: 'Stuck nudges', hint: 'Say so when a run has gone quiet.' },
  repeat: { title: 'Repeat runs', hint: 'Open a goal at its scheduled time.' },
  mention: { title: 'Mention triggers', hint: 'Answer a comment that addresses the Lead.' },
  brief: { title: 'Morning brief', hint: 'Send the daily summary.' },
})

/** The three sections the person writes. */
export const LEAD_RULE_SECTIONS = ['talk', 'delegate', 'done'] as const
export type LeadRuleSectionId = typeof LEAD_RULE_SECTIONS[number]
export const LEAD_RULE_TITLES: Readonly<Record<LeadRuleSectionId, string>> = Object.freeze({
  talk: 'How to talk to me', delegate: 'What to delegate and to whom', done: 'What counts as done',
})
export const LEAD_RULE_LIMITS = Object.freeze({
  /** One section, in characters. */
  chars: 3000,
  /** Versions kept per section, the shipped default excluded. */
  versions: 20,
})
/**
 * What the Lead does with no edit. `version` rises only when the shipped words change; a person who edited a section
 * is then shown the difference, never silently moved.
 */
export const LEAD_RULE_DEFAULTS: Readonly<Record<LeadRuleSectionId, { readonly version: number; readonly text: string }>> = Object.freeze({
  talk: Object.freeze({ version: 1, text: 'Plain words, short. Say what changed and what you need from me. Ask one question at a time, with options when there are a few. Say nothing when nothing needs me.' }),
  delegate: Object.freeze({ version: 1, text: 'Use one ordinary chat for a small task. Use a reviewed Team for work that changes code. Put the implementer and the reviewer on different agents. Prefer the agent that already has the project open.' }),
  done: Object.freeze({ version: 1, text: 'Done means the checks pass, an independent review approved, and no blocking finding is left. A worker saying it finished is not evidence.' }),
})

/** The person's saved choice for a section, as the journal and the model's epoch read it. Absent: the default. */
export interface LeadRuleActive { readonly version: number; readonly text: string }
/** What the journal carries: the modes, and the sections the person edited. */
export interface LeadAutonomyRecord {
  readonly modes: LeadAutonomyModes
  readonly rules: Readonly<Partial<Record<LeadRuleSectionId, LeadRuleActive>>>
}
export const initialLeadAutonomy = (): LeadAutonomyRecord => ({ modes: LEAD_AUTONOMY_DEFAULTS, rules: {} })

/** One stored version of a section. `base` is the shipped default it was written against. */
export interface LeadRuleVersion {
  readonly version: number
  readonly text: string
  readonly at: number
  readonly how: 'edit' | 'reset' | 'rollback'
  /** Rollback only: the version whose bytes this one carries. */
  readonly from?: number
  readonly base: { readonly version: number; readonly text: string }
}
export interface LeadRuleSectionView {
  readonly id: LeadRuleSectionId
  readonly title: string
  /** The words in force: the edit, or the shipped default. */
  readonly text: string
  /** 0 is the shipped default. */
  readonly version: number
  readonly custom: boolean
  readonly default: { readonly version: number; readonly text: string }
  /** Set when the shipped words changed after the person's edit: what they edited against, and what ships now. */
  readonly defaultUpdated: { readonly from: string; readonly to: string } | null
  readonly history: readonly LeadRuleVersion[]
}
/** A thing the host would have done, in Observe, newest first. */
export interface LeadObservedAction { readonly id: string; readonly at: number; readonly kind: LeadAutonomyKind; readonly note: string }
export interface LeadDeadline { readonly logicalGoalId: string; readonly startedAt: number; readonly deadlineAt: number; readonly reported: boolean }
/** What a phone shows: the table, the recent would-haves, the words in force, the deadline. Read-only except the modes. */
export interface LeadAutonomyView {
  readonly version: 1
  readonly modes: LeadAutonomyModes
  readonly observed: readonly LeadObservedAction[]
  readonly rules: readonly { readonly id: LeadRuleSectionId; readonly title: string; readonly text: string; readonly custom: boolean }[]
  readonly deadline: LeadDeadline | null
}
export interface LeadRulesView {
  readonly version: 1
  readonly sections: readonly LeadRuleSectionView[]
  /** Exactly what the rules add to the standing instructions of the next epoch; empty when none was edited. */
  readonly prompt: string
}
export interface LeadAutonomySet { readonly kind: LeadAutonomyKind; readonly mode: LeadAutonomyMode }
export type LeadRulesUpdate =
  | { readonly section: LeadRuleSectionId; readonly action: 'edit'; readonly text: string; readonly expectedVersion: number }
  | { readonly section: LeadRuleSectionId; readonly action: 'reset' | 'keep'; readonly expectedVersion: number }
  | { readonly section: LeadRuleSectionId; readonly action: 'rollback'; readonly to: number; readonly expectedVersion: number }
export interface LeadDeadlineSet { readonly logicalGoalId: string; readonly deadlineAt: number | null }

const fail = (path: string, message: string): never => { throw new ValidationError(path, message) }
const at = (path: string, key: string) => path ? `${path}.${key}` : key
const only = (allowed: readonly string[]): Validator<Record<string, unknown>> => (value, path = '') => {
  const source = isObject(value, path)
  for (const key of Object.keys(source)) if (!allowed.includes(key)) fail(path, `unexpected field ${key}`)
  return source
}
const integer = (min = 0, max = Number.MAX_SAFE_INTEGER): Validator<number> => (value, path = '') => {
  const out = isNumber(value, path)
  return Number.isSafeInteger(out) && out >= min && out <= max ? out : fail(path, `expected an integer from ${min} to ${max}`)
}
const goalId: Validator<string> = (value, path = '') => {
  const out = isString(value, path)
  return out.length > 0 && out.length <= 256 ? out : fail(path, 'expected an id')
}
const kind = literalUnion(...LEAD_AUTONOMY_KINDS)
const mode = literalUnion(...LEAD_AUTONOMY_MODES)
const section = literalUnion(...LEAD_RULE_SECTIONS)
const ruleText: Validator<string> = (value, path = '') => {
  const out = isString(value, path)
  return out.length <= LEAD_RULE_LIMITS.chars ? out : fail(path, `expected at most ${LEAD_RULE_LIMITS.chars} characters`)
}

export const parseLeadAutonomyModes: Validator<LeadAutonomyModes> = (value, path = '') => {
  const source = only(LEAD_AUTONOMY_KINDS)(value, path)
  const out: Record<string, LeadAutonomyMode> = {}
  for (const key of LEAD_AUTONOMY_KINDS) out[key] = mode(source[key], at(path, key))
  return out as LeadAutonomyModes
}
const active: Validator<LeadRuleActive> = (value, path = '') => {
  const source = only(['version', 'text'])(value, path)
  return { version: integer(1)(source.version, at(path, 'version')), text: ruleText(source.text, at(path, 'text')) }
}
export const parseLeadAutonomyRecord: Validator<LeadAutonomyRecord> = (value, path = '') => {
  const source = only(['modes', 'rules'])(value, path)
  const rules = only(LEAD_RULE_SECTIONS)(source.rules, at(path, 'rules'))
  const out: Partial<Record<LeadRuleSectionId, LeadRuleActive>> = {}
  for (const key of LEAD_RULE_SECTIONS) if (rules[key] !== undefined) out[key] = active(rules[key], at(at(path, 'rules'), key))
  return { modes: parseLeadAutonomyModes(source.modes, at(path, 'modes')), rules: out }
}
export const parseLeadAutonomySet: Validator<LeadAutonomySet> = (value, path = '') => {
  const source = only(['kind', 'mode'])(value, path)
  return { kind: kind(source.kind, at(path, 'kind')), mode: mode(source.mode, at(path, 'mode')) }
}
export const parseLeadRulesUpdate: Validator<LeadRulesUpdate> = (value, path = '') => {
  const source = only(['section', 'action', 'text', 'to', 'expectedVersion'])(value, path)
  const base = { section: section(source.section, at(path, 'section')), expectedVersion: integer()(source.expectedVersion, at(path, 'expectedVersion')) }
  const action = literalUnion('edit', 'reset', 'keep', 'rollback')(source.action, at(path, 'action'))
  if (action === 'edit') return { ...base, action, text: ruleText(source.text, at(path, 'text')) }
  if (action === 'rollback') return { ...base, action, to: integer(1)(source.to, at(path, 'to')) }
  return { ...base, action }
}
export const parseLeadDeadlineSet: Validator<LeadDeadlineSet> = (value, path = '') => {
  const source = only(['logicalGoalId', 'deadlineAt'])(value, path)
  return { logicalGoalId: goalId(source.logicalGoalId, at(path, 'logicalGoalId')),
    deadlineAt: source.deadlineAt === null ? null : integer(1)(source.deadlineAt, at(path, 'deadlineAt')) }
}
const line = (max: number): Validator<string> => (value, path = '') => {
  const out = isString(value, path)
  return out.length <= max ? out : fail(path, `expected at most ${max} characters`)
}
const observedAction: Validator<LeadObservedAction> = (value, path = '') => {
  const source = only(['id', 'at', 'kind', 'note'])(value, path)
  return { id: goalId(source.id, at(path, 'id')), at: integer()(source.at, at(path, 'at')), kind: kind(source.kind, at(path, 'kind')), note: line(200)(source.note, at(path, 'note')) }
}
const deadline: Validator<LeadDeadline> = (value, path = '') => {
  const source = only(['logicalGoalId', 'startedAt', 'deadlineAt', 'reported'])(value, path)
  if (typeof source.reported !== 'boolean') fail(at(path, 'reported'), 'expected a boolean')
  return { logicalGoalId: goalId(source.logicalGoalId, at(path, 'logicalGoalId')), startedAt: integer()(source.startedAt, at(path, 'startedAt')),
    deadlineAt: integer()(source.deadlineAt, at(path, 'deadlineAt')), reported: source.reported as boolean }
}
export const parseLeadAutonomyView: Validator<LeadAutonomyView> = (value, path = '') => {
  const source = only(['version', 'modes', 'observed', 'rules', 'deadline'])(value, path)
  if (source.version !== 1) fail(at(path, 'version'), 'expected 1')
  const rules = arrayOf((one, where = '') => {
    const row = only(['id', 'title', 'text', 'custom'])(one, where)
    if (typeof row.custom !== 'boolean') fail(at(where, 'custom'), 'expected a boolean')
    return { id: section(row.id, at(where, 'id')), title: line(80)(row.title, at(where, 'title')), text: ruleText(row.text, at(where, 'text')), custom: row.custom as boolean }
  })(source.rules, at(path, 'rules'))
  return { version: 1, modes: parseLeadAutonomyModes(source.modes, at(path, 'modes')),
    observed: arrayOf(observedAction)(source.observed, at(path, 'observed')).slice(0, 32), rules,
    deadline: source.deadline === null ? null : deadline(source.deadline, at(path, 'deadline')) }
}
