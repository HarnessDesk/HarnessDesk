import { useEffect, useRef, useState } from 'react'
import { leadProactiveReport, type LeadProactive } from '@harnessdesk/protocol'
import { LeadProactiveCard } from './LeadCards'
import { Banner } from '../design'
import { leadPresence } from '../lib/lead-presence'
import type { LeadState } from '../state/lead'
import { leadDollars } from './LeadCards'

/** What this viewer last saw of the Lead. It lives in this browser only: a convenience, never a record. */
interface LeadSeen { readonly at: number; readonly revision: number; readonly spent: number }
const KEY = 'hd-lead-seen-v1'
/** Shorter absences are a glance away, not an absence worth a summary. */
export const LEAD_AWAY_MS = 5 * 60_000

const read = (): LeadSeen | null => {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<LeadSeen> | null
    return value && Number.isSafeInteger(value.at) && Number.isSafeInteger(value.revision) && Number.isSafeInteger(value.spent) ? value as LeadSeen : null
  } catch { return null }
}
const write = (value: LeadSeen) => { try { localStorage.setItem(KEY, JSON.stringify(value)) } catch { /* Viewer storage can be unavailable. */ } }
const spentOf = (state: LeadState) => state.thread?.budget ? state.thread.budget.leadUsdMicros + state.thread.budget.workerUsdMicros : 0
const clock = (at: number) => new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at)
const zone = (at: number) => new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(at).find(part => part.type === 'timeZoneName')?.value ?? ''

export interface LeadAwayDigest { readonly title: string; readonly report: LeadProactive }

/** The four lines a person needs on return: what was said, where the goal stands, what waits for them, what it cost. */
export const leadAwayDigest = (seen: LeadSeen, state: LeadState, label: string, now: number): LeadAwayDigest | null => {
  if (state.revision <= seen.revision || now - seen.at < LEAD_AWAY_MS || !state.thread) return null
  const presence = leadPresence(state)
  const said = state.thread.messages.filter(message => message.role === 'assistant' && message.revision > seen.revision).length
  const decided = (state.thread.decisions ?? []).filter(decision => decision.position > seen.revision).length
  const spent = Math.max(0, spentOf(state) - seen.spent)
  return {
    title: `While you were away · ${clock(seen.at)}–${clock(now)} ${zone(now)}`.trim(),
    report: leadProactiveReport({
      finding: said ? `${label} wrote ${said} message${said === 1 ? '' : 's'} while you were away.` : `${label} stayed quiet while you were away.`,
      caveat: `${decided} decisions settled; ${leadDollars(spent)} reported spent while away.`,
      ask: presence.needs ? 'Inspect the waiting decision below.' : 'Send a message when you have another goal.',
    }, state.presence?.lastCheckedAt ?? 0, now, !state.error && !!state.presence?.lastCheckedAt && state.presence.lastCheckedAt >= now),
  }
}

/** Shown once on return, kept until dismissed or the next absence; what is seen is recorded while the page is in view. */
export const LeadAway = ({ active, state, label }: { readonly active: boolean; readonly state: LeadState; readonly label: string }) => {
  // The absence is fixed on return; its lines are read from the live state, so a card settled since says so.
  const [away, setAway] = useState<{ readonly seen: LeadSeen; readonly back: number } | null>(null)
  const wasActive = useRef(false)
  useEffect(() => {
    if (state.revision < 0 || state.error) return
    if (active && !wasActive.current) { const seen = read(); setAway(seen ? { seen, back: Date.now() } : null) }
    wasActive.current = active
    if (active && document.visibilityState !== 'hidden') write({ at: Date.now(), revision: state.revision, spent: spentOf(state) })
  }, [active, state.revision, state.error])
  // A window left open in the background is an absence too: the return is the tab coming back into view.
  useEffect(() => {
    const back = () => {
      if (!active || document.visibilityState === 'hidden' || state.revision < 0 || state.error) return
      const seen = read(); if (seen) setAway({ seen, back: Date.now() })
      write({ at: Date.now(), revision: state.revision, spent: spentOf(state) })
    }
    document.addEventListener('visibilitychange', back)
    return () => document.removeEventListener('visibilitychange', back)
  })
  const digest = away && !state.error ? leadAwayDigest(away.seen, state, label, away.back) : null
  if (!digest) return null
  return <div data-slot="lead-away"><Banner title={digest.title} onDismiss={() => setAway(null)}>
    <LeadProactiveCard report={digest.report} />
  </Banner></div>
}
