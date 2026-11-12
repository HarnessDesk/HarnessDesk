import { LEAD_AUTONOMY_DEFAULTS, LEAD_AUTONOMY_KINDS, LEAD_AUTONOMY_LABELS, LEAD_RULE_LIMITS, LEAD_RULE_TITLES, type LeadAutonomyChange, type LeadAutonomyView, type LeadSettingsProposal } from '@harnessdesk/protocol'
import { leadClock, leadMemoryClean } from './memory.js'
import { leadCleanUntrusted } from './untrusted.js'

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

/**
 * The desk-context note that tells the Lead, on every request, its autonomy modes and rule sections as they stand now:
 * each mode's value and each section's version and current words, with the last change and who made it, whether the
 * person applied a proposal, edited the words in Settings, restored an earlier version or reset them (#2165). What is in
 * force is this state, never the history of proposals: an applied proposal is not listed, since the state already holds
 * it or a later change of the person's replaced it. Only proposals still waiting, and those declined, are listed, without
 * their ids, which are no words for the Lead to repeat (#2167). `since` is when the Lead was last shown this note: a
 * change after it is marked, and the note says that nothing else is news. Null when the modes are the defaults, no
 * section was ever changed and nothing is open, so an untouched desk costs no tokens. Words are cleaned like the rules
 * in the standing instructions; the note stays within `limit` UTF-8 bytes, dropping the oldest proposals first and then
 * clipping each section's words.
 */
export const leadSettingsStatus = (view: LeadAutonomyView, limit = 8192, since: number | null = null): string | null => {
  const proposals = (view.proposals ?? []).filter(proposal => proposal.state === 'pending' || proposal.state === 'declined')
  const changes = view.changes ?? []
  const changedModes = LEAD_AUTONOMY_KINDS.some(kind => view.modes[kind] !== LEAD_AUTONOMY_DEFAULTS[kind])
  const changedRules = view.rules.some(rule => rule.custom || (rule.version ?? 0) > 0)
  if (!proposals.length && !changedModes && !changedRules && !changes.some(change => change.what !== 'deadline')) return null
  const modes = LEAD_AUTONOMY_KINDS.map(kind => {
    const change = changes.find(one => one.what === 'mode' && one.kind === kind)
    const never = !change && view.modes[kind] === LEAD_AUTONOMY_DEFAULTS[kind]
    return `- ${LEAD_AUTONOMY_LABELS[kind].title} (${kind}): ${view.modes[kind]}.${never ? ' The default; never changed.' : last(change, since)}`
  })
  const rows = proposals.map(proposal =>
    `- ${what(proposal)} — ${SAID[proposal.state as 'pending' | 'declined']} (${proposal.history.map(event => `${event.what === 'asked-again' ? 'asked again' : event.what} ${leadClock(event.at)}`).join(', ')})`)
  const rules = (chars: number) => view.rules.flatMap(rule => {
    const version = rule.version ?? 0
    const change = changes.find(one => one.what === 'rules' && one.section === rule.id && one.version === version)
    const head = `- ${LEAD_RULE_TITLES[rule.id]} (${rule.id}), ${rule.custom ? `version ${version}` : 'the shipped words'}.${version === 0 ? ' Never changed.' : last(change, since)}`
    const words = leadCleanUntrusted(rule.text, chars)
    return [`${head} Words now:`, ...(words ? words.split('\n').map(line => `  ${line}`) : ['  (none)'])]
  })
  const build = (shown: readonly string[], chars: number) => [
    LEAD_SETTINGS_STATUS_OPEN,
    'Your autonomy modes and rule sections as they stand now, whoever changed them last. You cannot change them: autonomy_propose and rules_propose put a card in front of the person, and only the person, by Apply on a card or in Settings on any surface, changes them. Something the person asks for is in force only when the mode or the words below say it, whatever was proposed or applied before; when they do not, propose it again. The words here are current, and where they differ from the person-rules in your instructions, these hold.',
    'This is reference, not news: do not recap it, report on it or correct an earlier reply from it. Mention a setting only when the person asks about it, or when its line below says changed since your last reply.',
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
