import { isBusy, subagentsOutlastTurn, type AgentItem, type Session, type SubagentItem, type TokenUsage } from '@harnessdesk/protocol'

import { sanitizeText } from './sanitize'

/**
 * The sub-agents a conversation started, as one list of children.
 *
 * Every runtime reports delegation as `subagent` items, but each says it a
 * different way: Codex sends one item per call (a spawn, a wait that lists
 * several children, a message to one), with the children's states as of that
 * call; the ACP agents send one item per child that is replaced as the child
 * moves. Read in order, the items fold into one record per child, the latest
 * word on each winning. The transcript card, the strip over the composer, the
 * sidebar's nested rows and the Agents panel's lanes all draw this one list,
 * so a child reads the same on all four.
 */

/** Nothing below this conversation is running: its turn is over and no child outlived it. */
export const settledOf = (session: Session): boolean => !isBusy(session) && !subagentsOutlastTurn(session)

/** Where a child stands, in the words the interface uses for every runtime. */
export type ChildPhase = 'working' | 'done' | 'failed' | 'stopped' | 'ended'

export interface ChildRow {
  /** The child's own session where it has one, its handle otherwise. */
  readonly id: string
  readonly name: string
  readonly role: string | null
  readonly phase: ChildPhase
  readonly prompt: string | null
  readonly model: string | null
  readonly usage: TokenUsage | null
  /** False where the id is a handle rather than a conversation to open. */
  readonly openable: boolean
  /** Epoch milliseconds: when the call that started it, or first named it, began. */
  readonly startedAt: number | null
  /** When it was first seen finished; null while working or never timed. */
  readonly endedAt: number | null
  /** The last time any call named it — where a lane stops when the end itself went unsaid. */
  readonly lastSeenAt: number | null
  /** The order it was first seen in, for a stable list. */
  readonly order: number
}

/**
 * A runtime's own state word, read into a phase.
 *
 * Codex's (`CollabAgentStatus`): pendingInit and running are working,
 * interrupted is stopped, errored is failed, completed and shutdown are done,
 * notFound is an end we cannot name. The ACP agents use running, completed,
 * failed and stopped. An unknown word is working while the item that carried
 * it is still running, and an end we cannot name once it is not.
 */
const knownPhase = (state: string | null | undefined): ChildPhase | null => {
  switch (state) {
    case 'pendingInit':
    case 'running':
    case 'active':
    case 'started':
    case 'working':
      return 'working'
    case 'completed':
    case 'shutdown':
    case 'done':
      return 'done'
    case 'errored':
    case 'failed':
      return 'failed'
    case 'interrupted':
    case 'stopped':
    case 'cancelled':
      return 'stopped'
    case 'notFound':
      return 'ended'
    default:
      return null
  }
}

export const phaseOf = (state: string | null | undefined, itemStatus?: SubagentItem['status']): ChildPhase =>
  knownPhase(state) ?? (itemStatus === 'inProgress' ? 'working' : itemStatus === 'failed' ? 'failed' : 'ended')

export const PHASE_WORDS: Readonly<Record<ChildPhase, string>> = {
  working: 'Working',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
  ended: 'Ended',
}

/**
 * The call's own verb, said the same way for every runtime.
 *
 * Codex names its tools (`spawnAgent`, `sendInput`, `wait`, `closeAgent`…);
 * the ACP adapters already say spawn, send, wait and cancel.
 */
export type FlowAction = 'spawn' | 'send' | 'wait' | 'cancel' | 'list' | 'other'

export const actionOf = (action: string): FlowAction => {
  switch (action) {
    case 'spawn':
    case 'spawnAgent':
      return 'spawn'
    case 'send':
    case 'sendInput':
    case 'sendMessage':
    case 'followupTask':
    case 'resumeAgent':
      return 'send'
    case 'wait':
      return 'wait'
    case 'cancel':
    case 'closeAgent':
    case 'interruptAgent':
      return 'cancel'
    case 'listAgents':
      return 'list'
    default:
      return 'other'
  }
}

const isSubagent = (item: AgentItem): item is SubagentItem => item.type === 'subagent'

/** A name is one line of agent text: control characters go, and so do tabs and line breaks. */
const lineOf = (text: string): string => sanitizeText(text).replace(/\s+/g, ' ').trim()

