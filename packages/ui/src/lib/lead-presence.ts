import type { LeadState } from '../state/lead'
import type { LeadMood } from './lead-faces'

/** One word for where the Lead stands, shared by the sidebar, the bar, the popover and the phone. */
export interface LeadPresence {
  readonly mood: LeadMood
  readonly word: string
  /** Things only the person can do now: live approvals, a plan, a resume. */
  readonly needs: number
  readonly goalActive: boolean
}

const ENDED = new Set(['stopped', 'accepted', 'declined'])

/** Read from the projection alone; it grants nothing. */
export const leadPresence = (state: LeadState): LeadPresence => {
  const thread = state.thread
  if (state.error) return { mood: 'sleeping', word: 'Desk offline', needs: 0, goalActive: false }
  if (!thread) return { mood: 'neutral', word: 'Ready', needs: 0, goalActive: false }
  const started = thread.state !== 'draft' || thread.messages.some(message => message.role === 'user')
  const goalActive = started && !ENDED.has(thread.state)
  if (state.waitReason === 'lead-result-awaiting-person') return { mood: 'done', word: 'Done · ready to accept', needs: 1, goalActive }
  const needs = state.personActions.length + (state.wayOut ? 1 : 0) + (thread.state === 'awaiting-plan' && state.wayOut !== 'decide-plan' ? 1 : 0)
  if (needs || thread.state === 'waiting-for-user') return { mood: 'alert', word: `${Math.max(needs, 1)} need${Math.max(needs, 1) === 1 ? 's' : ''} you`, needs: Math.max(needs, 1), goalActive }
  if (thread.state === 'stopped') return { mood: 'sleeping', word: 'Paused', needs: 0, goalActive: false }
  if (thread.state === 'accepted') return { mood: 'done', word: 'Done', needs: 0, goalActive: false }
  if (goalActive) return { mood: 'working', word: 'Working · 1 goal', needs: 0, goalActive }
  return { mood: 'neutral', word: 'Ready', needs: 0, goalActive: false }
}
