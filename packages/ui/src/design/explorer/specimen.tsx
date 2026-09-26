import type { ReactNode } from 'react'

import { Card } from '..'
import styles from './explorer.module.css'

/**
 * One example, framed.
 *
 * A board used to set its mock page straight on the page's own ground: no
 * edge, no ground of its own, nothing saying where the catalogue's prose
 * stopped and the example started — a page title, a line of prose, and then
 * a settings page's furniture just kept going underneath it. A catalogue
 * frames a specimen instead: a small caption naming what it is, then the
 * thing itself on a plate of its own.
 *
 * The plate is `Card variant="plate"` — the same surface a card in the app
 * stands on — so a board's mock screen is drawn on a ground that reads as
 * "this is the example," not as more of the page. What is inside the frame
 * is exactly what the board already rendered; this component only supplies
 * the frame and the caption around it.
 */
export const Specimen = ({
  caption,
  note,
  wide = false,
  children,
  className,
}: {
  caption: string
  note?: ReactNode
  /** The canvas fits its content by default — a settings mock stays the
      width a settings page reads at, rather than stretching a narrow column
      across the whole page. A board proving a *row's* own spacing (Stat's
      dashboard line) sets this instead, so the canvas fills the column and
      the spacing is the thing being shown. */
  wide?: boolean
  children: ReactNode
  className?: string
}) => (
  <figure className={className ? `${styles.specimen} ${className}` : styles.specimen}>
    <figcaption className={styles.specimenCaption}>
      {caption}
      {note != null && <span className={styles.specimenNote}>{note}</span>}
    </figcaption>
    <Card variant="plate" className={styles.specimenCanvas} data-wide={wide || undefined}>
      {children}
    </Card>
  </figure>
)
