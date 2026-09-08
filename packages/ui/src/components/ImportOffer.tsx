import { useEffect, useState } from 'react'

import type { ImportableConfig } from '@harnessdesk/protocol'

import { useRuntime, useSnapshot, useStore } from '../state/context'
import { Banner, BannerAction } from '../design/primitives/Banner'
import { ImportIcon } from './Icons'
import { isSilenced, type NoticeIdentity } from '../lib/notice-policy'

/**
 * The first-run pointer to the Library.
 *
 * The runtime's detection is still the trigger — it knows how to spot the
 * other agents' configuration on this machine — but the *action* is no
 * longer its one-shot migration. That button applied everything it detected
 * with no preview, no per-item outcome and no way back, which is exactly the
 * write this app promises never to make. What it offered is what Settings ›
 * Library now does properly: every skill and server, which agents can load
 * each one, and imports that are previewed as diffs, applied per item, and
 * recorded with their backups. So the banner has become a signpost, and
 * following it answers it.
 *
 * *Once* means once, not once per agent. This used to keep a flag per
 * runtime, so "no thanks" had to be said again for every agent on the roster
 * and again for each one registered later — four agents, four refusals of
 * one question. It is a `once` notice now, which is the lifetime that
 * answers a question for good and puts the way back on the Notifications
 * page rather than in a `localStorage` key nobody can see.
 *
 * What it found goes under the title rather than inside it, and by *kind*,
 * never by the detector's own label — those labels carry full absolute paths
 * (four lines of `/private/tmp/...` in one live run), and a banner that
 * cannot be read in a glance is a banner that gets dismissed unread. The
 * Library shows the paths; the banner only has to say what sort of thing is
 * waiting there.
 */
const OFFER: NoticeIdentity = { key: 'import:offer', kind: 'import:offer', lifetime: 'once' }

// The kinds the Library actually knows how to import. Detection reports more
// (agent instructions, hooks, subagents, commands), but the banner routes to a
// page that can only carry these two — advertising the rest would land the
// person on "Nothing to import".
const IMPORTABLE = new Set(['SKILLS', 'MCP_SERVER_CONFIG'])

const KIND_NOUN: Readonly<Record<string, string>> = {
  SKILLS: 'skills',
  MCP_SERVER_CONFIG: 'MCP servers',
}

const kindNoun = (kind: string): string =>
  KIND_NOUN[kind] ?? kind.toLowerCase().replace(/_/g, ' ')

/** "skills", "skills and MCP servers", "skills, MCP servers and more". */
const whatWasFound = (items: readonly ImportableConfig[]): string => {
  const nouns = [...new Set(items.map((item) => kindNoun(item.kind)))]
  if (nouns.length === 1) return nouns[0] ?? ''
  return `${nouns.slice(0, -1).join(', ')} and ${nouns[nouns.length - 1] ?? ''}`
}

export const ImportOffer = ({ onReview }: { onReview: () => void }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const runtime = useRuntime()
  const [items, setItems] = useState<readonly ImportableConfig[]>([])
  // Both halves of the guard, in one value the effect can depend on: the offer
  // must not be detected before the host has said whether it was refused, and
  // must not survive being refused while a detection was already in flight.
  const answered = !snapshot.preferencesLoaded || isSilenced(snapshot.noticePolicy, OFFER)

  useEffect(() => {
    if (!runtime.capabilities.extensionStore) return
    if (answered) {
      setItems([])
      return
    }
    let cancelled = false
    void store.detectImports().then((found) => {
      if (!cancelled) setItems(found.filter((item) => IMPORTABLE.has(item.kind)))
    })
    return () => {
      cancelled = true
    }
  }, [store, runtime.capabilities.extensionStore, answered])

  if (items.length === 0 || answered) return null

  const dismiss = (): void => {
    store.dismissStanding(OFFER)
    setItems([])
  }

  return (
    <Banner
      icon={<ImportIcon size={17} />}
      title="Your other agents have skills and servers this machine could share"
      onDismiss={dismiss}
      actions={
        <>
          <BannerAction variant="secondary" onClick={dismiss}>
            Not now
          </BannerAction>
          <BannerAction
            onClick={() => {
              // Following the signpost answers the question: the Library is
              // where imports live from here on, so the banner never returns.
              dismiss()
              onReview()
            }}
          >
            Review in Library
          </BannerAction>
        </>
      }
    >
      It found {whatWasFound(items)} — every import is previewed, and nothing is copied until you
      confirm it.
    </Banner>
  )
}