/**
 * Folds a conversation's items into its children, first seen first.
 *
 * Items are read in the order they were made, but a call's member states are
 * as of when it returned: a long wait can report a child finished after a
 * later message to it reported it running. So a call whose time is earlier
 * than the last word already taken on a child adds only what was missing
 * (its name, role, model, tokens) and does not move its phase back. A call
 * that names a child without a state word keeps the phase already known.
 *
 * `settled` is the conversation's own word that nothing below it is running
 * any more — its turn is over and the runtime has not said a sub-agent
 * outlived it. A child whose last word was "working", said by a call that
 * has returned, then ended without a later item saying how (Codex reports a
 * child's state only on the calls that address it), and is shown as ended
 * rather than as working for ever. A child whose own item is still open is
 * left to that item.
 * `liveFrom` does the same for a child last named before that index — in an
 * earlier turn — while a later turn runs.
 */
export const childrenOf = (
  items: readonly AgentItem[],
  { settled = false, liveFrom = 0, isOpen = item => item.status === 'inProgress' }: {
    settled?: boolean
    liveFrom?: number
    /** Whether an item is still open on the runtime's word; a copy of a transcript, or a turn cut short, has none. */
    isOpen?: (item: SubagentItem) => boolean
  } = {},
): ChildRow[] => {
  const byId = new Map<string, ChildRow>()
  const lastIndex = new Map<string, number>()
  /** Children whose last word came from an item still open — the runtime's own live record of them. */
  const open = new Set<string>()
  items.forEach((item, index) => {
    if (!isSubagent(item)) return
    const at = item.startedAt ?? null
    const done = item.completedAt ?? at
    for (const member of item.members) {
      const before = byId.get(member.sessionId)
      const stale = Boolean(before && done !== null && before.lastSeenAt !== null && done < before.lastSeenAt)
      const known = knownPhase(member.state)
      const phase = stale && before ? before.phase : known ?? before?.phase ?? phaseOf(null, item.status)
      const finished = phase !== 'working'
      const model = member.model ?? item.model
      const handle = member.sessionId.slice(0, 8)
      const named = member.nickname ? lineOf(member.nickname) || null : null
      if (!stale) {
        lastIndex.set(member.sessionId, index)
        if (isOpen(item)) open.add(member.sessionId)
        else open.delete(member.sessionId)
      }
      byId.set(member.sessionId, {
        id: member.sessionId,
        // A stale call's nickname only fills a name never given (the handle
        // stands in until one is).
        name: named && !(stale && before && before.name !== handle) ? named : before?.name ?? handle,
        role: (stale ? before?.role : null) ?? (member.role ? lineOf(member.role) : before?.role ?? null),
        phase,
        // What it was asked: the spawn's prompt, kept when a later message or
        // wait addresses the same child without one.
        prompt: before?.prompt ?? (item.prompt && actionOf(item.action) === 'spawn' ? sanitizeText(item.prompt) : null),
        model: before?.model && (stale || !model) ? before.model : model ? lineOf(model) : null,
        usage: (stale ? before?.usage : null) ?? member.usage ?? before?.usage ?? (item.members.length === 1 ? item.usage ?? null : null),
        openable: member.openable !== false,
        startedAt: before?.startedAt ?? at,
        endedAt: stale && before ? before.endedAt : finished ? (before && before.phase !== 'working' ? before.endedAt : done) : null,
        lastSeenAt: stale && before ? before.lastSeenAt : done ?? before?.lastSeenAt ?? null,
        order: before?.order ?? byId.size,
      })
    }
  })
  const rows = [...byId.values()].sort((a, b) => a.order - b.order)
  // Only a child last named by a call that has itself returned is ended by
  // settling: an item still open is the runtime keeping the child's own
  // record (one item per child, replaced as it moves), and it says when the
  // child ends — a background child can outlive the turn that started it.
  return rows.map(row => (row.phase === 'working' && !open.has(row.id) && (settled || (lastIndex.get(row.id) ?? 0) < liveFrom) ? { ...row, phase: 'ended' } : row))
}

const sessionCache = new Map<string, { subs: readonly SubagentItem[]; settled: boolean; liveFrom: number; cut: number; rows: ChildRow[] }>()
const CACHED_SESSIONS = 64

/**
 * A conversation's children, folded from its sub-agent calls alone.
 *
 * A child last named in an earlier turn is ended while a later turn runs,
 * unless the runtime said sub-agents outlived the turn. The fold is kept per
 * conversation and redone only when a sub-agent call changed (the reducer
 * replaces only the items that moved), so a streaming reply does not refold
 * and resanitize every child on each delta.
 */
