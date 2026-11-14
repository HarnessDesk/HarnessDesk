import { useState, type CSSProperties, type ReactNode } from 'react'

import { Button } from '../ui/button'
import type { Tone } from '../ui/tone'
import { Chip, Dot, Text } from './Settings'
import styles from './AgentFlow.module.css'

/**
 * Sub-agents a conversation started, drawn the same way wherever they show.
 *
 * Three parts share one vocabulary: a child is a light, a name, an optional
 * role, a line of what it is doing or was asked, and its facts (model, time,
 * tokens). `AgentFlowCard` is the transcript's card with a rollup head and a
 * spine of children; `AgentLanes` is the same children against one clock, the
 * picture of who ran when and alongside whom. Neither knows a runtime: the
 * caller reads its items into these props, so Codex, Claude Code and an ACP
 * agent's children look alike.
 */

export type AgentFlowPhase = 'working' | 'done' | 'failed' | 'stopped' | 'ended'

/** A light judges how a child ended; working is the one that moves. */
export const AGENT_FLOW_TONE: Readonly<Record<AgentFlowPhase, Tone>> = {
  working: 'info',
  done: 'success',
  failed: 'danger',
  stopped: 'neutral',
  ended: 'neutral',
}

export interface AgentFlowChild {
  readonly id: string
  readonly name: string
  readonly role?: string | null
  readonly phase: AgentFlowPhase
  /** The phase in words, for the light's label and the row's title. */
  readonly phaseWord: string
  /** What it was asked, shown when the row is opened. Plain text. */
  readonly prompt?: string | null
  /** Model, elapsed time and tokens, already joined. */
  readonly facts?: string | null
  /** Opens the child's own conversation; absent where it has none. */
  readonly onOpen?: (() => void) | undefined
  readonly openTitle?: string | undefined
}

/** A light in the card's one mark column: the head's, each child's on the spine, the wait's. */
const Mark = ({ children }: { children: ReactNode }) => <span className={styles.mark}>{children}</span>

const ChildLight = ({ phase, word }: { phase: AgentFlowPhase; word: string }) => (
  <Mark><Dot tone={AGENT_FLOW_TONE[phase]} pulse={phase === 'working'} role="img" aria-label={word} /></Mark>
)

const ChildRow = ({ child }: { child: AgentFlowChild }) => {
  const [open, setOpen] = useState(false)
  const name = (
    <>
      <Text role="row" truncate>{child.name}</Text>
      {child.role && <Chip size="sm" tone="neutral">{child.role}</Chip>}
    </>
  )
  return (
    <li className={styles.child} data-slot="agent-flow-child" data-phase={child.phase}>
      <span className={styles.childLine}>
        <ChildLight phase={child.phase} word={child.phaseWord} />
        {child.prompt ? (
          <Button
            variant="row" size="content-min" bordered={false} hoverFill={false}
            className={styles.childName}
            aria-expanded={open}
            title={open ? 'Hide what it was asked' : 'Show what it was asked'}
            onClick={() => setOpen(!open)}
          >
            {name}
          </Button>
        ) : (
          <span className={styles.childName}>{name}</span>
        )}
        {child.phase !== 'working' && <Text role="meta" tone={AGENT_FLOW_TONE[child.phase]}>{child.phaseWord}</Text>}
        {child.facts && <Text role="meta" ink="muted" numeric className={styles.facts}>{child.facts}</Text>}
        {child.onOpen && (
          <Button variant="quiet" size="sm" title={child.openTitle} onClick={child.onOpen} className={styles.open}>Open</Button>
        )}
      </span>
      {open && child.prompt && <Text as="p" role="prose" ink="secondary" className={styles.prompt}>{child.prompt}</Text>}
    </li>
  )
}

/**
 * The transcript's card: one head that says how many and how they are doing,
 * then each child on a spine. `waiting` is the fan-in line — the parent is
 * waiting on its children — and goes once the wait is over.
 */
