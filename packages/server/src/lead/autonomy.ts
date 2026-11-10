import { randomUUID } from 'node:crypto'
import { rename } from 'node:fs/promises'
import type { LeadState } from '@harnessdesk/lead'
import { leadAutonomyMode, leadRulesAddendum } from '@harnessdesk/lead'
import { LEAD_AUTONOMY_DEFAULTS, LEAD_AUTONOMY_KINDS, LEAD_RULE_DEFAULTS, LEAD_RULE_LIMITS, LEAD_RULE_SECTIONS, LEAD_RULE_TITLES, parseLeadAutonomySet, parseLeadDeadlineSet,
  parseLeadRulesUpdate, type LeadAutonomyKind, type LeadAutonomyMode, type LeadAutonomyModes, type LeadAutonomyRecord, type LeadAutonomySet, type LeadAutonomyView,
  type LeadDeadline, type LeadDeadlineSet, type LeadRuleSectionId, type LeadRuleSectionView, type LeadRulesUpdate, type LeadRulesView, type LeadRuleVersion,
  type LeadWakeRecord } from '@harnessdesk/protocol'
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
    setAutonomy(autonomy: LeadAutonomyRecord): Promise<void>
    recordWake(wake: LeadWakeRecord): Promise<void>
  }
  /** The goal in hand, for a deadline: null when none is open. */
  readonly goal?: () => { readonly id: string; readonly open: boolean } | null
  /** The Lead's own words to the person, for the 80% report. */
  readonly report?: (text: string) => Promise<void>
  /** The shipped defaults; a later build raises a section's version to show the person what changed. */
  readonly defaults?: typeof LEAD_RULE_DEFAULTS
  readonly changed?: () => void
}

interface SectionFile { versions: LeadRuleVersion[]; acked?: number }
interface Stored {
  version: 1
  sections: Partial<Record<LeadRuleSectionId, SectionFile>>
  deadline?: LeadDeadline
}
const fresh = (): Stored => ({ version: 1, sections: {} })
const refused = (code: string, message = code) => Object.assign(new Error(message), { wireCode: code })
const unreadable = () => Object.assign(new Error('The Lead autonomy file could not be read just now, so nothing was written. Try again in a moment.'), { wireCode: 'unavailable' })
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
    return { modes, rules }
  }
  #modes(): LeadAutonomyModes { return this.ports.journal.state.autonomy?.modes ?? LEAD_AUTONOMY_DEFAULTS }

  /** After a start: the journal says what the file says. A crash between the two writes leaves the file ahead, never behind. */
  async attach(): Promise<void> {
    await this.#ready()
    await this.ports.journal.setAutonomy(this.#record(this.#modes()))
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
    const deadline = this.#stored.deadline && state.budget?.logicalGoalId === this.#stored.deadline.logicalGoalId ? this.#stored.deadline : null
    return { version: 1, modes: this.#modes(), observed, deadline,
      rules: LEAD_RULE_SECTIONS.map(id => { const custom = this.#custom(id); return { id, title: LEAD_RULE_TITLES[id], text: custom?.text ?? this.#defaults[id].text, custom: !!custom } }) }
  }
  async set(params: LeadAutonomySet): Promise<LeadAutonomyView> {
    const { kind, mode } = parseLeadAutonomySet(params)
    await this.#write(async () => {
      const current = this.#modes()
      if (current[kind] === mode) return
      await this.ports.journal.setAutonomy(this.#record({ ...current, [kind]: mode }))
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
    await this.#write(async () => {
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
      await this.ports.journal.setAutonomy(this.#record(this.#modes()))
    })
    this.ports.changed?.()
    return this.rules()
  }

  /** A goal's deadline, or none. The clock starts now: the Lead reports at 80% of the time and starts no round at 100%. */
  async setDeadline(params: LeadDeadlineSet): Promise<LeadAutonomyView> {
    const { logicalGoalId, deadlineAt } = parseLeadDeadlineSet(params)
    await this.#write(async () => {
      const goal = this.ports.goal?.()
      if (!goal || goal.id !== logicalGoalId || !goal.open) throw refused('lead-deadline-goal', 'There is no open goal with that id.')
      if (deadlineAt === null) { delete this.#stored.deadline; return }
      const now = this.ports.now()
      if (deadlineAt <= now) throw refused('lead-deadline-past', 'A deadline has to be in the future.')
      this.#stored.deadline = { logicalGoalId, startedAt: now, deadlineAt, reported: false }
    })
    this.ports.changed?.()
    return this.view()
  }
  /** Whether the goal's time is up: no new round or step starts for it. Read at every admission, so it needs no timer. */
  deadlinePassed(logicalGoalId: string): boolean {
    const deadline = this.#stored.deadline
    return !!deadline && deadline.logicalGoalId === logicalGoalId && this.ports.now() >= deadline.deadlineAt
  }
  /** Called on a timer and whenever the goal changes: says once, at 80% of the time, how much is left. */
  async checkDeadline(): Promise<void> {
    await this.#ready()
    const deadline = this.#stored.deadline, goal = this.ports.goal?.()
    if (!deadline) return
    if (!goal || !goal.open || goal.id !== deadline.logicalGoalId) { await this.#write(() => { delete this.#stored.deadline }); return }
    const now = this.ports.now()
    if (deadline.reported || now < deadline.startedAt + (deadline.deadlineAt - deadline.startedAt) * LEAD_DEADLINE_REPORT_SHARE) return
    const minutes = Math.max(0, Math.ceil((deadline.deadlineAt - now) / 60_000))
    await this.#write(async () => {
      await this.ports.report?.(now >= deadline.deadlineAt ? 'The deadline for this goal has passed. No new round will start.'
        : `Most of the time for this goal is used: about ${minutes} minute${minutes === 1 ? '' : 's'} left. No new round starts once it runs out.`)
      this.#stored.deadline = { ...deadline, reported: true }
    })
    this.ports.changed?.()
  }
}
