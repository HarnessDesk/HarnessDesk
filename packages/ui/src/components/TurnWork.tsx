import { useEffect, useState } from 'react'

import type { AgentItem, Turn } from '@harnessdesk/protocol'

import { groupItems, isSilentReasoning } from '../lib/group-items'
import { describeTurnWork, liveActivity } from '../lib/turn-view'
import { ChevronIcon } from './Icons'
import { ItemView } from './Items'
import { StepGroup } from './StepGroup'
import styles from './TurnWork.module.css'

/**
 * The work a turn did, under one line that says how long it took.
 *
 * While the agent runs: "Working for 12s", ticking, with the narration and
 * steps below and the current step as a faint line that shimmers. When it
 * finishes, one of two postures, decided by what the steps are:
 *
 * - **Templated steps fold.** A Codex turn's steps are "Ran a command" and
 *   "Read files" — labels the app derived, carrying nothing a count does not.
 *   It folds to "Worked for 1m 14s · read 6 files, ran 2 commands ›" so what
 *   stays on screen is the answer, the way Codex's own app folds it.
 * - **Described steps stand.** A Claude Code turn's shell calls each carry
 *   the sentence the agent wrote for them — "Find every caller of take" —
 *   and those sentences *are* the record of a research turn. They stay in
 *   the flow, one line each, the way Claude's own app keeps them; the fold
 *   is still there to close by hand, and closed it reads the sentences back
 *   as its receipt rather than a tally.
 *
 * Folding by information rather than by count is the whole rule. Opening or
 * closing is remembered for as long as the transcript is mounted; a fresh
 * read starts in the posture the steps earn.
 *
 * The exception is trouble. A turn that failed, was interrupted, or that had a
 * step declined or fail keeps its work open and tints the line — folding a
 * blocked command away behind a duration is how a UI ends up looking calm
 * about something the user needed to see.
 */

/** A clock that only ticks while something is running. */
const useNow = (running: boolean): number => {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running])
  return now
}

export const TurnWork = ({
  turn,
  work,
  root,
  streamingItemId,
}: {
  turn: Turn
  work: readonly AgentItem[]
  root: string
  /** The item currently streaming text, if any, so its caret shows. */
  streamingItemId?: string | null
}) => {
  const running = turn.status === 'inProgress'
  const now = useNow(running)
  const [choice, setChoice] = useState<boolean | null>(null)
  const line = describeTurnWork(turn, work, now)
  const open = choice ?? (running || line.trouble || line.informative)

  if (work.length === 0 && !running) return null

  const activity = running ? liveActivity(work) : null
  // The live line already says "Thinking"; the quiet line under it would say
  // it twice. Once the turn ends the record keeps the thought.
  const shown =
    running && work.length > 0 && isSilentReasoning(work[work.length - 1] as AgentItem)
      ? work.slice(0, -1)
      : work

  return (
    <section
      className={styles.work}
      data-testid="turn-work"
      {...(running ? { 'data-running': '' } : {})}
      {...(line.trouble ? { 'data-trouble': '' } : {})}
      {...(line.informative ? { 'data-described': '' } : {})}
    >
      <button
        type="button"
        className={styles.head}
        aria-expanded={open}
        onClick={() => setChoice(!open)}
        title={open ? 'Fold the work away' : 'Show what the agent did'}
      >
        <span className={styles.headLabel}>{line.head}</span>
        {/* The receipt stands in for the rows, so it shows when they do not:
            open, the sentences are the rows themselves, and a line repeating
            them above is the same story told twice. */}
        {!open && line.receipt.length > 0 && <span className={styles.headReceipt}>· {line.receipt}</span>}
        <ChevronIcon className={styles.chevron} size={13} {...(open ? { 'data-open': '' } : {})} />
        <span className={styles.rule} />
      </button>
      {open && (
        <div className={styles.body} data-register="light">
          {groupItems(shown).map((node) =>
            node.kind === 'group' ? (
              <StepGroup key={node.id} items={node.items} running={node.running} root={root} />
            ) : (
              <ItemView
                key={node.item.id}
                item={node.item}
                root={root}
                streaming={streamingItemId === node.item.id}
              />
            ),
          )}
          {/* The live line: what is happening this second, in the register of
              a status rather than a record — faint, and moving. */}
          {running && activity && (
            <div className={styles.live} role="status" aria-live="polite">
              <span className={styles.shimmer}>{activity}</span>
            </div>
          )}
        </div>
      )}
      {!open && running && activity && (
        <div className={styles.live} role="status" aria-live="polite">
          <span className={styles.shimmer}>{activity}</span>
        </div>
      )}
    </section>
  )
}
