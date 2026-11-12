import { useEffect, useRef, useState } from 'react'
import { LEAD_DIGEST_ITEM_LABELS, leadDigestMore, type LeadAskState, type LeadDigest, type LeadDigestItem } from '@harnessdesk/protocol'
import { Button, ListRow, ListRows, Spinner, ToolGroup, ToolProse, ToolSection, TopBarToolButton } from '../design'
import { sanitizeText } from '../lib/sanitize'
import { useSnapshot, useStore } from '../state/context'
import type { LeadState } from '../state/lead'
import { ChevronIcon, CrossIcon, ExternalIcon, HistoryIcon } from './Icons'
import { leadDollars } from './LeadCards'
import { leadDigestTarget, openLeadRefTarget } from './LeadRefs'

const clock = (at: number) => new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at)
const zone = (at: number) => new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(at).find(part => part.type === 'timeZoneName')?.value ?? ''

/** How often an open window asks again, so a question that ran out of time stops offering answers. */
export const LEAD_PRESENCE_REFRESH_MS = 60_000
/** How long after the person last touched the window a read still says they looked. An open window nobody uses is not
 * someone looking, or the desk would never see them away. */
export const LEAD_PRESENCE_IDLE_MS = 2 * 60_000
const LEAD_PRESENCE_INPUT = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'focus'] as const

/** When the person last touched this window, on any page: the window is theirs, whichever page it shows. */
let leadTouchedAt = Date.now()
/** Marks a look now: the person's own input, bringing the window forward, or opening the Lead. */
export const leadPresenceTouch = (at = Date.now()): void => { leadTouchedAt = at }
/** Whether a read now says the person looked: they touched the window within the idle span. */
export const leadPresenceLooking = (now = Date.now()): boolean => now - leadTouchedAt < LEAD_PRESENCE_IDLE_MS

/**
 * The window's presence for the whole app, mounted once beside every page: it follows the person's input and refreshes
 * the host's record whichever page is showing, so an hour in chats or Settings is an hour looked at, not an absence the
 * Lead is later told about. A refresh in a window nobody touches still reads (asks expire, digests arrive) but does not
 * say they looked, so the desk can see them away; the first touch after reads at once, so the away digest comes with it.
 */
export const useLeadPresence = (enabled: boolean): void => {
  const store = useStore()
  useEffect(() => {
    if (!enabled) return
    const read = () => {
      const state = store.lead.state
      if (document.visibilityState === 'hidden' || state.revision < 0 || state.error) return
      void store.lead.readAway({ active: leadPresenceLooking() }).catch(() => {})
    }
    const input = () => { const back = !leadPresenceLooking(); leadPresenceTouch(); if (back) read() }
    const shown = () => { if (document.visibilityState !== 'hidden') leadPresenceTouch(); read() }
    const timer = setInterval(read, LEAD_PRESENCE_REFRESH_MS)
    document.addEventListener('visibilitychange', shown)
    for (const name of LEAD_PRESENCE_INPUT) window.addEventListener(name, input, { passive: true, capture: true })
    return () => {
      clearInterval(timer); document.removeEventListener('visibilitychange', shown)
      for (const name of LEAD_PRESENCE_INPUT) window.removeEventListener(name, input, { capture: true })
    }
  }, [store, enabled])
}

/** The digest's last line: what the list had no room for, then what was spent. */
export const leadDigestNote = (digest: LeadDigest): string =>
  `${digest.more > 0 ? `${leadDigestMore(digest.more)} · ` : ''}${leadDollars(digest.spentUsdMicros)} spent${digest.kind === 'away' ? ' while away' : ''}`
export const leadDigestTitle = (digest: LeadDigest): string =>
  digest.kind === 'brief' ? 'Morning brief' : digest.kind === 'recap' ? 'What happened' : `While you were away · ${clock(digest.from)}–${clock(digest.to)} ${zone(digest.to)}`.trim()

/** The digest's items in the order the person acts on them: Needs you, then Stopped or stuck, then Done. */
export const leadDigestSections = (digest: LeadDigest) =>
  (['waiting', 'stopped', 'done'] as const).map(kind => ({ kind, label: LEAD_DIGEST_ITEM_LABELS[kind], items: digest.items.filter(item => item.kind === kind) })).filter(section => section.items.length > 0)

/**
 * The line under a digest item. A stop the host saw someone make says who, in the reader's words: "You stopped it" for
 * the person on any surface, the Lead by its name. Anything else is the host's own latest fact.
 */
export const leadDigestLine = (item: LeadDigestItem, lead: string): string | undefined =>
  item.kind === 'stopped' && item.stoppedBy === 'person' ? 'You stopped it'
    : item.kind === 'stopped' && item.stoppedBy === 'lead' ? `${lead} stopped it`
    : item.fact ? sanitizeText(item.fact) : undefined

/**
 * The asks as they stand this instant: an open question whose time has come reads expired at once, without waiting for
 * the next refresh, so its buttons are gone the moment it runs out.
 */
