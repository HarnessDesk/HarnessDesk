import { randomUUID } from 'node:crypto'
import { rename } from 'node:fs/promises'
import type { LeadState } from '@harnessdesk/lead'
import { leadAutonomyMode, leadRulesAddendum } from '@harnessdesk/lead'
import { LEAD_AUTONOMY_CHANGES_KEPT, LEAD_AUTONOMY_DEFAULTS, LEAD_AUTONOMY_KINDS, LEAD_RULE_DEFAULTS, LEAD_RULE_LIMITS, LEAD_RULE_SECTIONS, LEAD_RULE_TITLES, parseLeadAutonomySet, parseLeadDeadlineSet,
  parseLeadAutonomyChange, parseLeadRulesUpdate, type LeadAutonomyChange, type LeadAutonomyKind, type LeadAutonomyMode, type LeadAutonomyModes, type LeadAutonomyRecord, type LeadAutonomySet, type LeadAutonomyView,
  type LeadDeadline, type LeadDeadlineSet, type LeadRuleSectionId, type LeadRuleSectionView, type LeadRulesUpdate, type LeadRulesView, type LeadRuleVersion,
  type LeadWakeRecord, LEAD_AUTONOMY_LABELS, LEAD_SETTINGS_PROPOSAL_LIMITS, parseLeadAutonomyPropose, parseLeadRulesPropose, parseLeadSettingsDecide, parseLeadSettingsProposal,
  type LeadAutonomyPropose, type LeadProposalEvent, type LeadRulesPropose, type LeadSettingsChange, type LeadSettingsDecide, type LeadSettingsProposal,
  type LeadSettingsProposeResult } from '@harnessdesk/protocol'
import { readBoundedJsonResult, writeAtomicJson } from './bounded-json.js'

const MAX_BYTES = 2 * 1024 * 1024
/** At this share of the time a deadline has run, the Lead says so once. */
export const LEAD_DEADLINE_REPORT_SHARE = 0.8
/** What the wake ledger says Observe would have done, by kind. Plain words; the ledger row carries only the kind. */
export const LEAD_OBSERVED_NOTES: Readonly<Record<LeadAutonomyKind, string>> = Object.freeze({
  'desk-change': 'Would have reported a change on the desk.',
  stuck: 'Would have said a run had gone quiet.',
  repeat: 'Would have opened a scheduled goal.',
  mention: 'Would have answered a comment that addressed the Lead.',
  brief: 'Would have sent the morning brief.',
})
const WAKE_SOURCE: Readonly<Record<LeadAutonomyKind, LeadWakeRecord['source']>> = Object.freeze({
  'desk-change': 'desk-change', stuck: 'desk-change', repeat: 'schedule', mention: 'trigger', brief: 'schedule' })

export interface LeadAutonomyPorts {
  readonly file: string
  readonly now: () => number
  /** The Lead's journal: its state is where the modes live, and `setAutonomy` is the only way they change. */
  readonly journal: {
    readonly state: LeadState
    setAutonomy(autonomy: LeadAutonomyRecord, change?: LeadAutonomyChange): Promise<void>
    recordWake(wake: LeadWakeRecord): Promise<void>
  }
  /** The goal in hand, for a deadline: null when none is open. */
  readonly goal?: () => { readonly id: string; readonly open: boolean } | null
  /** The Lead's own words to the person, for the 80% report. */
  readonly report?: (text: string) => Promise<void>
  /** The shipped defaults; a later build raises a section's version to show the person what changed. */
  readonly defaults?: typeof LEAD_RULE_DEFAULTS
  readonly changed?: () => void
  /** The Lead's journal position, so a proposal card sits under the reply that follows it. */
  readonly seq?: () => number
  /** The position of the person's latest message: a No stands until the person writes again. */
  readonly personSeq?: () => number
}

