import type { LeadPresence as LeadChecks, LeadRunReading } from '@harnessdesk/protocol'
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
  if (state.settings?.unavailable) return { mood: 'sleeping', word: 'Unavailable', needs: 0, goalActive: false }
  if (state.error) return { mood: 'sleeping', word: 'Desk offline', needs: 0, goalActive: false }
  if (!thread) return { mood: 'neutral', word: 'Ready', needs: 0, goalActive: false }
  const started = thread.state !== 'draft' || thread.messages.some(message => message.role === 'user')
  const goalActive = started && !ENDED.has(thread.state)
  if (state.waitReason === 'lead-result-awaiting-person') return { mood: 'done', word: 'Done · ready to accept', needs: 1, goalActive }
  const needs = state.personActions.length + (state.wayOut ? 1 : 0) + (thread.state === 'awaiting-plan' && state.wayOut !== 'decide-plan' ? 1 : 0)
  if (needs || thread.state === 'waiting-for-user') return { mood: 'alert', word: `${Math.max(needs, 1)} need${Math.max(needs, 1) === 1 ? 's' : ''} you`, needs: Math.max(needs, 1), goalActive }
  if (thread.state === 'stopped') return { mood: 'sleeping', word: 'Paused', needs: 0, goalActive: false }
  if (thread.state === 'accepted') return { mood: 'done', word: 'Done', needs: 0, goalActive: false }
  if (thread.state === 'following') return { mood: 'neutral', word: 'Following', needs: 0, goalActive }
  if (goalActive) return { mood: 'working', word: 'Working · 1 goal', needs: 0, goalActive }
  return { mood: 'neutral', word: 'Ready', needs: 0, goalActive: false }
}

/** "Checked 3 times · nothing new · stayed quiet": what the Lead did between turns without spending a request. */
export const leadWakeLine = (checks: LeadChecks | null): string | null => {
  if (!checks?.checked) return null
  const times = `Checked ${checks.checked} time${checks.checked === 1 ? '' : 's'}`
  return checks.quiet === checks.checked ? `${times} · nothing new · stayed quiet` : `${times} · ${checks.checked - checks.quiet} worth a look`
}

const READING: Record<LeadRunReading['kind'], string> = { advanced: 'moving', stuck: 'stuck', 'plan-only': 'planned, nothing done', blocked: 'blocked', done: 'done' }
/** One phrase per run the Lead owns: "Run 1 moving", "Run 2 stuck · quiet 24 min". */
export const leadReadingWords = (checks: LeadChecks | null): readonly string[] => (checks?.readings ?? []).map((reading, index) =>
  `Run ${index + 1} ${READING[reading.kind]}${reading.kind === 'stuck' && reading.quietMinutes !== undefined ? ` · quiet ${reading.quietMinutes} min` : ''}`)
