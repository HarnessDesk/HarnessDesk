import type { ReactNode } from 'react'

import styles from './Panel.module.css'

/**
 * The right-hand panel's chrome, and what a row in it is.
 *
 * Every tab is the same pane: a tab strip that never changes shape, one
 * filter row, a body of rows, one footer. That is not tidiness for its own
 * sake — it is what lets someone who learned the panel on Changes already
 * know it on Activity.
 *
 * A row is a sentence about something that happened, never a tool
 * identifier. The wire name for a step belongs where you would write a rule
 * against it — the step itself, and the Permissions page — and nowhere else.
 */

const cx = (...parts: readonly (string | false | undefined)[]): string =>
  parts.filter(Boolean).join(' ')

/** A count on the left, a fact about the whole list on the right. */
export const GroupLine = ({ left, right }: { left: ReactNode; right?: ReactNode }) => (
  <div className={styles.groupLine}>
    {left}
    <span className={styles.space} />
    {right}
  </div>
)

export const DayLabel = ({ children }: { children: ReactNode }) => (
  <div className={styles.dayLabel}>{children}</div>
)

export const PanelEmpty = ({ children }: { children: ReactNode }) => (
  <p className={styles.empty}>{children}</p>
)

export const PanelRow = ({
  mark,
  title,
  sub,
  ask,
  meta,
  trail,
  subPath,
  tall,
  selected,
  tooltip,
  onClick,
}: {
  mark?: ReactNode
  title: ReactNode
  /** One quiet line under the title — a status, a role, who did it. */
  sub?: ReactNode
  /** What a sub-agent was asked, over at most two lines. */
  ask?: ReactNode
  /** The measured facts: how long, how many tokens. */
  meta?: ReactNode
  /** Anything that belongs at the end of the line — counts, a time. */
  trail?: ReactNode
  /** The sub line is a path: cut its head rather than its tail, the way a path reads. */
  subPath?: boolean
  tall?: boolean
  selected?: boolean
  /** The tooltip, when the row's own text is truncated. */
  tooltip?: string
  onClick?: () => void
}) => {
  const inner = (
    <>
      {mark ? <span className={styles.rowMark}>{mark}</span> : null}
      <span className={styles.rowText}>
        <span className={styles.rowTitle}>{title}</span>
        {sub ? <span className={cx(styles.rowSub, subPath && styles.rowSubPath)}>{sub}</span> : null}
        {ask ? <span className={styles.rowAsk}>{ask}</span> : null}
        {meta ? <span className={styles.rowMeta}>{meta}</span> : null}
      </span>
      {trail}
    </>
  )
  const attrs = {
    className: styles.row,
    ...(tall || ask || meta ? { 'data-tall': '' } : {}),
    ...(selected ? { 'data-selected': '' } : {}),
    ...(tooltip ? { title: tooltip } : {}),
  }
  return onClick ? (
    <button type="button" {...attrs} onClick={onClick}>
      {inner}
    </button>
  ) : (
    <div {...attrs}>{inner}</div>
  )
}

/** How many lines a change added and removed, in the two colours. */
export const Counts = ({ added, removed }: { added: number; removed: number }) => (
  <span className={styles.counts}>
    <span className={styles.add}>+{added}</span>
    <span className={styles.del}>−{removed}</span>
  </span>
)

export const RowTime = ({ children }: { children: ReactNode }) => (
  <span className={styles.rowTime}>{children}</span>
)

export const RunDot = () => <span className={styles.runDot} />

export { styles as panel }
