import { LEAD_AUTONOMY_DEFAULTS, LEAD_AUTONOMY_KINDS, LEAD_AUTONOMY_LABELS, LEAD_RULE_LIMITS, LEAD_RULE_TITLES, type LeadAutonomyChange, type LeadAutonomyMode, type LeadAutonomyView, type LeadRuleSectionId, type LeadSettingsProposal } from '@harnessdesk/protocol'
import { leadClock, leadMemoryClean } from './memory.js'
import { leadCleanUntrusted } from './untrusted.js'
import type { LeadState } from './state.js'

export const LEAD_SETTINGS_STATUS_OPEN = '<desk-settings-status>'
export const LEAD_SETTINGS_STATUS_CLOSE = '</desk-settings-status>'
const SAID: Readonly<Record<'pending' | 'declined', string>> = {
  pending: "waits for the person's Apply or No; nothing changed yet",
  declined: 'declined by the person; nothing changed; propose it again only if the person asks for it',
}
const what = (proposal: LeadSettingsProposal): string => {
  const change = proposal.change
  if (change.kind === 'autonomy') return `${LEAD_AUTONOMY_LABELS[change.autonomy].title}: ${change.from} to ${change.to}`
  return `${LEAD_RULE_TITLES[change.section]}: ${change.add !== undefined ? `add "${leadMemoryClean(change.add, 200)}"` : `new words "${leadMemoryClean(change.text, 200)}"`}`
}
/** Who made a change, in the Lead's words. A change applied from a proposal is still the person's: they pressed Apply. */
const who = (change: LeadAutonomyChange): string => {
  if (change.what !== 'deadline' && change.proposal !== undefined) return 'the person applied your proposal'
  if (change.what !== 'rules') return 'the person set it in Settings'
  return change.how === 'reset' ? 'the person reset it to the shipped words in Settings'
    : change.how === 'rollback' ? 'the person restored an earlier version in Settings' : 'the person edited it in Settings'
}
const last = (change: LeadAutonomyChange | undefined, since: number | null): string => change
  ? ` Last change ${leadClock(change.at)}: ${who(change)}${since !== null && change.at > since ? ', changed since your last reply' : ''}.`
  : ' Changed earlier; the desk no longer keeps when.'
const bytes = (text: string) => new TextEncoder().encode(text).byteLength
/** A section's words as the standing instructions carry them (`leadRulesAddendum`): cleaned, and none when nothing is left. */
const carried = (text: string | null | undefined): string | null => (text && leadCleanUntrusted(text, LEAD_RULE_LIMITS.chars)) || null

/** The person's own words for each section that the epoch's standing instructions hold (`leadRulesAddendum`), as the
 * child recorded them when it built them; a section absent or null there is not in them, and the Lead works it from its
 * general instructions. */
export type LeadRulesHeld = Readonly<Partial<Record<LeadRuleSectionId, string | null>>>
/** What the current epoch's standing instructions hold of the person's rules: the record the child wrote beside the
 * epoch when it built them (`memoryEpoch`), never the settings as the host reads them, which may have moved before or
 * since. Null when the current goal and epoch have no such record yet: not known, so the note prints the words. */
export const leadRulesHeld = (state: LeadState): LeadRulesHeld | null => {
  const at = state.memoryEpoch
  if (!at?.rules || at.goal !== (state.budget?.logicalGoalId ?? '') || at.epoch !== (state.context?.epoch ?? 0)) return null
  return Object.fromEntries(Object.entries(at.rules).map(([id, rule]) => [id, rule.text]))
}
/** The bytes the note may take by default: it sits after the cache mark, so every request pays for it. */
export const LEAD_SETTINGS_STATUS_BYTES = 2560

/**
 * The desk-context note that tells the Lead, on every request, its autonomy modes and rule sections as they stand now:
 * each mode's value and each section's version, with the last change and who made it, whether the person applied a
 * proposal, edited the words in Settings, restored an earlier version or reset them (#2165). What is in force is this
 * state, never the history of proposals: an applied proposal is not listed, since the state already holds it or a later
 * change of the person's replaced it. Only proposals still waiting, and those declined, are listed, without their ids,
 * which are no words for the Lead to repeat (#2167). `since` is when the Lead last answered the person with this note
 * read: a change after it is marked, and the note says nothing else is news.
 *
 * The note is billed on every request, so a section's words are printed only where they differ from the words `held`
 * says the epoch's instructions were built with, compared as the instructions carry them (cleaned; words that clean to
 * nothing are none): a section the person never changed, or one the instructions already hold, is one line. `held`
 * null means not known (no record of the epoch yet), and every changed section prints its words. Modes at their default share one line. Null when the modes are the defaults, no section was ever
 * changed and nothing is open, so an untouched desk costs nothing. Words are cleaned like the rules in the standing
 * instructions; the note stays within `limit` UTF-8 bytes, dropping the oldest proposals first and then clipping the
 * printed words, which then say "(shortened)".
 */