export const leadAsksAt = (asks: readonly LeadAskState[], now: number): readonly LeadAskState[] =>
  asks.map(ask => ask.status === 'open' && ask.expiresAt !== undefined && ask.expiresAt <= now ? { ...ask, status: 'expired' as const } : ask)

export const useLeadAsks = (asks: readonly LeadAskState[]): readonly LeadAskState[] => {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const current = Date.now()
    const next = asks.flatMap(ask => ask.status === 'open' && ask.expiresAt !== undefined && ask.expiresAt > current ? [ask.expiresAt] : [])
    if (!next.length) return
    // setTimeout holds at most about 24 days; a later expiry is picked up by the refresh that comes first.
    const timer = setTimeout(() => setTick(count => count + 1), Math.min(Math.min(...next) - current + 50, 2 ** 31 - 1))
    return () => clearTimeout(timer)
  }, [asks, tick])
  return leadAsksAt(asks, Date.now())
}

/**
 * The way back to the digest: what changed in the last day, on demand and for this window only. It is a top-bar tool,
 * one click from anywhere in the thread: at the foot of the rail it sat under the work list, and a narrow window draws
 * that rail over the thread, so it covered the card the click brings (#2168).
 */
export const LeadRecap = () => {
  const store = useStore()
  // Reading the ledger can take seconds: the button says so, so the first click is seen to work and is not repeated.
  const [reading, setReading] = useState(false)
  const recap = () => {
    setReading(true)
    void store.lead.readAway({ active: true, recap: true }).catch(() => {}).finally(() => setReading(false))
  }
  const label = reading ? 'Reading…' : 'What happened?'
  return <TopBarToolButton data-lead-recap aria-label={label} title={label} disabled={reading} aria-busy={reading || undefined} onClick={recap}>
    {reading ? <Spinner /> : <HistoryIcon />}</TopBarToolButton>
}

/**
 * The digest the host built for this window, at the top of the Lead conversation. What the window has seen is the host's
 * record, kept per device; a dismissal is the desk's, so dismissing here clears the phone's card too. Each item the desk
 * can find opens it: the chat, the Team, the pull request or the decision card.
 */
export const LeadAway = ({ active, state, label }: { readonly active: boolean; readonly state: LeadState; readonly label?: string }) => {
  const store = useStore(), snapshot = useSnapshot()
  const ready = active && state.revision >= 0 && !state.error
  // Opening the Lead is a look, whatever the input clock says; a new reply after that reads with the clock, which
  // useLeadPresence keeps for every page.
  const opened = useRef(false)
  useEffect(() => {
    if (!ready) { opened.current = false; return }
    if (!opened.current) { opened.current = true; leadPresenceTouch() }
    if (document.visibilityState === 'hidden') return
    void store.lead.readAway({ active: leadPresenceLooking() }).catch(() => {})
  }, [store, ready, state.revision])
  const digest = state.error ? null : state.away?.digest
  if (!digest) return null
  const dismiss = () => { void store.lead.dismissDigest(digest.id).catch(() => {}) }
  const chats = new Set([...state.chats.map(chat => chat.id), ...(state.work?.items ?? []).flatMap(item => item.links.chats)])
  const desk = { runtimes: snapshot.runtimes, sessions: snapshot.sessions, teams: snapshot.teams, goals: snapshot.goals, chats, work: state.work ?? null }
  const lead = label?.trim() || 'The Lead'
  // A card of the Lead's own, built like the rail's: its title, each group's label and each row's words stand on one
  // row edge, and the dismiss and every row's trailing mark end on one right edge (ToolSection's contract).
  return <div data-slot="lead-away"><ToolSection label={leadDigestTitle(digest)}
    action={<Button variant="ghost" size="icon-sm" edge="end" edgeGlyph={13} aria-label="Dismiss" onClick={dismiss}><CrossIcon size={13} /></Button>}>
    {digest.summary && <ToolProse>{sanitizeText(digest.summary)}</ToolProse>}
    {leadDigestSections(digest).map(section => <ToolGroup key={section.kind} label={section.label} data-digest-group={section.kind}>
      <ListRows surface="panel">{section.items.map(item => {
        const found = leadDigestTarget(item.ref, desk)
        const row = { size: 'sm' as const, 'data-digest-item': item.id, title: sanitizeText(item.title), wrapTitle: true, subtitle: leadDigestLine(item, lead), wrapSubtitle: true }
        return found
          ? <ListRow key={`${item.kind}-${item.id}`} {...row} as="button" interactive aria-description={found.title} data-digest-opens={found.target.kind}
            onClick={() => openLeadRefTarget(store, found.target)} trail={found.target.kind === 'pr' ? <ExternalIcon /> : <ChevronIcon />} />
          : <ListRow key={`${item.kind}-${item.id}`} {...row} />
      })}</ListRows>
    </ToolGroup>)}
    <ToolProse variant="note"><span data-slot="lead-away-note">{leadDigestNote(digest)}</span></ToolProse>
  </ToolSection></div>
}
