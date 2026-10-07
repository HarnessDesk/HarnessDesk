import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '../../lib/utils'
import { Button } from './button'
import { Text } from '../patterns/Settings'
import styles from './timeline.module.css'

/** Recorded progress on a continuous rail; pending never claims completion. */
export type TimelineState = 'done' | 'active' | 'pending' | 'warning' | 'danger'
const LABEL: Record<TimelineState, string> = { done: 'Finished', active: 'In progress', pending: 'Pending', warning: 'Needs attention', danger: 'Failed' }

/** An oldest-first story. The item owns its incoming rail segment, so a
 * completed item fills the path above it and the path ahead stays faint. */
export const Timeline = ({ children, className, ...props }: HTMLAttributes<HTMLOListElement>) =>
  <ol data-slot="timeline" className={cn(styles.timeline, className)} {...props}>{children}</ol>

/** Meta, title and detail share one content edge. The ring centres on the
 * title's first line even when its words wrap. Actions are separate controls;
 * child records stay in the content column and never interrupt the rail. */
export const TimelineItem = ({ state, meta, title, detail, actions, children, selected, onSelect, className, ...props }: Omit<HTMLAttributes<HTMLDivElement>, 'title' | 'onSelect'> & {
  state: TimelineState
  meta?: ReactNode
  title: ReactNode
  detail?: ReactNode
  actions?: ReactNode
  selected?: boolean
  onSelect?: () => void
}) => <li data-slot="timeline-item" data-state={state} data-has-meta={meta != null || undefined} className={styles.item}>
  <span data-slot="timeline-rail" className={styles.rail} aria-hidden="true" />
  <span data-slot="timeline-indicator" className={styles.indicator} role="img" aria-label={LABEL[state]} />
  <div className={styles.content}>
    <div data-slot="timeline-summary" aria-current={selected ? 'true' : undefined} className={cn(styles.summary, selected && styles.selected, className)} onClick={event => { if (event.currentTarget.contains(event.target as Node) && !(event.target as Element).closest('button')) onSelect?.() }} {...props}>
      {meta != null && <div data-slot="timeline-meta" className={styles.meta}><Text as="div" role="meta" numeric>{meta}</Text></div>}
      <div data-slot="timeline-heading" className={styles.heading}>
        {onSelect ? <Button variant="row" size="content-min" bordered={false} stretched hoverFill={false} onClick={onSelect} className={styles.title}><Text role="prose" weight="medium">{title}</Text></Button>
          : <Text as="div" role="prose" weight="medium" className={styles.title}>{title}</Text>}
        {actions != null && <div data-slot="timeline-actions" className={styles.actions}>{actions}</div>}
      </div>
      {detail != null && <div data-slot="timeline-detail" className={styles.detail}><Text role="prose" ink="secondary">{detail}</Text></div>}
    </div>
    {children != null && <div data-slot="timeline-records" className={styles.records}>{children}</div>}
  </div>
</li>
