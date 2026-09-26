import type { ReactNode } from 'react'

import { Card, Text } from '..'
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
  measure = 'fit',
  children,
  className,
}: {
  caption: string
  note?: ReactNode
  /**
   * How the canvas is sized:
   *
   *   fit    shrinks to its content — a chip-sized example (a few Face
   *          tiles) stays that size instead of stretching a plate across
   *          whatever is left of the page. The default.
   *   page   the app's own reading measure, `--hd-column` — for a mock of a
   *          whole settings/detail page (Rows, PageHead, Field, Stepper,
   *          Banner), which reads at the width a real page gives it, not
   *          squeezed to its narrowest row.
   *   wide   fills the column — for a board proving a *row's* own spacing
   *          (Stat's dashboard line), where the spacing is the thing being
   *          shown.
   */
  measure?: 'fit' | 'page' | 'wide'
  children: ReactNode
  className?: string
}) => (
  <figure className={className ? `${styles.specimen} ${className}` : styles.specimen}>
    <figcaption>
      <Text as="div" role="meta" className={styles.specimenCaption}>
        {caption}
        {note != null && <span className={styles.specimenNote}>{note}</span>}
      </Text>
    </figcaption>
    <Card variant="plate" className={styles.specimenCanvas} data-measure={measure}>
      {children}
    </Card>
  </figure>
)