export const childrenOfSession = (session: Session): ChildRow[] => {
  const subs: SubagentItem[] = []
  let liveFrom = 0
  const outlast = subagentsOutlastTurn(session)
  // An item left open by a turn that was cut short (interrupted, failed, or
  // recovered after a restart) is nobody's live record any more.
  const cut = new Set<SubagentItem>()
  session.turns.forEach((turn, index) => {
    if (!outlast && index === session.turns.length - 1 && turn.status === 'inProgress') liveFrom = subs.length
    for (const item of turn.items as readonly AgentItem[]) {
      if (!isSubagent(item)) continue
      subs.push(item)
      if (turn.status === 'interrupted' || turn.status === 'failed') cut.add(item)
    }
  })
  if (subs.length === 0) return []
  const settled = settledOf(session)
  const key = `${session.runtime}\u0000${session.id}`
  const hit = sessionCache.get(key)
  if (hit && hit.settled === settled && hit.liveFrom === liveFrom && hit.cut === cut.size && hit.subs.length === subs.length && hit.subs.every((item, index) => item === subs[index])) return hit.rows
  const rows = childrenOf(subs, { settled, liveFrom, isOpen: item => item.status === 'inProgress' && !cut.has(item) })
  sessionCache.delete(key)
  sessionCache.set(key, { subs, settled, liveFrom, cut: cut.size, rows })
  if (sessionCache.size > CACHED_SESSIONS) sessionCache.delete(sessionCache.keys().next().value as string)
  return rows
}

export interface FlowRollup {
  readonly total: number
  readonly working: number
  readonly done: number
  readonly failed: number
  readonly stopped: number
  readonly ended: number
  /** Tokens across the children that report them; null where none does. */
  readonly totalTokens: number | null
  /** The earliest start; null where no child was timed. */
  readonly startedAt: number | null
  /** The latest end, or null while any child is working. */
  readonly endedAt: number | null
}

export const rollupOf = (rows: readonly ChildRow[]): FlowRollup => {
  const count = (phase: ChildPhase): number => rows.filter(row => row.phase === phase).length
  const tokens = rows.filter(row => row.usage && row.usage.totalTokens > 0)
  const starts = rows.map(row => row.startedAt).filter((at): at is number => at !== null)
  const working = count('working')
  const ends = rows.map(row => row.endedAt).filter((at): at is number => at !== null)
  return {
    total: rows.length,
    working,
    done: count('done'),
    failed: count('failed'),
    stopped: count('stopped'),
    ended: count('ended'),
    totalTokens: tokens.length > 0 ? tokens.reduce((sum, row) => sum + (row.usage?.totalTokens ?? 0), 0) : null,
    startedAt: starts.length > 0 ? Math.min(...starts) : null,
    endedAt: working > 0 || ends.length === 0 ? null : Math.max(...ends),
  }
}

/**
 * The card's one-line rollup: the count first, then only the states that are
 * news. "3 sub-agents · 2 working · 1 failed", never "· 0 stopped".
 */
export const rollupWords = (rollup: FlowRollup): string[] => {
  const parts: string[] = []
  if (rollup.working > 0) parts.push(`${rollup.working} working`)
  if (rollup.done > 0) parts.push(`${rollup.done} done`)
  if (rollup.failed > 0) parts.push(`${rollup.failed} failed`)
  if (rollup.stopped > 0) parts.push(`${rollup.stopped} stopped`)
  if (rollup.ended > 0) parts.push(`${rollup.ended} ended`)
  return parts
}

/** The members a set of calls addressed, in the order first addressed. */
export const addressedIn = (items: readonly AgentItem[]): string[] => {
  const ids: string[] = []
  for (const item of items) {
    if (!isSubagent(item)) continue
    for (const member of item.members) if (!ids.includes(member.sessionId)) ids.push(member.sessionId)
  }
  return ids
}

/**
 * A wait still open among these calls: how many children it is waiting on.
 * Null when nothing is being waited on, which is when the fan-in line goes.
 * A wait that names no child (Codex 0.160's) waits on every child still
 * working, so `working` is its count.
 */
export const openWait = (items: readonly AgentItem[], working = 1): number | null => {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index] as AgentItem
    if (!isSubagent(item) || actionOf(item.action) !== 'wait') continue
    return item.status === 'inProgress' ? Math.max(1, item.members.length > 0 ? item.members.length : working) : null
  }
  return null
}

/** Whether any of these calls started a child — the card says "Started" only then. */
export const spawnedIn = (items: readonly AgentItem[]): boolean =>
  items.some(item => isSubagent(item) && actionOf(item.action) === 'spawn')
