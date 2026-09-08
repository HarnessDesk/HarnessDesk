import type { AgentEvent } from './events.js'
import type { ItemId, TurnId } from './ids.js'
import type { AgentItem, FileChange, ItemDelta } from './items.js'
import type { Session, Turn } from './session.js'

/**
 * Folding the event stream back into a `Session`.
 *
 * Both the host (which keeps authoritative session state and replays it to late
 * joiners) and the renderer (which paints from it) need this fold. One
 * implementation, tested once, keeps them from drifting apart.
 *
 * The reducer is total: an event for an unknown session or turn is ignored
 * rather than throwing, because a client may legitimately observe a stream that
 * began before it connected.
 */

const appendText = (existing: readonly string[], index: number, text: string): string[] => {
  const next = existing.slice()
  while (next.length <= index) next.push('')
  next[index] = (next[index] ?? '') + text
  return next
}

/** Applies one delta to an item, returning a new item (or the original if inapplicable). */
export const applyDelta = (item: AgentItem, delta: ItemDelta): AgentItem => {
  switch (delta.kind) {
    case 'assistantText':
      return item.type === 'assistantMessage' ? { ...item, text: item.text + delta.text } : item

    case 'reasoningSummary':
      return item.type === 'reasoning'
        ? { ...item, summary: appendText(item.summary, delta.index, delta.text) }
        : item

    case 'reasoningSummaryPart':
      if (item.type !== 'reasoning') return item
      return item.summary.length > delta.index
        ? item
        : { ...item, summary: appendText(item.summary, delta.index, '') }

    case 'reasoningText':
      return item.type === 'reasoning'
        ? { ...item, content: appendText(item.content, delta.index, delta.text) }
        : item

    case 'commandOutput':
      return item.type === 'command'
        ? { ...item, output: (item.output ?? '') + delta.chunk }
        : item

    case 'planText':
      return item.type === 'plan' ? { ...item, text: item.text + delta.text } : item

    case 'fileChangePatch': {
      if (item.type !== 'fileChange') return item
      // Patch updates replace by path so a file revised twice in one turn shows
      // its latest diff rather than two competing cards.
      const byPath = new Map<string, FileChange>()
      for (const change of item.changes) byPath.set(change.path, change)
      for (const change of delta.changes) byPath.set(change.path, change)
      return { ...item, changes: [...byPath.values()] }
    }

    case 'toolProgress':
      return item
  }
}

const replaceItem = (items: readonly AgentItem[], next: AgentItem): AgentItem[] => {
  const index = items.findIndex((item) => item.id === next.id)
  if (index === -1) return [...items, next]
  const copy = items.slice()
  const previous = items[index] as AgentItem
  // A completion carries the item's final shape but not always when it
  // began; the start is known from the earlier event and stays.
  copy[index] =
    next.startedAt === undefined && previous.startedAt !== undefined
      ? ({ ...next, startedAt: previous.startedAt } as AgentItem)
      : next
  return copy
}

const mapTurn = (
  session: Session,
  id: TurnId,
  update: (turn: Turn) => Turn,
): Session => {
  const index = session.turns.findIndex((turn) => turn.id === id)
  if (index === -1) return session
  const turns = session.turns.slice()
  turns[index] = update(turns[index] as Turn)
  return { ...session, turns }
}

const mapItem = (
  session: Session,
  turnIdValue: TurnId,
  itemIdValue: ItemId,
  update: (item: AgentItem) => AgentItem,
): Session =>
  mapTurn(session, turnIdValue, (turn) => {
    const index = turn.items.findIndex((item) => item.id === itemIdValue)
    if (index === -1) return turn
    const items = turn.items.slice()
    items[index] = update(items[index] as AgentItem)
    return { ...turn, items }
  })

/**
 * Applies one event to a session. Returns the same reference when the event does
 * not concern this session, which lets callers use identity to skip re-renders.
 */
export const reduceSession = (session: Session, event: AgentEvent): Session => {
  switch (event.type) {
    case 'session/started':
      return event.session.id === session.id ? event.session : session

    case 'session/status':
      return event.sessionId === session.id ? { ...session, status: event.status } : session

    case 'session/title':
      return event.sessionId === session.id ? { ...session, title: event.title } : session

    case 'session/goal':
      return event.sessionId === session.id ? { ...session, goal: event.goal } : session

    case 'session/settings':
      return event.sessionId === session.id ? { ...session, settings: event.settings } : session

    case 'turn/started': {
      if (event.sessionId !== session.id) return session
      const exists = session.turns.some((turn) => turn.id === event.turn.id)
      return exists
        ? mapTurn(session, event.turn.id, (turn) => ({ ...turn, ...event.turn, items: turn.items }))
        : { ...session, turns: [...session.turns, event.turn] }
    }

    case 'turn/completed': {
      if (event.sessionId !== session.id) return session
      // The completed turn carries authoritative status and timing, but the
      // streamed items are richer than the summary the runtime sends back.
      return mapTurn(session, event.turn.id, (turn) => ({
        ...turn,
        ...event.turn,
        items: event.turn.items.length > turn.items.length ? event.turn.items : turn.items,
      }))
    }

    case 'turn/diff':
      return event.sessionId === session.id
        ? mapTurn(session, event.turnId, (turn) => ({ ...turn, diff: event.diff }))
        : session

    case 'turn/plan':
      return event.sessionId === session.id
        ? mapTurn(session, event.turnId, (turn) => ({ ...turn, plan: event.steps }))
        : session

    case 'item/started':
    case 'item/completed':
      return event.sessionId === session.id
        ? mapTurn(session, event.turnId, (turn) => ({
            ...turn,
            items: replaceItem(turn.items, event.item),
          }))
        : session

    case 'item/delta':
      return event.sessionId === session.id
        ? mapItem(session, event.turnId, event.itemId, (item) => applyDelta(item, event.delta))
        : session

    case 'usage/updated':
      return event.sessionId === session.id ? { ...session, usage: event.usage } : session

    case 'session/closed':
      return event.sessionId === session.id
        ? { ...session, status: { type: 'idle' } }
        : session

    case 'session/options':
      return event.sessionId === session.id ? { ...session, options: event.options } : session

    case 'session/memory':
      return event.sessionId === session.id ? { ...session, memory: event.enabled } : session

    // The queue is the host's own state, not the session's: it travels beside
    // a `Session` rather than inside one, so a runtime re-emitting a whole
    // session cannot wipe what the user has waiting. Background tasks sit
    // beside it for the same reason, and because they outlive the turns the
    // session is made of.
    case 'session/queue':
    case 'session/tasks':
    case 'approval/requested':
    case 'approval/resolved':
    case 'limits/updated':
    case 'runtime/options':
    case 'catalog/changed':
    case 'account/loginCompleted':
    case 'account/changed':
    case 'notice':
    case 'error':
      return session
  }
}

