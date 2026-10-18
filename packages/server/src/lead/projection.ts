import { LEAD_LIMITS, windowLeadThread, type LeadProject, type LeadSettingsProjection } from '@harnessdesk/protocol'
import type { LeadState } from '@harnessdesk/lead'

/** Reserve the entire envelope; messages may be windowed, actionable cards may not. */
export const leadWindowThread = (state: LeadState, project: LeadProject, settings: LeadSettingsProjection) => {
  const overhead = new TextEncoder().encode(JSON.stringify({ version: 1, revision: state.seq, settings, thread: null })).byteLength + 512
  return windowLeadThread({ version: 1, id: 'lead', revision: state.seq, state: state.phase, project,
    olderMessages: state.olderMessages, messages: state.messages,
    cards: state.cards.filter(card => !state.decidedCards.includes(`${card.id}:${card.revision}`)) }, LEAD_LIMITS.ipcBytes - overhead)
}
