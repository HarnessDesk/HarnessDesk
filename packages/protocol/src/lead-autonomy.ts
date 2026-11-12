/**
 * Autonomy and rules: what the Lead may do on its own, and the person's own words about how it works.
 *
 * Every figure here is the host's. The Lead has no tool that reads or writes them; the host consults them at the point
 * where it would act, and the rule sections reach the model only inside the standing instructions of a new conversation
 * epoch. Nothing a rule says can widen what the host admits.
 */
import { arrayOf, isNumber, isObject, isString, literalUnion, ValidationError, type Validator } from './validate.js'
import { parseLeadDeviceRef } from './lead-presence.js'

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
  /** Versions the autonomy view carries per section, newest first: what a phone shows of a section's history. */
  carried: 5,
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
  /** The open goal's deadline, so the Lead's own loop stops waking itself for that goal once it passes. Absent: none. */
  readonly deadline?: { readonly logicalGoalId: string; readonly deadlineAt: number }
}
/** What caused a run to start: the person's own turn (or a tool continuation of it), or any other wake. */
export const LEAD_START_CAUSES = ['person', 'automatic'] as const
export type LeadStartCause = typeof LEAD_START_CAUSES[number]
/** At most this many runs (chats and Team runs) the Lead started on its own may be live at once. The person's are never counted. */
export const LEAD_AUTOMATIC_RUNS = 3
/** An automatic start is refused when the account it would run on has less than this share of its window left. */
export const LEAD_HEADROOM_RESERVE_PERCENT = 10
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
  /** Set when the person saved this version by pressing Apply on the Lead's proposal with this id: the words were the Lead's. */
  readonly proposal?: string
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
/**
 * One change to autonomy: a mode, a rule section or the goal's deadline. `by` is always the person: the Lead has no method
 * that changes any of them. A rules change names the section and its new version, never the words.
 */
export type LeadAutonomyChange =
  | { readonly at: number; readonly by: 'person'; readonly what: 'mode'; readonly kind: LeadAutonomyKind; readonly from: LeadAutonomyMode; readonly to: LeadAutonomyMode; readonly proposal?: string }
  | { readonly at: number; readonly by: 'person'; readonly what: 'rules'; readonly section: LeadRuleSectionId; readonly version: number; readonly how: LeadRuleVersion['how']; readonly proposal?: string }
  | { readonly at: number; readonly by: 'person'; readonly what: 'deadline'; readonly deadlineAt: number | null }