/**
 * Folds a fresh read of a session into the one already held.
 *
 * A read comes from the agent's own store, and the store is behind whoever
 * watched the events: it cannot know the turn that is running right now, and
 * its copy of a turn we did watch is poorer than the one we folded item by
 * item — Codex says so itself, "we explicitly do not persist all agent
 * interactions". So a read brings the session's own fields and any turn we
 * have not seen, and is never allowed to take anything away. Without this,
 * leaving a working conversation and coming back to it read the store over
 * the live transcript and the turn in flight disappeared, deltas included.
 *
 * `keep` decides which of the held turns survive a read that omits them. The
 * default keeps a turn still in progress, the one case where the store cannot
 * possibly be right yet; the host passes its own rule, because it knows which
 * turns it watched start.
 */
export const mergeRead = (
  held: Session,
  read: Session,
  keep: (turn: Turn) => boolean = (turn) => turn.status === 'inProgress',
): Session => {
  if (held.id !== read.id || held.runtime !== read.runtime) return read
  /**
   * Tokens are reported by the runtime and never re-derived here, so a read
   * that carries none is *silent* about them — it is not saying there are
   * none. Keeping what we already heard is what stops the context ring going
   * out for the rest of a conversation the moment its agent re-registers
   * under us, after a crash or an upgrade.
   */
  const keepUsage = (merged: Session): Session =>
    merged.usage || !held.usage ? merged : { ...merged, usage: held.usage }
  // A summary-shaped read — a history row, a resume's metadata — knows nothing
  // about items and must never be mistaken for an empty transcript.
  if (!read.itemsLoaded) {
    return keepUsage(held.itemsLoaded ? { ...read, turns: held.turns, itemsLoaded: true } : read)
  }
  const ours = new Map(held.turns.map((turn) => [turn.id, turn]))
  const readIds = new Set(read.turns.map((turn) => turn.id))
  const turns = read.turns.map((turn) => {
    const mine = ours.get(turn.id)
    if (!mine) return turn
    // The read is authoritative about how the turn ended and how long it took;
    // the items are ours when we saw more of them than it did. A diff or a
    // plan the read has no opinion on is ours whatever the item counts say:
    // both are turn *metadata*, not items, and an agent that reports a plan
    // over the wire and stores none — every ACP agent — has a read that is
    // silent about it rather than one that says there is none. Gating that
    // carry-over on winning the item count is what emptied the Tasks panel
    // the moment a conversation was reopened.
    const diff = turn.diff ?? mine.diff
    const plan = turn.plan ?? mine.plan
    const items = mine.items.length > turn.items.length ? mine.items : turn.items
    if (items === turn.items && diff === turn.diff && plan === turn.plan) return turn
    return {
      ...turn,
      items,
      ...(diff === undefined ? {} : { diff }),
      ...(plan === undefined ? {} : { plan }),
    }
  })
  // Ours that the read has not caught up with, in the order we hold them —
  // the turn in flight is the last of them, which is where it belongs.
  const missing = held.turns.filter((turn) => !readIds.has(turn.id) && keep(turn))
  return keepUsage({ ...read, turns: [...turns, ...missing] })
}

/** Convenience fold for replaying a recorded stream. */
export const reduceAll = (session: Session, events: Iterable<AgentEvent>): Session => {
  let current = session
  for (const event of events) current = reduceSession(current, event)
  return current
}

/** The most recent turn, which is what the composer and interrupt button act on. */
export const currentTurn = (session: Session): Turn | undefined =>
  session.turns.length > 0 ? session.turns[session.turns.length - 1] : undefined

export const isBusy = (session: Session): boolean =>
  session.status.type === 'active' || currentTurn(session)?.status === 'inProgress'

/** Flattened transcript across every turn, in order — what the chat view renders. */
export const allItems = (session: Session): AgentItem[] =>
  session.turns.flatMap((turn) => turn.items as AgentItem[])