export const AgentFlowCard = ({ title, summary, facts, working, trouble, waiting, children }: {
  readonly title: string
  /** "2 working", "1 failed" — only the states that are news. */
  readonly summary: readonly string[]
  /** Elapsed and tokens across the children, already joined. */
  readonly facts?: string | null
  readonly working: boolean
  readonly trouble: boolean
  readonly waiting?: string | null
  readonly children: readonly AgentFlowChild[]
}) => (
  <section className={styles.card} data-slot="agent-flow-card" {...(working ? { 'data-working': '' } : {})}>
    <header className={styles.head}>
      <Mark><Dot tone={working ? 'info' : trouble ? 'danger' : 'success'} pulse={working} role="img" aria-label={working ? 'Working' : trouble ? 'Some failed' : 'Finished'} /></Mark>
      <Text role="row" weight="medium">{title}</Text>
      {summary.map(part => (
        <Text key={part} role="meta" ink="secondary" {...(part.endsWith(' failed') ? { tone: 'danger' as const } : {})}>· {part}</Text>
      ))}
      {facts && <Text role="meta" ink="muted" numeric className={styles.facts}>{facts}</Text>}
    </header>
    <ul className={styles.spine} data-slot="agent-flow-children">
      {children.map(child => <ChildRow key={child.id} child={child} />)}
    </ul>
    {waiting && (
      <div className={styles.waiting} data-slot="agent-flow-waiting" role="status">
        <Mark><Dot pulse role="img" aria-label="Waiting" /></Mark>
        <Text role="meta" ink="secondary">{waiting}</Text>
      </div>
    )}
  </section>
)

export interface AgentLane {
  readonly id: string
  readonly name: string
  readonly phase: AgentFlowPhase
  readonly phaseWord: string
  /** Epoch milliseconds. */
  readonly start: number
  /** Where the bar stops; for a working child, now. */
  readonly end: number
  readonly onPick?: (() => void) | undefined
  readonly pickTitle?: string | undefined
}

/**
 * Who ran when: one lane per child against a shared clock from the first
 * start to now (or the last end). A working bar reaches the right edge and
 * breathes; a finished one is its outcome's colour. Lanes are data geometry —
 * their offsets are the measured times, not a layout.
 */
export const AgentLanes = ({ lanes, from, to, startLabel, endLabel }: {
  readonly lanes: readonly AgentLane[]
  readonly from: number
  readonly to: number
  readonly startLabel: string
  readonly endLabel: string
}) => {
  const span = Math.max(1, to - from)
  const percent = (at: number): number => Math.min(100, Math.max(0, ((at - from) / span) * 100))
  return (
    <div className={styles.lanes} data-slot="agent-lanes" role="list" aria-label="Sub-agents over time">
      {lanes.map(lane => {
        const left = percent(lane.start)
        // A child that ran for less than the clock can show still gets a mark.
        const width = Math.max(1.5, percent(lane.end) - left)
        const label = <Text role="meta" ink="secondary" truncate>{lane.name}</Text>
        return (
          <div key={lane.id} role="listitem" className={styles.lane} data-slot="agent-lane" data-phase={lane.phase}>
            {lane.onPick ? (
              <Button variant="row" size="content-min" bordered={false} hoverFill={false} className={styles.laneName} title={lane.pickTitle} onClick={lane.onPick}>{label}</Button>
            ) : (
              <span className={styles.laneName}>{label}</span>
            )}
            <span className={styles.track}>
              <span
                className={styles.bar}
                data-phase={lane.phase}
                role="img"
                aria-label={`${lane.name}: ${lane.phaseWord}`}
                title={lane.phaseWord}
                style={{ '--lane-start': `${left}%`, '--lane-width': `${Math.min(width, 100 - left)}%` } as CSSProperties}
              />
            </span>
          </div>
        )
      })}
      <div className={styles.axis} aria-hidden="true">
        <Text role="meta" ink="muted" numeric>{startLabel}</Text>
        <Text role="meta" ink="muted" numeric>{endLabel}</Text>
      </div>
    </div>
  )
}
