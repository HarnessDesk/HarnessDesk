import type { ReactNode } from 'react'
import { CheckIcon, CrossIcon, UserIcon } from '../../components/Icons'
import { Button } from '../ui/button'
import { Text } from './Settings'
import { revealMotion } from '../ui/motion'
import { cn } from '@/lib/utils'
import styles from './ComparisonNotice.module.css'

/** A comparison’s quiet result shelf. Its reserved space keeps the grid still when a pick arrives; actions never cover a conversation or its composer. */
export const ComparisonNotice = ({ title, reason, waiting, action, onDismiss }: {
  title?: ReactNode
  reason?: ReactNode
  waiting?: boolean
  action?: { label: string; onSelect: () => void }
  onDismiss?: () => void
}) => <div data-slot="comparison-notice-slot" className={styles.slot}>
  {title ? <div data-slot="comparison-notice" className={cn(styles.notice, revealMotion)} data-waiting={waiting || undefined}>
    <span className={styles.icon} aria-hidden>{waiting ? <UserIcon size={16} /> : <CheckIcon size={16} />}</span>
    <div className={styles.words} role="status">
      <Text role="prose" weight="medium" as="div">{title}</Text>
      {reason ? <Text role="prose" className="text-(--hd-secondary-foreground)" as="div">{reason}</Text> : null}
    </div>
    {action ? <Button variant="secondary" size="sm" onClick={action.onSelect}>{action.label}</Button> : null}
    {onDismiss ? <Button variant="ghost" size="icon-sm" aria-label="Dismiss verdict" onClick={onDismiss}><CrossIcon size={14} /></Button> : null}
  </div> : null}
</div>
