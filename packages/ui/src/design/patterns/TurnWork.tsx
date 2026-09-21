import type * as React from 'react'

import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import styles from './TurnWork.module.css'

/** The fold control and label for one turn's work receipt. */
const TurnWorkHeader = ({
  trouble = false,
  className,
  ...props
}: React.ComponentProps<typeof Button> & { trouble?: boolean }) => (
  <Button
    data-slot="turn-work-header"
    {...(trouble ? { 'data-trouble': '' } : {})}
    className={cn(styles.head, className)}
    {...props}
  />
)

const TurnWorkHeaderLabel = ({ className, ...props }: React.ComponentProps<'span'>) => (
  <span data-slot="turn-work-header-label" className={cn(styles.headLabel, className)} {...props} />
)

export { TurnWorkHeader, TurnWorkHeaderLabel }
