import { LEAD_AUTONOMY_DEFAULTS, LEAD_AUTONOMY_KINDS, LEAD_AUTONOMY_LABELS, LEAD_RULE_TITLES, type LeadAutonomyView, type LeadSettingsProposal } from '@harnessdesk/protocol'
import { leadClock, leadMemoryClean } from './memory.js'

export const LEAD_SETTINGS_STATUS_OPEN = '<desk-settings-status>'
export const LEAD_SETTINGS_STATUS_CLOSE = '</desk-settings-status>'
const SAID: Readonly<Record<LeadSettingsProposal['state'], string>> = {
  pending: "waits for the person's Apply or No; nothing changed yet",
  applied: 'applied by the person',
  declined: 'declined by the person; nothing changed; propose it again only if the person asks for it',
  stale: 'replaced before the person applied it; nothing changed',
}
const what = (proposal: LeadSettingsProposal): string => {
  const change = proposal.change
  if (change.kind === 'autonomy') return `${LEAD_AUTONOMY_LABELS[change.autonomy].title}: ${change.from} to ${change.to}`
  return `${LEAD_RULE_TITLES[change.section]}: ${change.add !== undefined ? `add "${leadMemoryClean(change.add, 200)}"` : `new words "${leadMemoryClean(change.text, 200)}"`}`
}

/**
 * The desk-context note that tells the Lead, on every request, which autonomy modes are in force and what became of each
 * change it proposed to its own settings, with the times the desk recorded. The Lead has no way to change a setting; a
 * proposal is a card only the person's Apply turns into a change, so a pending one has changed nothing. Null when the
 * modes are the defaults, no section was edited and nothing was proposed, so an untouched desk costs no tokens. Quoted
 * words are cleaned like memory's; the note stays within `limit` UTF-8 bytes, dropping the oldest proposals first.
 */
export const leadSettingsStatus = (view: LeadAutonomyView, limit = 2048): string | null => {
  const proposals = view.proposals ?? []
  const edited = view.rules.filter(rule => rule.custom)
  const changedModes = LEAD_AUTONOMY_KINDS.some(kind => view.modes[kind] !== LEAD_AUTONOMY_DEFAULTS[kind])
  if (!proposals.length && !edited.length && !changedModes) return null
  const rows = proposals.map(proposal =>
    `- [${proposal.id}] ${what(proposal)} — ${SAID[proposal.state]} (${proposal.history.map(event => `${event.what === 'asked-again' ? 'asked again' : event.what} ${leadClock(event.at)}`).join(', ')})`)
  const build = (shown: readonly string[]) => [
    LEAD_SETTINGS_STATUS_OPEN,
    'Your autonomy and rules as the desk holds them now. You cannot change them: autonomy_propose and rules_propose put a card in front of the person, and only the person\'s Apply changes them, on any surface they read you on. Never say a mode or rule is set unless this note lists it as applied or in force. Applied rule words reach you at your next epoch.',
    `Modes in force: ${LEAD_AUTONOMY_KINDS.map(kind => `${kind} ${view.modes[kind]}`).join(', ')}.`,
    ...(edited.length ? [`Rule sections the person edited: ${edited.map(rule => `${LEAD_RULE_TITLES[rule.id]} (version ${rule.version ?? 0})`).join(', ')}.`] : []),
    ...(shown.length ? ['What you proposed, newest first:', ...shown] : []),
    LEAD_SETTINGS_STATUS_CLOSE,
  ].join('\n')
  const bytes = (text: string) => new TextEncoder().encode(text).byteLength
  let shown = rows, text = build(shown)
  while (bytes(text) > limit && shown.length) { shown = shown.slice(0, -1); text = build(shown) }
  return text
}
