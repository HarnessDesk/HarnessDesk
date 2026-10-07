import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '../../lib/utils'
import { Button } from './button'
import { Card } from './card'
import { MiddleTruncate } from './key-value'
import { CodeText, Text } from '../patterns/Settings'
import styles from './timeline-cards.module.css'

/**
 * One round's cards. Several cards of a round are laid side by side, two or
 * three across, and as a list beyond three or when the column is narrow. The
 * group answers the width of the column it sits in (a size container), never
 * the window's, so the same round reads the same beside the dock and without it.
 *
 * `count` is how many cards the round holds; it decides how many may sit across.
 */
export const TimelineCards = ({ count, children, className, ...props }: HTMLAttributes<HTMLDivElement> & { count: number }) =>
  <div data-slot="timeline-cards" className={cn(styles.cards, className)} {...props}>
    <div data-slot="timeline-card-grid" data-count={count} className={styles.grid}>{children}</div>
  </div>

/**
 * A card of a round: who, what they said, what they left.
 *
 * The header is the card's face and name with one quiet line of meta, and takes
 * the card's own controls at its end; the body is its words; the footer is its
 * facts and their states. The name is the card's one tab stop and selects it
 * (the inspector follows the selection); controls in the header sit above that
 * and keep their own clicks. Nothing here is an agent's name: the caller passes
 * words the host recorded.
 */
export const TimelineCard = ({ lead, name, meta, actions, footer, selected, onSelect, className, children, ...props }: Omit<HTMLAttributes<HTMLDivElement>, 'title' | 'onSelect'> & {
  lead?: ReactNode
  name: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  footer?: ReactNode
  selected?: boolean
  onSelect?: () => void
}) => <Card variant="plate" spacing="flush" data-slot="timeline-card" data-selected={selected || undefined} aria-current={selected ? 'true' : undefined}
  className={cn(styles.card, className)}
  onClick={event => { if (event.currentTarget.contains(event.target as Node) && !(event.target as Element).closest('button, a')) onSelect?.() }} {...props}>
  <div data-slot="timeline-card-head" className={styles.head}>
    {lead}
    <div className={styles.who}>
      {onSelect ? <Button variant="row" size="content-min" bordered={false} stretched hoverFill={false} onClick={onSelect} className={styles.name}><Text role="row">{name}</Text></Button>
        : <Text as="div" role="row" className={styles.name}>{name}</Text>}
      {meta != null && <Text role="meta">{meta}</Text>}
    </div>
    {actions != null && <div data-slot="timeline-card-actions" className={styles.actions}>{actions}</div>}
  </div>
  {children != null && <div data-slot="timeline-card-body" className={styles.body}>{children}</div>}
  {footer != null && <div data-slot="timeline-card-footer" className={styles.footer}>{footer}</div>}
</Card>

/** The words a card says in its own prose, kept to a few lines. */
export const TimelineCardWords = ({ children, className, ...props }: HTMLAttributes<HTMLDivElement>) =>
  <div data-slot="timeline-card-words" className={cn(styles.lines, className)} {...props}><Text role="prose" ink="secondary">{children}</Text></div>

/**
 * A document a card committed, shown inline where it was committed: its path,
 * what the commit says of it, and its words (the caller renders them, already
 * sanitised, as the prose they are). The path gives up its middle, never its
 * name; the words scroll inside the block rather than lengthening the timeline.
 */
export const TimelineDocument = ({ icon, path, meta, children, className, ...props }: Omit<HTMLAttributes<HTMLDivElement>, 'title'> & {
  icon?: ReactNode
  path: string
  meta?: ReactNode
}) => <div data-slot="timeline-document" className={cn(styles.document, className)} {...props}>
  <div className={styles.documentHead}>
    {icon}
    <Text role="meta" className={styles.documentPath}><CodeText><MiddleTruncate>{path}</MiddleTruncate></CodeText></Text>
    {meta != null && <Text role="meta" numeric>{meta}</Text>}
  </div>
  {children != null && <div data-slot="timeline-document-body" className={styles.documentBody}>{children}</div>}
</div>