export const leadSettingsStatus = (view: LeadAutonomyView, limit: number = LEAD_SETTINGS_STATUS_BYTES, since: number | null = null, held: LeadRulesHeld | null = null): string | null => {
  const proposals = (view.proposals ?? []).filter(proposal => proposal.state === 'pending' || proposal.state === 'declined')
  const changes = view.changes ?? []
  const changedModes = LEAD_AUTONOMY_KINDS.some(kind => view.modes[kind] !== LEAD_AUTONOMY_DEFAULTS[kind])
  const changedRules = view.rules.some(rule => rule.custom || (rule.version ?? 0) > 0)
  if (!proposals.length && !changedModes && !changedRules && !changes.some(change => change.what !== 'deadline')) return null
  const modeChange = (kind: typeof LEAD_AUTONOMY_KINDS[number]) => changes.find(one => one.what === 'mode' && one.kind === kind)
  const untouched = LEAD_AUTONOMY_KINDS.filter(kind => !modeChange(kind) && view.modes[kind] === LEAD_AUTONOMY_DEFAULTS[kind])
  const defaults = [...new Set(untouched.map(kind => view.modes[kind]))].map((mode: LeadAutonomyMode) =>
    `- ${untouched.filter(kind => view.modes[kind] === mode).map(kind => `${LEAD_AUTONOMY_LABELS[kind].title} (${kind})`).join(', ')}: ${mode}, the default; never changed.`)
  const modes = [...LEAD_AUTONOMY_KINDS.filter(kind => !untouched.includes(kind))
    .map(kind => `- ${LEAD_AUTONOMY_LABELS[kind].title} (${kind}): ${view.modes[kind]}.${last(modeChange(kind), since)}`), ...defaults]
  const rows = proposals.map(proposal =>
    `- ${what(proposal)} — ${SAID[proposal.state as 'pending' | 'declined']} (${proposal.history.map(event => `${event.what === 'asked-again' ? 'asked again' : event.what} ${leadClock(event.at)}`).join(', ')})`)
  const rules = (chars: number) => view.rules.flatMap(rule => {
    const version = rule.version ?? 0, title = `${LEAD_RULE_TITLES[rule.id]} (${rule.id})`
    if (version === 0 && !rule.custom) return [`- ${title}: the shipped words; never changed.`]
    const change = changes.find(one => one.what === 'rules' && one.section === rule.id && one.version === version)
    const which = rule.custom ? `version ${version}` : 'the shipped words'
    // What the instructions hold for the section: the person's words, or none. Equal, the words are not sent again.
    if (held && carried(rule.custom ? rule.text : null) === carried(held[rule.id])) return [`- ${title}, ${which}, same as your instructions.${last(change, since)}`]
    const whole = leadCleanUntrusted(rule.text, LEAD_RULE_LIMITS.chars), words = leadCleanUntrusted(rule.text, chars)
    return [`- ${title}, ${which}.${last(change, since)} Your instructions ${held ? 'hold' : 'may hold'} other words; these hold now:`,
      ...(words ? words.split('\n').map(line => `  ${line}`) : ['  (none)']), ...(words !== whole ? ['  (shortened)'] : [])]
  })
  const build = (shown: readonly string[], chars: number) => [
    LEAD_SETTINGS_STATUS_OPEN,
    'Your autonomy modes and rule sections as they stand now. Only the person changes them, by Apply on your card or in Settings: a request is in force only when a mode or the words here say it; otherwise propose it again. Words printed here hold over your person-rules; a section without words is as your instructions have it.',
    'Reference, not news: never recap it. Mention a setting only when the person asks, or when its line says changed since your last reply.',
    'Modes:', ...modes,
    'Rule sections:', ...rules(chars),
    ...(shown.length ? ['Your proposals still open or declined, newest first:', ...shown] : []),
    LEAD_SETTINGS_STATUS_CLOSE,
  ].join('\n')
  let shown = rows, chars: number = LEAD_RULE_LIMITS.chars, text = build(shown, chars)
  while (bytes(text) > limit && shown.length) { shown = shown.slice(0, -1); text = build(shown, chars) }
  while (bytes(text) > limit && chars > 80) { chars = Math.floor(chars / 2); text = build(shown, chars) }
  return text
}
