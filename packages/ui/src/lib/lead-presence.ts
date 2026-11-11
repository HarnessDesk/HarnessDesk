import { isWaitingOnYou, leadPersonNeeds } from '@harnessdesk/protocol'
import type { LeadPresence as LeadChecks, LeadRunReading } from '@harnessdesk/protocol'
import type { LeadState } from '../state/lead'
import type { LeadMood } from './lead-faces'

/** One word for where the Lead stands, shared by the sidebar, the bar, the popover and the phone. */
export interface LeadPresence {
  readonly mood: LeadMood
  readonly word: string
  /** Things only the person can do now: approvals, a plan, or recovery. */
  readonly needs: number
  readonly goalActive: boolean
  /**
   * Nothing has changed that the person needs to see. The sidebar row and the
   * bar draw no word then — a word on every row at rest is noise — and the
   * status popover still says it.
   */
  readonly quiet: boolean
}

const needWord = (count: number) => `${count} need${count === 1 ? 's' : ''} you`
const ENDED = new Set(['stopped', 'accepted', 'declined'])

/** Read from the projection alone; it grants nothing. */
export const leadPresence = (state: LeadState): LeadPresence => ({ quiet: false, ...reading(state) })
const AT_REST = { mood: 'neutral', word: 'Ready', needs: 0, goalActive: false, quiet: true } as const
const reading = (state: LeadState): Omit<LeadPresence, 'quiet'> & { readonly quiet?: boolean } => {
  const thread = state.thread
  if (state.settings?.unavailable) return { mood: 'sleeping', word: 'Unavailable', needs: 0, goalActive: false }
  if (state.error) return { mood: 'sleeping', word: 'Desk offline', needs: 0, goalActive: false }
  // The page itself asks for the folder; the row and the bar stay quiet rather than repeat it.
  if (state.projectMissing && !thread) return { mood: 'neutral', word: 'No folder open', needs: 0, goalActive: false, quiet: true }
  if (!thread) return AT_REST
  const started = thread.state !== 'draft' || thread.messages.some(message => message.role === 'user')
  const reviewed = !!thread.contract || !!thread.pr || thread.cards.some(card => card.type === 'plan')
  const goalActive = reviewed && started && !ENDED.has(thread.state)
  const needs = leadPersonNeeds({ personActions: state.personActions, wayOut: state.wayOut, waitReason: state.waitReason, thread })
  const waiting = state.stage === undefined ? needs > 0 || thread.state === 'waiting-for-user' || state.waitReason === 'lead-result-awaiting-person' : isWaitingOnYou(state.stage)
  if (waiting && (state.stage === 'you-review' || state.waitReason === 'lead-result-awaiting-person')) return { mood: 'done', word: 'Done · ready to accept', needs: 1, goalActive }
  if (waiting) return { mood: 'alert', word: needWord(Math.max(needs, 1)), needs: Math.max(needs, 1), goalActive }
  if (thread.state === 'stopped') return { mood: 'sleeping', word: 'Paused', needs: 0, goalActive: false }
  if (thread.state === 'accepted') return { mood: 'done', word: 'Done', needs: 0, goalActive: false }
  if (thread.state === 'following') return { mood: 'neutral', word: 'Following', needs: 0, goalActive }
  if (goalActive) return { mood: 'working', word: 'Working · 1 goal', needs: 0, goalActive }
  if (state.requestInFlight) return { mood: 'working', word: 'Thinking', needs: 0, goalActive: false }
  return AT_REST
}

/**
 * The Lead's word with the desk's own count (`LeadInbox.needsYou`), so the Lead's row, its bar and the bell say the same
 * number: the Lead's approvals and everything else on the desk that waits on the person. Until the desk has answered,
 * or while its answer has not yet caught up with a need the Lead's own projection already shows, the projection stands.
 */
export const withDeskNeeds = (presence: LeadPresence, needs: number | null | undefined): LeadPresence => {
  if (needs === null || needs === undefined || needs <= 0 || needs < presence.needs) return presence
  if (presence.mood === 'sleeping' && presence.word !== 'Paused') return presence
  if (needs === presence.needs && presence.word === 'Done · ready to accept') return presence
  // A paused Lead stays paused: the desk's count goes beside the word, and the face stays asleep.
  if (presence.word === 'Paused') return { ...presence, word: `Paused · ${needWord(needs)}`, needs, quiet: false }
  return { ...presence, mood: presence.needs > 0 || presence.mood === 'done' ? 'alert' : presence.mood, word: needWord(needs), needs, quiet: false }
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
