import { useContext, useEffect, useMemo, useState } from 'react'

import { allItems, type AgentItem, type Session, type SessionId } from '@harnessdesk/protocol'

import { formatTokens, formatTokensWithFloor } from '../lib/context-usage'
import {
  addressedIn,
  childrenOf,
  childrenOfSession,
  openWait,
  PHASE_WORDS,
  rollupOf,
  rollupWords,
  spawnedIn,
  type ChildRow,
} from '../lib/subagent-flow'
import { formatElapsed } from '../lib/turn-view'
import { useActiveSession, useStore } from '../state/context'
import { AgentFlowCard, AgentLanes, ComposerNotice, type AgentFlowChild, type AgentLane } from '../design'
import { ReadOnlyTranscriptContext } from '../lib/read-only-transcript'

/**
 * The screen side of the sub-agent view: reads a conversation's items into
 * the shared child rows (`lib/subagent-flow`) and hands them to the design
 * system's card and lanes. Four places draw the same rows — the transcript's
 * card, the strip over the composer, the sidebar's nested rows and the Agents
 * panel's lanes — so a child reads the same wherever it is met.
 */

export const useChildren = (session: Session | null): ChildRow[] =>
  useMemo(() => (session ? childrenOfSession(session) : []), [session])

/** A clock that ticks once a second while something on screen is working, and not otherwise. */
export const useNow = (live: boolean): number => {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [live])
  return now
}

const elapsedOf = (row: ChildRow, now: number): string | null => {
  if (row.startedAt === null) return null
  const end = row.endedAt ?? (row.phase === 'working' ? now : row.lastSeenAt)
  return end === null ? null : formatElapsed(end - row.startedAt)
}

/** Model, time and tokens: the three facts that make a child more than a tool row. */
export const childFacts = (row: ChildRow, now: number): string =>
  [row.model, elapsedOf(row, now), row.usage && row.usage.totalTokens > 0 ? `${formatTokensWithFloor(row.usage)} tokens` : null]
    .filter(Boolean)
    .join(' · ')

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`

/**
 * The transcript's card for one stretch of sub-agent calls. It reads the
 * whole conversation for each child's latest word, so a card drawn at the
 * spawn keeps up with the waits and messages that follow it.
 */
export const SubagentCard = ({ items }: { items: readonly AgentItem[] }) => {
  const store = useStore()
  const readOnly = useContext(ReadOnlyTranscriptContext)
  const session = useActiveSession()
  // The card may be drawn outside its own conversation (a read-only copy);
  // then the calls it was handed are all there is to read.
  const own = Boolean(session && items[0] && allItems(session).some(item => item.id === items[0]?.id))
  const everyone = useChildren(own ? session : null)
  const rows = useMemo(() => {
    const ids = addressedIn(items)
    const source = own ? everyone : childrenOf(items, { settled: true, isOpen: () => false })
    return ids.map(id => source.find(row => row.id === id)).filter((row): row is ChildRow => row !== undefined)
  }, [items, own, everyone])
  const rollup = rollupOf(rows)
  const now = useNow(rollup.working > 0)
  if (rows.length === 0) return null

  const title = spawnedIn(items)
    ? rows.length === 1 ? 'Started a sub-agent' : `Started ${rows.length} sub-agents`
    : rows.length === 1 ? 'Worked with a sub-agent' : `Worked with ${rows.length} sub-agents`
  const span = rollup.startedAt === null ? null : formatElapsed((rollup.endedAt ?? now) - rollup.startedAt)
  const waiting = openWait(items, rollup.working)
  const children: AgentFlowChild[] = rows.map(row => ({
    id: row.id,
    name: row.name,
    role: row.role,
    phase: row.phase,
    phaseWord: PHASE_WORDS[row.phase],
    prompt: row.prompt,
    facts: childFacts(row, now),
    ...(row.openable && !readOnly && session
      ? {
          // A sub-agent runs under the agent that started it, so this
          // conversation's runtime is the one that can read it.
          onOpen: () => void store.openSession(row.id as SessionId, { runtime: session.runtime }),
          openTitle: `Open ${row.name}'s conversation`,
        }
      : {}),
  }))

  return (
    <AgentFlowCard
      title={title}
      summary={rollupWords(rollup)}
      facts={[span, rollup.totalTokens !== null ? `${formatTokens(rollup.totalTokens)} tokens` : null].filter(Boolean).join(' · ')}
      working={rollup.working > 0}
      trouble={rollup.failed > 0}
      waiting={waiting === null ? null : `Waiting for ${plural(waiting, 'agent')}`}
      children={children}
    />
  )
}

/**
 * The line over the composer while children work: how many, and who. It is
 * there for the moment the card has scrolled away — and for the children that
 * outlive the turn, when the conversation looks idle and is not.
 */
export const SubagentStrip = () => {
  const store = useStore()
  const session = useActiveSession()
  const working = useChildren(session).filter(row => row.phase === 'working')
  if (working.length === 0) return null
  const names = working.slice(0, 3).map(row => row.name)
  const more = working.length - names.length
  return (
    <ComposerNotice
      message={{
        id: 'subagents-working',
        tone: 'info',
        title: `${plural(working.length, 'sub-agent')} working.`,
        body: more > 0 ? `${names.join(', ')} and ${more} more` : names.join(', '),
        action: { label: 'Show', onSelect: () => store.openDetailsTab('agents') },
      }}
    />
  )
}

/**
 * Who ran when, for the Agents panel: a lane per child on one clock, from the
 * first start to now while any works, or to the last end once all are done.
 */
export const SubagentLanes = ({ onPick }: { onPick?: (row: ChildRow) => void }) => {
  const session = useActiveSession()
  const rows = useChildren(session).filter(row => row.startedAt !== null)
  const working = rows.some(row => row.phase === 'working')
  const now = useNow(working)
  if (rows.length < 2) return null
  const from = Math.min(...rows.map(row => row.startedAt as number))
  const endOf = (row: ChildRow): number => row.endedAt ?? (row.phase === 'working' ? now : row.lastSeenAt ?? row.startedAt as number)
  const to = working ? now : Math.max(...rows.map(endOf))
  const lanes: AgentLane[] = rows.map(row => ({
    id: row.id,
    name: row.name,
    phase: row.phase,
    phaseWord: `${PHASE_WORDS[row.phase]}${elapsedOf(row, now) ? ` · ${elapsedOf(row, now)}` : ''}`,
    start: row.startedAt as number,
    end: endOf(row),
    ...(onPick && row.openable ? { onPick: () => onPick(row), pickTitle: `Open ${row.name}'s conversation` } : {}),
  }))
  return <AgentLanes lanes={lanes} from={from} to={to} startLabel="0s" endLabel={working ? `${formatElapsed(to - from)} · now` : formatElapsed(to - from)} />
}