/** Changes kept, newest last in the file and newest first on the wire. */
export const LEAD_AUTONOMY_CHANGES_KEPT = 64
/** One saved version of a section as the autonomy view carries it: the words, when, and how they came to be. */
export interface LeadAutonomyRuleVersion { readonly version: number; readonly text: string; readonly at: number; readonly how: LeadRuleVersion['how']; readonly from?: number }
export interface LeadAutonomyRule {
  readonly id: LeadRuleSectionId
  readonly title: string
  readonly text: string
  readonly custom: boolean
  readonly version?: number
  readonly changedAt?: number
  readonly versions?: readonly LeadAutonomyRuleVersion[]
  readonly shipped?: string
}
/** What a phone shows: the table, the recent would-haves, the words in force, the deadline. Read-only except the modes. */
export interface LeadAutonomyView {
  readonly version: 1
  readonly modes: LeadAutonomyModes
  readonly observed: readonly LeadObservedAction[]
  /**
   * `version` 0 is the shipped default; `changedAt` is when the newest version was saved, absent for the default.
   * A section ever saved also carries `versions`, its newest `LEAD_RULE_LIMITS.carried` versions newest first with their
   * words, and `shipped`, the words a Restore to the default brings back: enough for a phone to show earlier wording and
   * a diff between any two rows without `lead/rules/read`, which stays at the desk. Absent from an older desk.
   */
  readonly rules: readonly LeadAutonomyRule[]
  readonly deadline: LeadDeadline | null
  /** Who changed what, newest first, at most 32. Absent from an older desk. */
  readonly changes?: readonly LeadAutonomyChange[]
  /** The Lead's proposals to change these settings, newest first: pending ones carry Apply and No. Absent from an older desk. */
  readonly proposals?: readonly LeadSettingsProposal[]
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
  const source = only(['modes', 'rules', 'deadline'])(value, path)
  const rules = only(LEAD_RULE_SECTIONS)(source.rules, at(path, 'rules'))
  const out: Partial<Record<LeadRuleSectionId, LeadRuleActive>> = {}
  for (const key of LEAD_RULE_SECTIONS) if (rules[key] !== undefined) out[key] = active(rules[key], at(at(path, 'rules'), key))
  let deadline: LeadAutonomyRecord['deadline']
  if (source.deadline !== undefined) {
    const d = only(['logicalGoalId', 'deadlineAt'])(source.deadline, at(path, 'deadline'))
    deadline = { logicalGoalId: goalId(d.logicalGoalId, at(path, 'deadline.logicalGoalId')), deadlineAt: integer(1)(d.deadlineAt, at(path, 'deadline.deadlineAt')) }
  }
  return { modes: parseLeadAutonomyModes(source.modes, at(path, 'modes')), rules: out, ...(deadline ? { deadline } : {}) }
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
export const parseLeadAutonomyChange: Validator<LeadAutonomyChange> = (value, path = '') => {
  const what = literalUnion('mode', 'rules', 'deadline')(isObject(value, path).what, at(path, 'what'))
  if (what === 'mode') {
    const source = only(['at', 'by', 'what', 'kind', 'from', 'to', 'proposal'])(value, path)
    literalUnion('person')(source.by, at(path, 'by'))
    return { at: integer()(source.at, at(path, 'at')), by: 'person', what, kind: kind(source.kind, at(path, 'kind')), from: mode(source.from, at(path, 'from')), to: mode(source.to, at(path, 'to')),
      ...(source.proposal === undefined ? {} : { proposal: proposalId(source.proposal, at(path, 'proposal')) }) }
  }
  if (what === 'rules') {
    const source = only(['at', 'by', 'what', 'section', 'version', 'how', 'proposal'])(value, path)
    literalUnion('person')(source.by, at(path, 'by'))
    return { at: integer()(source.at, at(path, 'at')), by: 'person', what, section: section(source.section, at(path, 'section')),
      version: integer(1)(source.version, at(path, 'version')), how: literalUnion('edit', 'reset', 'rollback')(source.how, at(path, 'how')),
      ...(source.proposal === undefined ? {} : { proposal: proposalId(source.proposal, at(path, 'proposal')) }) }
  }
  const source = only(['at', 'by', 'what', 'deadlineAt'])(value, path)
  literalUnion('person')(source.by, at(path, 'by'))
  return { at: integer()(source.at, at(path, 'at')), by: 'person', what, deadlineAt: source.deadlineAt === null ? null : integer(1)(source.deadlineAt, at(path, 'deadlineAt')) }
}
const carriedVersion: Validator<LeadAutonomyRuleVersion> = (value, path = '') => {
  const source = only(['version', 'text', 'at', 'how', 'from'])(value, path)
  return { version: integer(1)(source.version, at(path, 'version')), text: ruleText(source.text, at(path, 'text')), at: integer()(source.at, at(path, 'at')),
    how: literalUnion('edit', 'reset', 'rollback')(source.how, at(path, 'how')), ...(source.from === undefined ? {} : { from: integer(1)(source.from, at(path, 'from')) }) }
}
export const parseLeadAutonomyView: Validator<LeadAutonomyView> = (value, path = '') => {
  const source = only(['version', 'modes', 'observed', 'rules', 'deadline', 'changes', 'proposals'])(value, path)
  if (source.version !== 1) fail(at(path, 'version'), 'expected 1')
  const rules = arrayOf((one, where = '') => {
    const row = only(['id', 'title', 'text', 'custom', 'version', 'changedAt', 'versions', 'shipped'])(one, where)
    if (typeof row.custom !== 'boolean') fail(at(where, 'custom'), 'expected a boolean')
    return { id: section(row.id, at(where, 'id')), title: line(80)(row.title, at(where, 'title')), text: ruleText(row.text, at(where, 'text')), custom: row.custom as boolean,
      ...(row.version === undefined ? {} : { version: integer()(row.version, at(where, 'version')) }),
      ...(row.changedAt === undefined ? {} : { changedAt: integer()(row.changedAt, at(where, 'changedAt')) }),
      ...(row.versions === undefined ? {} : { versions: arrayOf(carriedVersion)(row.versions, at(where, 'versions')).slice(0, LEAD_RULE_LIMITS.carried) }),
      ...(row.shipped === undefined ? {} : { shipped: ruleText(row.shipped, at(where, 'shipped')) }) }
  })(source.rules, at(path, 'rules'))
  return { version: 1, modes: parseLeadAutonomyModes(source.modes, at(path, 'modes')),
    observed: arrayOf(observedAction)(source.observed, at(path, 'observed')).slice(0, 32), rules,
    deadline: source.deadline === null ? null : deadline(source.deadline, at(path, 'deadline')),
    ...(source.changes === undefined ? {} : { changes: arrayOf(parseLeadAutonomyChange)(source.changes, at(path, 'changes')).slice(0, 32) }),
    ...(source.proposals === undefined ? {} : { proposals: arrayOf(parseLeadSettingsProposal)(source.proposals, at(path, 'proposals')).slice(0, LEAD_SETTINGS_PROPOSAL_LIMITS.kept) }) }
}

/**
 * A change the Lead proposes to its own settings: a mode for one kind of unasked work, or a rule section's words. The
 * Lead has no method that applies either; the person's Apply on the card does, through the same store the Settings
 * page writes, and it takes effect the way Settings says (a mode at once for the host's gates, words at the Lead's next
 * epoch). `add` is the line the Lead wanted added, kept for the card; `text` is the section's words once applied.
 */
export type LeadSettingsChange =
  | { readonly kind: 'autonomy'; readonly autonomy: LeadAutonomyKind; readonly from: LeadAutonomyMode; readonly to: LeadAutonomyMode }
  | { readonly kind: 'rules'; readonly section: LeadRuleSectionId; readonly fromVersion: number; readonly text: string; readonly add?: string
    /**
     * Set when the words in force were the shipped default: that default's version. An app update that ships new
     * default words makes the proposal stale, so Apply never pins the old default under the Lead's line.
     */
    readonly fromDefault?: number }
export const LEAD_SETTINGS_PROPOSAL_STATES = ['pending', 'applied', 'declined', 'stale'] as const
export type LeadSettingsProposalState = typeof LEAD_SETTINGS_PROPOSAL_STATES[number]
/** What happened to a proposal, in order: the record the Lead reads its history from, never its own recollection. */
export interface LeadProposalEvent { readonly what: 'proposed' | 'asked-again' | 'applied' | 'declined' | 'stale'; readonly at: number }
export interface LeadSettingsProposal {
  readonly id: string
  readonly change: LeadSettingsChange
  readonly state: LeadSettingsProposalState
  readonly proposedAt: number
  /** The Lead's journal position when it proposed (or asked again): the card sits under the reply after it. */
  readonly afterSeq: number
  readonly askedAgainAt?: number
  readonly decidedAt?: number
  /** Oldest first, at most `LEAD_SETTINGS_PROPOSAL_LIMITS.history`. */
  readonly history: readonly LeadProposalEvent[]
  /**
   * Set only on a phone's copy: this card is answered No from the phone and applied at the desk, because the phone
   * cannot show its words exactly as Apply would write them (a section's whole new words, or a line the phone's scrub
   * changed). The desk refuses a phone's Apply on it with `lead-proposal-desk-only` either way.
   */
  readonly deskOnly?: true
}
export const LEAD_SETTINGS_PROPOSAL_LIMITS = Object.freeze({
  /** Proposals kept. Pending ones are never dropped (there is at most one per kind and section); applied and stale go first, then declined. */
  kept: 16,
  history: 8,
  /** The line a rules proposal adds. */
  addChars: 500,
  /** The person's Noes remembered after their card is dropped, so a declined change stays refused until they write. */
  declines: 32,
  /** New proposals between two of the person's messages; asking again does not count. */
  perTurn: 3,
})
/** The Lead's proposal of a mode. Toward Act is allowed: it is only a proposal, and the person decides. */
export interface LeadAutonomyPropose { readonly kind: LeadAutonomyKind; readonly mode: LeadAutonomyMode }
/** The Lead's proposal for a rule section: one line added to the words in force, or the whole section's new words. */
export type LeadRulesPropose = { readonly section: LeadRuleSectionId; readonly add: string } | { readonly section: LeadRuleSectionId; readonly text: string }
/**
 * What the host did with a proposal. `created` and `asked-again` put a card in front of the person; `same` changed nothing
 * because that is already in force; `refused` names why (`declined`: the person said No and has not written since).
 * `note` is the sentence the Lead relays, and the only thing it may say about the proposal.
 */
export interface LeadSettingsProposeResult {
  readonly outcome: 'created' | 'asked-again' | 'same' | 'refused'
  /** The desk's own reference to the proposal. The wire never carries it to the Lead (#2167): the card is found by the person, not named by the Lead. */
  readonly id?: string
  readonly reason?: 'declined' | 'empty' | 'too-long' | 'too-many'
  readonly declinedBefore?: true
  readonly note: string
}
/**
 * The person's answer on a proposal card. Never on the Lead's door. `device` is set by the phone link itself, never
 * by what a request says about itself: a phone may say No to any card, and Apply only a mode or a single added line.
 */
export interface LeadSettingsDecide { readonly id: string; readonly decision: 'apply' | 'decline'; readonly device?: import('./lead-presence.js').LeadDeviceRef }

const proposalId: Validator<string> = (value, path = '') => {
  const out = isString(value, path)
  return /^s[1-9][0-9]{0,8}$/.test(out) ? out : fail(path, 'expected a proposal id such as s3')
}
export const parseLeadAutonomyPropose: Validator<LeadAutonomyPropose> = (value, path = '') => {
  const source = only(['kind', 'mode'])(value, path)
  return { kind: kind(source.kind, at(path, 'kind')), mode: mode(source.mode, at(path, 'mode')) }
}
export const parseLeadRulesPropose: Validator<LeadRulesPropose> = (value, path = '') => {
  const source = only(['section', 'add', 'text'])(value, path)
  const id = section(source.section, at(path, 'section'))
  if ((source.add === undefined) === (source.text === undefined)) fail(path, 'expected exactly one of add or text')
  if (source.add !== undefined) {
    const add = isString(source.add, at(path, 'add'))
    if (!add.trim() || add.length > LEAD_SETTINGS_PROPOSAL_LIMITS.addChars) fail(at(path, 'add'), `expected a line up to ${LEAD_SETTINGS_PROPOSAL_LIMITS.addChars} characters`)
    return { section: id, add }
  }
  const text = ruleText(source.text, at(path, 'text'))
  if (!text.trim()) fail(at(path, 'text'), 'expected words')
  return { section: id, text }
}
export const parseLeadSettingsDecide: Validator<LeadSettingsDecide> = (value, path = '') => {
  const source = only(['id', 'decision', 'device'])(value, path)
  return { id: proposalId(source.id, at(path, 'id')), decision: literalUnion('apply', 'decline')(source.decision, at(path, 'decision')),
    ...(source.device === undefined ? {} : { device: parseLeadDeviceRef(source.device, at(path, 'device')) }) }
}
const proposalEvent: Validator<LeadProposalEvent> = (value, path = '') => {
  const source = only(['what', 'at'])(value, path)
  return { what: literalUnion('proposed', 'asked-again', 'applied', 'declined', 'stale')(source.what, at(path, 'what')), at: integer()(source.at, at(path, 'at')) }
}
const settingsChange: Validator<LeadSettingsChange> = (value, path = '') => {
  const which = literalUnion('autonomy', 'rules')(isObject(value, path).kind, at(path, 'kind'))
  if (which === 'autonomy') {
    const source = only(['kind', 'autonomy', 'from', 'to'])(value, path)
    return { kind: which, autonomy: kind(source.autonomy, at(path, 'autonomy')), from: mode(source.from, at(path, 'from')), to: mode(source.to, at(path, 'to')) }
  }
  const source = only(['kind', 'section', 'fromVersion', 'text', 'add', 'fromDefault'])(value, path)
  return { kind: which, section: section(source.section, at(path, 'section')), fromVersion: integer()(source.fromVersion, at(path, 'fromVersion')),
    text: ruleText(source.text, at(path, 'text')), ...(source.add === undefined ? {} : { add: line(LEAD_SETTINGS_PROPOSAL_LIMITS.addChars)(source.add, at(path, 'add')) }),
    ...(source.fromDefault === undefined ? {} : { fromDefault: integer()(source.fromDefault, at(path, 'fromDefault')) }) }
}
export const parseLeadSettingsProposal: Validator<LeadSettingsProposal> = (value, path = '') => {
  const source = only(['id', 'change', 'state', 'proposedAt', 'afterSeq', 'askedAgainAt', 'decidedAt', 'history', 'deskOnly'])(value, path)
  const history = arrayOf(proposalEvent)(source.history, at(path, 'history'))
  if (history.length > LEAD_SETTINGS_PROPOSAL_LIMITS.history) fail(at(path, 'history'), 'too many events')
  return { id: proposalId(source.id, at(path, 'id')), change: settingsChange(source.change, at(path, 'change')),
    state: literalUnion(...LEAD_SETTINGS_PROPOSAL_STATES)(source.state, at(path, 'state')), proposedAt: integer()(source.proposedAt, at(path, 'proposedAt')),
    afterSeq: integer()(source.afterSeq, at(path, 'afterSeq')),
    ...(source.askedAgainAt === undefined ? {} : { askedAgainAt: integer()(source.askedAgainAt, at(path, 'askedAgainAt')) }),
    ...(source.decidedAt === undefined ? {} : { decidedAt: integer()(source.decidedAt, at(path, 'decidedAt')) }), history,
    ...(source.deskOnly === undefined ? {} : { deskOnly: source.deskOnly === true ? true as const : fail(at(path, 'deskOnly'), 'expected true') }) }
}
