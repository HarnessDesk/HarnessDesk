import { useEffect, useState } from 'react'
import { LEAD_DIGEST_ITEM_LABELS, type LeadAskState, type LeadDigest, type LeadDigestItem } from '@harnessdesk/protocol'
import { Button, ListRow, ListRows, ToolBodyControls, ToolGroup, ToolProse, ToolSection } from '../design'
import { sanitizeText } from '../lib/sanitize'
import { useSnapshot, useStore } from '../state/context'
import type { LeadState } from '../state/lead'
import { ChevronIcon, CrossIcon, ExternalIcon } from './Icons'
import { leadDollars } from './LeadCards'
import { leadDigestTarget, openLeadRefTarget } from './LeadRefs'

const clock = (at: number) => new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at)
const zone = (at: number) => new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(at).find(part => part.type === 'timeZoneName')?.value ?? ''

/** How often an open window asks again, so a question that ran out of time stops offering answers. */
export const LEAD_PRESENCE_REFRESH_MS = 60_000

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

/** The rail's way back to the digest: what changed in the last day, on demand and for this window only. */
export const LeadRecap = () => {
  const store = useStore()
  return <ToolSection label="Recap"><ToolBodyControls><Button variant="outline" onClick={() => { void store.lead.readAway({ active: true, recap: true }).catch(() => {}) }}>What happened?</Button></ToolBodyControls></ToolSection>
}

/**
 * The digest the host built for this window, at the top of the Lead conversation. What the window has seen is the host's
 * record, kept per device; a dismissal is the desk's, so dismissing here clears the phone's card too. Each item the desk
 * can find opens it: the chat, the Team, the pull request or the decision card.
 */
export const LeadAway = ({ active, state, label }: { readonly active: boolean; readonly state: LeadState; readonly label?: string }) => {
  const store = useStore(), snapshot = useSnapshot()
  const ready = active && state.revision >= 0 && !state.error
  // Looking at the Lead is what marks it seen; the same read hands back the digest after a long absence.
  useEffect(() => {
    if (!ready || document.visibilityState === 'hidden') return
    void store.lead.readAway({ active: true }).catch(() => {})
  }, [store, ready, state.revision])
  useEffect(() => {
    if (!ready) return
    const read = () => { if (document.visibilityState !== 'hidden') void store.lead.readAway({ active: true }).catch(() => {}) }
    const timer = setInterval(read, LEAD_PRESENCE_REFRESH_MS)
    document.addEventListener('visibilitychange', read)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', read) }
  }, [store, ready])
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
    <ToolProse variant="note"><span data-slot="lead-away-note">{digest.more > 0 ? `${digest.more} more not shown · ` : ''}{leadDollars(digest.spentUsdMicros)} spent{digest.kind === 'away' ? ' while away' : ''}</span></ToolProse>
  </ToolSection></div>
}