interface SectionFile { versions: LeadRuleVersion[]; acked?: number }
interface Stored {
  version: 1
  sections: Partial<Record<LeadRuleSectionId, SectionFile>>
  deadline?: LeadDeadline & { passed?: boolean }
  /** Runs the Lead started on its own, kept until they end so the cap on them survives a restart. */
  automatic?: string[]
  /** Who changed what, oldest first, the newest `LEAD_AUTONOMY_CHANGES_KEPT`. */
  changes?: LeadAutonomyChange[]
  /** The Lead's proposals, oldest first; a declined one keeps the person's position when they said No. */
  proposals?: StoredProposal[]
  nextProposal?: number
}
type StoredProposal = { -readonly [K in keyof LeadSettingsProposal]: LeadSettingsProposal[K] } & { declinedSeq?: number }
const MAX_AUTOMATIC_IDS = 256
const fresh = (): Stored => ({ version: 1, sections: {} })
const refused = (code: string, message = code) => Object.assign(new Error(message), { wireCode: code })
const unreadable = () => Object.assign(new Error('The Lead autonomy file could not be read just now, so nothing was written. Try again in a moment.'), { wireCode: 'unavailable' })
/** A time as the desk's clock reads it, for the sentence the Lead relays. */
const clock = (at: number): string => { const date = new Date(at), two = (n: number) => String(n).padStart(2, '0')
  return `on ${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} at ${two(date.getHours())}:${two(date.getMinutes())}` }
const stale = () => refused('lead-rules-stale', 'These words changed since you opened them. Read them again.')

/**
 * Host-side autonomy and rules. The modes and the sections the person edited are journaled (so a replay and the model's
 * epoch see them); the full version history, the deadline and what the person has acknowledged live in one file,
 * `<state>/lead/autonomy.json`. The file is written first, the journal second, and `attach` makes the journal agree with
 * the file after a crash between the two. Nothing here is reachable by the Lead: its tools have no such method.
 */
