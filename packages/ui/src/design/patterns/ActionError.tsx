import type { ReactNode } from 'react'

import { AlertIcon } from '../../components/Icons'
import { Alert, AlertContent, AlertDescription } from '../ui/alert'
import { Button } from '../ui/button'
import { cn } from '@/lib/utils'

/**
 * Reports that an action the person just took failed, together with the reason.
 * Use `Field`'s error instead when the problem belongs to one field.
 *
 * `action` is the one thing that helps, when there is one — a sign-in, another
 * try — beside the reason, as a quiet button: the failure is the news, the
 * remedy an offer. One at most; a failure with two remedies has not decided
 * what it was.
 */
const ActionError = ({
  children,
  className,
  action,
}: {
  children: ReactNode
  className?: string
  action?: { readonly label: string; readonly onSelect: () => void; readonly disabled?: boolean; readonly title?: string }
}) => (
  /* With a button beside it the row is the button's height, and the icon and
     the reason sit on its middle rather than on its top edge. */
  <Alert tone="danger" role="alert" className={cn(action && 'items-center', className)}>
    <AlertIcon />
    <AlertContent>
      <AlertDescription>{children}</AlertDescription>
    </AlertContent>
    {action ? (
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={action.disabled}
        {...(action.title ? { title: action.title } : {})}
        onClick={action.onSelect}
      >
        {action.label}
      </Button>
    ) : null}
  </Alert>
)

export { ActionError }
