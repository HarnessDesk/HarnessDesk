import { LEAD_LIMITS, windowLeadThread, type LeadCard, type LeadProject, type LeadSettingsProjection } from '@harnessdesk/protocol'
import type { LeadState } from '@harnessdesk/lead'

/** Reserve the entire envelope; messages may be windowed, actionable cards may not. */
export const leadWindowThread = (state: LeadState, project: LeadProject, settings: LeadSettingsProjection) => {
  const overhead = new TextEncoder().encode(JSON.stringify({ version: 1, revision: state.seq, settings, thread: null })).byteLength + 512
  return windowLeadThread({ version: 1, id: 'lead', revision: state.seq, state: state.phase, project,
    olderMessages: state.olderMessages, messages: state.messages,
    cards: state.cards.filter(card => !state.decidedCards.includes(`${card.id}:${card.revision}`)) }, LEAD_LIMITS.ipcBytes - overhead)
}

/** Shared by child offers and settings writers, inside the journal mutation queue. */
export const admitLeadCard = (state: LeadState, card: LeadCard, project: LeadProject, model: string): void => {
  if (!state.policy || !state.budget) throw Object.assign(new Error('lead-unavailable'), { wireCode: 'lead-unavailable' })
  try {
    leadWindowThread({ ...state, seq: state.seq + 1, cards: [...state.cards.filter(old => old.id !== card.id), card] }, project, {
      version: 1, model, policy: state.policy, caps: state.budget.caps, key: { configured: false, protection: 'unavailable' },
    })
  } catch { throw Object.assign(new Error('lead-card-too-large'), { wireCode: 'lead-card-too-large' }) }
}
