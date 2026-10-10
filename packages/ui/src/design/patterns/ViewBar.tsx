import type { HTMLAttributes, ReactNode } from 'react'

import styles from './ViewBar.module.css'

/**
 * A view's own row, under the window bar: what the view shows, and what can
 * be done to it.
 *
 * It never repeats the title. The window bar's selected tab already says
 * which view this is, so the row opens with the view's summary — "12 open ·
 * 8 blocking", "0 to do · 1 working" — in the secondary ink, and ends with
 * the view's verbs at their own width and its switch (All | Open, Board |
 * List). Its edge is the page's gutter on both sides, the same edge the
 * window bar's title and the page's blocks start on; a Findings or Board row
 * that drew its own icon and name at the dense inset sat 16px off both, and
 * said "Findings" under a tab that already said it. A table's summary uses
 * `contentInset="reading-table"` to line up with its first cell's text.
 */
export const ViewBar = ({ summary, actions, contentInset = 'page', ...props }: Omit<HTMLAttributes<HTMLElement>, 'className' | 'style' | 'title'> & {
  /** A framed table's first cell text includes its table edge inside the page gutter. */
  readonly contentInset?: 'page' | 'reading-table'
  /** What the view shows, as facts: counts and states, never its name. */
  readonly summary?: ReactNode
  /** The view's verbs, then its switch. */
  readonly actions?: ReactNode
}) => (
  <header data-slot="view-bar" data-content-inset={contentInset} className={styles.bar} {...props}>
    <div className={styles.summary}>{summary}</div>
    {actions != null && <div className={styles.actions}>{actions}</div>}
  </header>
)
