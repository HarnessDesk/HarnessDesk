import type { ReactNode } from 'react'
import { CheckIcon, CrossIcon, UserIcon } from '../../components/Icons'
import { Alert, AlertContent, AlertDescription, AlertTitle } from '../ui/alert'
import { Button } from '../ui/button'
import { IconTile } from '../ui/icon-tile'
import { revealMotion } from '../ui/motion'
import { cn } from '@/lib/utils'
import styles from './ComparisonNotice.module.css'

/** A comparison’s quiet result shelf, composed from Alert. Its fixed grid track keeps the tiles still; long recorded text scrolls whole while actions remain visible. */
export const ComparisonNotice = ({ title, reason, waiting, action, onDismiss }: {
  title?: ReactNode
  reason?: ReactNode
  waiting?: boolean
  action?: { label: string; onSelect: () => void }
  onDismiss?: () => void
}) => <div data-slot="comparison-notice-slot" className={styles.slot}>
  {title ? <Alert tone="neutral" data-slot="comparison-notice" className={cn(styles.notice, 'items-center', revealMotion)} data-waiting={waiting || undefined}>
    <IconTile size="sm" tone={waiting ? 'neutral' : 'success'} aria-hidden>{waiting ? <UserIcon size={16} /> : <CheckIcon size={16} />}</IconTile>
    <AlertContent className={styles.words} role="status" tabIndex={0} aria-label="Comparison verdict">
      <AlertTitle>{title}</AlertTitle>
      {reason ? <AlertDescription>{reason}</AlertDescription> : null}
    </AlertContent>
    {action ? <Button variant="secondary" size="sm" onClick={action.onSelect}>{action.label}</Button> : null}
    {onDismiss ? <Button variant="ghost" size="icon-sm" aria-label="Dismiss verdict" onClick={onDismiss}><CrossIcon size={14} /></Button> : null}
  </Alert> : null}
</div>
