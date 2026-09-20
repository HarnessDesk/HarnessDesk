import { useEffect } from 'react'

import type { AgentEntry, Session } from '@harnessdesk/protocol'

import { seatAgentKey, wordOf } from '../lib/agents'
import { useSnapshot, useStore } from './context'

/** The Agent a conversation was seated as. */
export interface SeatAgent {
  /** Its id, as the host recorded it at seating. */
  readonly id: string
  /** Its entry, read for the conversation's folder: undefined while being read, null when no Agent by that id is there now. */
  readonly entry: AgentEntry | null | undefined
  /** What to call it — null while it is being read, so nothing flashes a guess and then changes. */
  readonly name: string | null
}

/**
 * The Agent a conversation was seated as, or null for one that was not —
 * which, until phase 4 makes the host's record durable, is also every
 * conversation after the app restarts.
 *
 * A plain conversation (`session.settings.agent` absent) reads nothing and
 * asks the store for nothing: the whole hook is a no-op before its first
 * `if`, so a person who never touches Agents pays for none of this.
 */
export const useSeatAgent = (session: Session | null | undefined): SeatAgent | null => {
  const store = useStore()
  const snapshot = useSnapshot()
  const id = session?.settings?.agent ?? null
  const cwd = session?.cwd ?? null
  const key = id && cwd ? seatAgentKey(cwd, id) : null
  const known = key !== null && snapshot.seatAgents.has(key)
  useEffect(() => {
    if (id && cwd && !known) store.readSeatAgent(cwd, id)
  }, [store, id, cwd, known])
  if (!id || !key) return null
  const entry = snapshot.seatAgents.get(key)
  return { id, entry, name: entry === undefined ? null : (entry?.definition?.name ?? wordOf(id)) }
}