export class LeadAutonomyStore {
  #tail: Promise<unknown> = Promise.resolve()
  #stored: Stored = fresh()
  #loaded = false
  #unreadable = false
  constructor(private readonly ports: LeadAutonomyPorts) { this.#tail = this.#load().catch(() => {}) }
  get #defaults(): typeof LEAD_RULE_DEFAULTS { return this.ports.defaults ?? LEAD_RULE_DEFAULTS }

  async #load(): Promise<void> {
    const read = await readBoundedJsonResult(this.ports.file, MAX_BYTES)
    this.#loaded = false; this.#unreadable = false
    if (read.kind === 'unreadable') { await this.#setAside(); this.#loaded = true; return }
    if (read.kind === 'value') {
      try { this.#stored = this.#read(read.value) } catch { await this.#setAside(); this.#stored = fresh() }
    } else if (read.kind === 'io') return
    this.#loaded = true
  }
  #read(value: unknown): Stored {
    const source = value as Stored
    if (!source || source.version !== 1 || typeof source.sections !== 'object') throw new Error('shape')
    const out = fresh()
    for (const id of LEAD_RULE_SECTIONS) {
      const file = source.sections[id]
      if (!file) continue
      if (!Array.isArray(file.versions) || file.versions.length > LEAD_RULE_LIMITS.versions) throw new Error('shape')
      for (const entry of file.versions) {
        if (!Number.isSafeInteger(entry.version) || entry.version < 1 || typeof entry.text !== 'string' || entry.text.length > LEAD_RULE_LIMITS.chars ||
          !['edit', 'reset', 'rollback'].includes(entry.how) || typeof entry.base?.text !== 'string' || !Number.isSafeInteger(entry.base.version)) throw new Error('shape')
      }
      out.sections[id] = { versions: file.versions, ...(Number.isSafeInteger(file.acked) ? { acked: file.acked } : {}) }
    }
    if (source.deadline) out.deadline = source.deadline
    if (Array.isArray(source.changes)) out.changes = source.changes.flatMap(one => { try { return [parseLeadAutonomyChange(one)] } catch { return [] } }).slice(-LEAD_AUTONOMY_CHANGES_KEPT)
    if (Array.isArray(source.proposals)) out.proposals = source.proposals.flatMap(one => {
      try { return [{ ...parseLeadSettingsProposal({ ...one, declinedSeq: undefined }), ...(Number.isSafeInteger(one.declinedSeq) ? { declinedSeq: one.declinedSeq } : {}) }] } catch { return [] }
    }).slice(-LEAD_SETTINGS_PROPOSAL_LIMITS.kept)
    if (Number.isSafeInteger(source.nextProposal)) out.nextProposal = source.nextProposal
    if (Array.isArray(source.automatic)) out.automatic = source.automatic.filter((id): id is string => typeof id === 'string' && id.length <= 300).slice(-MAX_AUTOMATIC_IDS)
    return out
  }
  async #setAside(): Promise<void> {
    this.#stored = fresh()
    try { await rename(this.ports.file, `${this.ports.file}.corrupt-${this.ports.now()}`) } catch { this.#unreadable = true }
  }
  #write<T>(work: () => Promise<T> | T): Promise<T> {
    const run = this.#tail.then(async () => {
      if (!this.#loaded && !this.#unreadable) await this.#load().catch(() => {})
      if (!this.#loaded || this.#unreadable) throw unreadable()
      const before = JSON.stringify(this.#stored)
      try {
        const out = await work()
        if (JSON.stringify(this.#stored) !== before) await writeAtomicJson(this.ports.file, this.#stored, async () => {})
        return out
      } catch (error) { this.#stored = JSON.parse(before) as Stored; throw error }
    })
    this.#tail = run.catch(() => {})
    return run
  }
  async #ready(): Promise<void> {
    await this.#tail
    if (!this.#loaded && !this.#unreadable) await this.#load().catch(() => {})
    if (!this.#loaded || this.#unreadable) throw unreadable()
  }

  /** The newest version of a section, or 0 when the person never edited it. */
  #latest(id: LeadRuleSectionId): LeadRuleVersion | null { return this.#stored.sections[id]?.versions.at(-1) ?? null }
  #custom(id: LeadRuleSectionId): LeadRuleVersion | null { const latest = this.#latest(id); return latest && latest.how !== 'reset' ? latest : null }
  #record(modes: LeadAutonomyModes): LeadAutonomyRecord {
    const rules: Partial<Record<LeadRuleSectionId, { version: number; text: string }>> = {}
    for (const id of LEAD_RULE_SECTIONS) { const one = this.#custom(id); if (one) rules[id] = { version: one.version, text: one.text } }
    // The child reads the deadline from the journal, so its own loop stops waking itself for the goal once it passes.
    const deadline = this.#stored.deadline
    return { modes, rules, ...(deadline ? { deadline: { logicalGoalId: deadline.logicalGoalId, deadlineAt: deadline.deadlineAt } } : {}) }
  }
  #modes(): LeadAutonomyModes { return this.ports.journal.state.autonomy?.modes ?? LEAD_AUTONOMY_DEFAULTS }
  /** Keeps a change in the file, and returns it for the journal record that goes with it. */
  #change(change: LeadAutonomyChange): LeadAutonomyChange {
    this.#stored.changes = [...(this.#stored.changes ?? []), change].slice(-LEAD_AUTONOMY_CHANGES_KEPT)
    return change
  }

  /** After a start: the journal says what the file says. A crash between the two writes leaves the file ahead, never behind. */
  async attach(): Promise<void> {
    // Read the modes inside the queue: a switch made while this waits would otherwise be written back over by what it saw first.
    await this.#write(() => this.ports.journal.setAutonomy(this.#record(this.#modes())))
  }

  /** The mode in force for a kind of unasked work. */
  mode(kind: LeadAutonomyKind): LeadAutonomyMode { return leadAutonomyMode(this.ports.journal.state, kind) }
  /**
   * The point where the host would act on its own. `act` says go. `off` says nothing happened. `observe` writes the
   * would-have row in the wake ledger and says nothing was done, so a caller treats it like `off` and moves on.
   */
  async gate(kind: LeadAutonomyKind): Promise<'act' | 'off' | 'observed'> {
    const mode = this.mode(kind)
    if (mode === 'act') return 'act'
    if (mode === 'off') return 'off'
    const at = this.ports.now()
    try { await this.ports.journal.recordWake({ id: `observed-${kind}-${at}-${randomUUID().slice(0, 8)}`, at, source: WAKE_SOURCE[kind], decision: 'silent', modelTurn: false, usdMicros: null, observed: kind }) }
    catch { /* A ledger that cannot be written is still not an act. */ }
    this.ports.changed?.()
    return 'observed'
  }

  async view(): Promise<LeadAutonomyView> {
    await this.#ready()
    const state = this.ports.journal.state
    const observed = state.wakes.flatMap(wake => wake.observed ? [{ id: wake.id, at: wake.at, kind: wake.observed, note: LEAD_OBSERVED_NOTES[wake.observed] }] : []).sort((a, b) => b.at - a.at).slice(0, 32)
    const stored = this.#stored.deadline, deadline = stored && state.budget?.logicalGoalId === stored.logicalGoalId ? { logicalGoalId: stored.logicalGoalId, startedAt: stored.startedAt, deadlineAt: stored.deadlineAt, reported: stored.reported } : null
    return { version: 1, modes: this.#modes(), observed, deadline,
      rules: LEAD_RULE_SECTIONS.map(id => {
        const custom = this.#custom(id), latest = this.#latest(id)
        return { id, title: LEAD_RULE_TITLES[id], text: custom?.text ?? this.#defaults[id].text, custom: !!custom, version: latest?.version ?? 0, ...(latest ? { changedAt: latest.at } : {}) }
      }),
      changes: [...(this.#stored.changes ?? [])].reverse().slice(0, 32),
      proposals: [...(this.#stored.proposals ?? [])].reverse().map(({ declinedSeq: _seq, ...one }) => structuredClone(one)) }
  }
  async set(params: LeadAutonomySet): Promise<LeadAutonomyView> {
    const { kind, mode } = parseLeadAutonomySet(params)
    await this.#write(async () => {
      const current = this.#modes()
      if (current[kind] === mode) return
      const change = this.#change({ at: this.ports.now(), by: 'person', what: 'mode', kind, from: current[kind], to: mode })
      await this.ports.journal.setAutonomy(this.#record({ ...current, [kind]: mode }), change)
    })
    this.ports.changed?.()
    return this.view()
  }

  #sectionView(id: LeadRuleSectionId): LeadRuleSectionView {
    const file = this.#stored.sections[id], custom = this.#custom(id), latest = this.#latest(id), shipped = this.#defaults[id]
    const behind = custom && custom.base.version < shipped.version && (file?.acked ?? 0) < shipped.version
    return { id, title: LEAD_RULE_TITLES[id], text: custom?.text ?? shipped.text, version: latest?.version ?? 0, custom: !!custom, default: { ...shipped },
      defaultUpdated: behind ? { from: custom.base.text, to: shipped.text } : null, history: [...(file?.versions ?? [])].reverse() }
  }
  async rules(): Promise<LeadRulesView> {
    await this.#ready()
    const record = this.#record(this.#modes())
    return { version: 1, sections: LEAD_RULE_SECTIONS.map(id => this.#sectionView(id)),
      prompt: leadRulesAddendum({ autonomy: record } as LeadState) ?? '' }
  }
  async updateRules(params: LeadRulesUpdate): Promise<LeadRulesView> {
    const update = parseLeadRulesUpdate(params)
    await this.#write(() => this.#rulesChange(update))
    this.ports.changed?.()
    return this.rules()
  }
  /** One change to a section, inside the write queue: the Settings page's and a proposal's Apply alike. */
  async #rulesChange(update: LeadRulesUpdate): Promise<void> {
    {
      const { section: id } = update, file = this.#stored.sections[id] ?? { versions: [] }, latest = file.versions.at(-1)
      if ((latest?.version ?? 0) !== update.expectedVersion) throw stale()
      const base = { version: this.#defaults[id].version, text: this.#defaults[id].text }
      const next = (how: LeadRuleVersion['how'], text: string, from?: number): LeadRuleVersion =>
        ({ version: (latest?.version ?? 0) + 1, text, at: this.ports.now(), how, base, ...(from === undefined ? {} : { from }) })
      let entry: LeadRuleVersion | null = null
      if (update.action === 'edit') {
        if (!update.text.trim()) throw refused('lead-rule-empty', 'Write something, or reset this section to its default.')
        if (latest && latest.how !== 'reset' && latest.text === update.text) return
        entry = next('edit', update.text)
      } else if (update.action === 'reset') {
        if (!latest || latest.how === 'reset') return
        entry = next('reset', this.#defaults[id].text)
      } else if (update.action === 'rollback') {
        const target = file.versions.find(one => one.version === update.to)
        if (!target) throw refused('lead-rule-version-missing', 'That version is no longer kept.')
        // The bytes of the old version, as they were saved, become the newest: history only grows.
        entry = next(target.how === 'reset' ? 'reset' : 'rollback', target.text, target.version)
      } else {
        // Keep mine: the person has seen what the shipped words became and chose their own.
        this.#stored.sections[id] = { versions: file.versions, acked: this.#defaults[id].version }
        return
      }
      const versions = [...file.versions, entry].slice(-LEAD_RULE_LIMITS.versions)
      this.#stored.sections[id] = { versions, ...(file.acked === undefined ? {} : { acked: file.acked }) }
      const change = this.#change({ at: entry.at, by: 'person', what: 'rules', section: id, version: entry.version, how: entry.how })
      await this.ports.journal.setAutonomy(this.#record(this.#modes()), change)
    }
  }

  /**
   * The Lead's proposal of a mode for one kind of unasked work. It changes nothing: it puts a card in front of the
   * person, who applies or declines it on any surface. One pending proposal per kind: asking again for the same mode
   * moves the card under the reply that asked (`asked-again`); a different mode replaces it. The same change the person
   * declined is refused until the person has written since their No.
   */
  async proposeMode(params: LeadAutonomyPropose): Promise<LeadSettingsProposeResult> {
    const { kind, mode } = parseLeadAutonomyPropose(params)
    const title = LEAD_AUTONOMY_LABELS[kind].title
    const result = await this.#write(() => {
      const from = this.#modes()[kind]
      if (from === mode) return { outcome: 'same' as const, note: `${title} is already ${mode}. Nothing changes, and there is nothing for the person to apply.` }
      return this.#propose({ kind: 'autonomy', autonomy: kind, from, to: mode }, one => one.kind === 'autonomy' && one.autonomy === kind,
        one => one.kind === 'autonomy' && one.to === mode)
    })
    if (result.outcome !== 'same') this.ports.changed?.()
    return result
  }
  /**
   * The Lead's proposal for a rule section: a line added to the words in force, or the section's whole new words. Like
   * a mode, it is a card the person applies or declines; Apply saves a new version against the version it was proposed
   * on, so words the person changed meanwhile are never written over.
   */
  async proposeRules(params: LeadRulesPropose): Promise<LeadSettingsProposeResult> {
    const proposal = parseLeadRulesPropose(params)
    const result = await this.#write(() => {
      const id = proposal.section, fromVersion = this.#latest(id)?.version ?? 0
      const current = this.#custom(id)?.text ?? this.#defaults[id].text
      const add = 'add' in proposal ? proposal.add.replace(/\s+/g, ' ').trim() : undefined
      const text = add !== undefined ? `${current.trimEnd()}\n${add}` : (proposal as { readonly text: string }).text
      if (text.length > LEAD_RULE_LIMITS.chars) return { outcome: 'refused' as const, reason: 'too-long' as const,
        note: `"${LEAD_RULE_TITLES[id]}" would be longer than ${LEAD_RULE_LIMITS.chars} characters. Nothing was proposed; propose shorter words.` }
      if (text === current || add !== undefined && current.split('\n').some(row => row.trim() === add))
        return { outcome: 'same' as const, note: `"${LEAD_RULE_TITLES[id]}" already says that. Nothing changes, and there is nothing for the person to apply.` }
      return this.#propose({ kind: 'rules', section: id, fromVersion, text, ...(add !== undefined ? { add } : {}) }, one => one.kind === 'rules' && one.section === id,
        one => one.kind === 'rules' && (add !== undefined ? one.add === add : one.text === text))
    })
    if (result.outcome !== 'same' && result.outcome !== 'refused' || result.reason === 'declined') this.ports.changed?.()
    return result
  }
  /** Inside the write queue: asks again, refuses a declined change, or makes the card. `slot` finds the one pending proposal it replaces. */
  #propose(change: LeadSettingsChange, slot: (one: LeadSettingsChange) => boolean, alike: (one: LeadSettingsChange) => boolean): LeadSettingsProposeResult {
    const at = this.ports.now(), seq = Math.max(0, Math.floor(this.ports.seq?.() ?? 0)), personSeq = this.ports.personSeq?.() ?? 0
    const list = this.#stored.proposals ??= []
    const event = (one: StoredProposal, what: LeadProposalEvent['what']) => { one.history = [...one.history, { what, at }].slice(-LEAD_SETTINGS_PROPOSAL_LIMITS.history) }
    const pending = list.find(one => one.state === 'pending' && slot(one.change))
    if (pending && alike(pending.change)) {
      pending.afterSeq = Math.max(pending.afterSeq, seq); pending.askedAgainAt = at; event(pending, 'asked-again')
      return { outcome: 'asked-again', id: pending.id, note: `Your proposal ${pending.id} was already waiting for the person's Apply, first proposed ${clock(pending.proposedAt)}; its card moved under this reply. Nothing has changed yet.` }
    }
    const declined = list.filter(one => one.state === 'declined' && slot(one.change) && alike(one.change))
    const standing = declined.find(one => personSeq <= (one.declinedSeq ?? 0))
    if (standing) return { outcome: 'refused', reason: 'declined', id: standing.id,
      note: `The person said No to this (${standing.id}) ${clock(standing.decidedAt ?? standing.proposedAt)} and has not written since. Nothing was proposed; do not propose it again unless they ask for it.` }
    if (pending) { pending.state = 'stale'; pending.decidedAt = at; event(pending, 'stale') }
    const id = `s${this.#stored.nextProposal ?? 1}`
    this.#stored.nextProposal = (this.#stored.nextProposal ?? 1) + 1
    list.push({ id, change, state: 'pending', proposedAt: at, afterSeq: seq, history: [{ what: 'proposed', at }] })
    this.#stored.proposals = list.slice(-LEAD_SETTINGS_PROPOSAL_LIMITS.kept)
    return { outcome: 'created', id, ...(declined.length ? { declinedBefore: true as const } : {}),
      note: `Proposed as ${id}${pending ? `, in place of ${pending.id}` : ''}. Nothing changes until the person presses Apply on its card, wherever they read this. ` +
        `Say it waits for their Apply; never say it is set. ${change.kind === 'rules' ? 'Applied words reach you at your next epoch.' : 'An applied mode holds for what the desk does on its own from then on.'}` }
  }
  /**
   * The person's Apply or No on a proposal card, from the window or a phone. Apply makes exactly the change the card
   * shows, through the same path as Settings, recorded as the person's; words changed since the proposal make it stale
   * instead, and nothing is written. Neither the Lead's tools nor its door can reach this method.
   */
  async decide(params: LeadSettingsDecide): Promise<LeadAutonomyView> {
    const { id, decision } = parseLeadSettingsDecide(params)
    const outcome = await this.#write(async () => {
      const one = this.#stored.proposals?.find(entry => entry.id === id)
      if (!one) throw refused('lead-proposal-missing', 'That proposal is no longer kept.')
      if (one.state !== 'pending') throw refused('lead-proposal-decided', one.state === 'stale' ? 'A newer proposal or a change of yours replaced this one.' : `This proposal was already ${one.state}.`)
      const at = this.ports.now()
      const close = (state: 'applied' | 'declined' | 'stale') => {
        one.state = state; one.decidedAt = at; one.history = [...one.history, { what: state, at }].slice(-LEAD_SETTINGS_PROPOSAL_LIMITS.history)
      }
      if (decision === 'decline') { close('declined'); one.declinedSeq = this.ports.personSeq?.() ?? 0; return 'declined' as const }
      const change = one.change
      if (change.kind === 'autonomy') {
        const current = this.#modes()
        if (current[change.autonomy] !== change.to) {
          const record = this.#change({ at, by: 'person', what: 'mode', kind: change.autonomy, from: current[change.autonomy], to: change.to })
          await this.ports.journal.setAutonomy(this.#record({ ...current, [change.autonomy]: change.to }), record)
        }
        close('applied')
        return 'applied' as const
      }
      if ((this.#latest(change.section)?.version ?? 0) !== change.fromVersion) { close('stale'); return 'stale' as const }
      await this.#rulesChange({ section: change.section, action: 'edit', text: change.text, expectedVersion: change.fromVersion })
      close('applied')
      return 'applied' as const
    })
    this.ports.changed?.()
    if (outcome === 'stale') throw refused('lead-rules-stale', 'These words changed after the Lead proposed this, so nothing was applied. Ask the Lead to propose it again.')
    return this.view()
  }

  /** A goal's deadline, or none. The clock starts now: the Lead reports at 80% of the time and starts no round at 100%. */
  async setDeadline(params: LeadDeadlineSet): Promise<LeadAutonomyView> {
    const { logicalGoalId, deadlineAt } = parseLeadDeadlineSet(params)
    await this.#write(async () => {
      const goal = this.ports.goal?.()
      if (!goal || goal.id !== logicalGoalId || !goal.open) throw refused('lead-deadline-goal', 'There is no open goal with that id.')
      if (deadlineAt === null) delete this.#stored.deadline
      else {
        const now = this.ports.now()
        if (deadlineAt <= now) throw refused('lead-deadline-past', 'A deadline has to be in the future.')
        this.#stored.deadline = { logicalGoalId, startedAt: now, deadlineAt, reported: false }
      }
      const change = this.#change({ at: this.ports.now(), by: 'person', what: 'deadline', deadlineAt })
      await this.ports.journal.setAutonomy(this.#record(this.#modes()), change)
    })
    this.ports.changed?.()
    return this.view()
  }
  /** Whether the goal's time is up, as far as the file loaded so far says. Prefer `deadlineElapsed`, which waits for the file. */
  deadlinePassed(logicalGoalId: string): boolean {
    const deadline = this.#stored.deadline
    return !!deadline && deadline.logicalGoalId === logicalGoalId && this.ports.now() >= deadline.deadlineAt
  }
  /**
   * Whether the goal's time is up, read only once the file has loaded: after a restart a deadline that has not been read
   * yet is not a deadline that does not exist. A file that cannot be read has no deadline to honour.
   */
  async deadlineElapsed(logicalGoalId: string): Promise<boolean> {
    try { await this.#ready() } catch { return false }
    return this.deadlinePassed(logicalGoalId)
  }
  /** What the person's next message should be told when the open goal's time ran out; nothing otherwise. */
  deadlineNote(): string | undefined {
    const goal = this.ports.goal?.(), deadline = this.#stored.deadline
    if (!goal?.open || !deadline || deadline.logicalGoalId !== goal.id || this.ports.now() < deadline.deadlineAt) return undefined
    return 'The time the person set for this goal has run out. No new round, run or unasked report starts for it. Say so plainly in your answer, and ask whether they want to extend it.'
  }
  /** Runs the Lead started on its own, remembered so the cap on them holds across a restart. */
  async automaticIds(): Promise<ReadonlySet<string>> { await this.#ready().catch(() => {}); return new Set(this.#stored.automatic ?? []) }
  /** Whether the file has been read (or found unreadable and set aside), so what it remembers can be counted. */
  get loaded(): boolean { return this.#loaded || this.#unreadable }
  automaticIdsNow(): ReadonlySet<string> { return new Set(this.#stored.automatic ?? []) }
  async markAutomatic(id: string): Promise<void> {
    if (this.#stored.automatic?.includes(id)) return
    await this.#write(() => { this.#stored.automatic = [...(this.#stored.automatic ?? []), id].slice(-MAX_AUTOMATIC_IDS) })
  }
  /** Called on a timer and whenever the goal changes: says once at 80% of the time how much is left, and once when it has run out. */
  async checkDeadline(): Promise<void> {
    await this.#ready()
    const deadline = this.#stored.deadline, goal = this.ports.goal?.()
    if (!deadline) return
    if (!goal || !goal.open || goal.id !== deadline.logicalGoalId) {
      await this.#write(async () => { delete this.#stored.deadline; await this.ports.journal.setAutonomy(this.#record(this.#modes())) })
      return
    }
    const now = this.ports.now(), over = now >= deadline.deadlineAt
    if (now < deadline.startedAt + (deadline.deadlineAt - deadline.startedAt) * LEAD_DEADLINE_REPORT_SHARE) return
    if (deadline.reported && (!over || deadline.passed)) return
    const minutes = Math.max(0, Math.ceil((deadline.deadlineAt - now) / 60_000))
    await this.#write(async () => {
      await this.ports.report?.(over ? 'The deadline for this goal has passed. No new round or run will start for it, and I will not wake myself for it; your messages are still answered.'
        : `Most of the time for this goal is used: about ${minutes} minute${minutes === 1 ? '' : 's'} left. No new round starts once it runs out.`)
      this.#stored.deadline = { ...deadline, reported: true, ...(over ? { passed: true } : {}) }
    })
    this.ports.changed?.()
  }
}
