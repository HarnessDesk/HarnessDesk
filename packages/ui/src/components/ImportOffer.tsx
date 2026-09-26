import { useEffect, useState } from 'react'

import type { ImportableConfig } from '@harnessdesk/protocol'

import { useRuntime, useSnapshot, useStore } from '../state/context'
import type { NoticeMessage } from '../design'
import { useShell } from '../panels/views'
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

/**
 * The offer to import what the other agents on this machine already have, as
 * a message for whichever surface the person keeps it on. Detection runs only
 * once the host has said the offer was not already answered, and stops if it
 * is answered while a detection is in flight.
 */
export const useImportOffer = (): { readonly message: NoticeMessage; readonly dismiss: () => void } | null => {
  const store = useStore()
  const shell = useShell()
  const snapshot = useSnapshot()
  const runtime = useRuntime()
  const [items, setItems] = useState<readonly ImportableConfig[]>([])
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
  return {
    message: {
      id: OFFER.key,
      title: 'Skills and servers to share',
      body: `Your other agents have ${whatWasFound(items)} this machine could use. Nothing is copied until you confirm it.`,
      action: {
        label: 'Review in Library',
        onSelect: () => {
          // Following the signpost answers the question: the Library is where
          // imports live from here on, so the offer never returns.
          dismiss()
          shell.reviewImports()
        },
      },
    },
    dismiss,
  }
}
