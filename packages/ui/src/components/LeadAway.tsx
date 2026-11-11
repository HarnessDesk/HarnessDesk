import { useEffect, useState } from 'react'
import { LEAD_DIGEST_ITEM_LABELS, type LeadAskState, type LeadDigest } from '@harnessdesk/protocol'
import { Banner, Button, ListRow, ListRows, SectionHead, Text, ToolBodyControls, ToolSection } from '../design'
import { sanitizeText } from '../lib/sanitize'
import { useStore } from '../state/context'
import type { LeadState } from '../state/lead'
import { leadDollars } from './LeadCards'

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
 * record, kept per device: dismissing here leaves the phone's card in place.
 */
export const LeadAway = ({ active, state }: { readonly active: boolean; readonly state: LeadState; readonly label?: string }) => {
  const store = useStore()
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
  return <div data-slot="lead-away"><Banner title={leadDigestTitle(digest)} onDismiss={dismiss}>
    {digest.summary && <Text as="p" role="prose">{sanitizeText(digest.summary)}</Text>}
    {leadDigestSections(digest).map(section => <section key={section.kind} aria-label={section.label} data-digest-group={section.kind}>
      <SectionHead level="label" name={section.label} />
      <ListRows>{section.items.map(item => <ListRow key={`${item.kind}-${item.id}`} size="sm" data-digest-item={item.id} title={sanitizeText(item.title)} wrapTitle
        subtitle={item.fact ? sanitizeText(item.fact) : undefined} wrapSubtitle />)}</ListRows>
    </section>)}
    <Text role="muted" data-slot="lead-away-note">{digest.more > 0 ? `${digest.more} more not shown · ` : ''}{leadDollars(digest.spentUsdMicros)} spent{digest.kind === 'away' ? ' while away' : ''}</Text>
  </Banner></div>
}
