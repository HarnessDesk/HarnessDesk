import type { ReactNode } from 'react'

import { AlertIcon } from '../../components/Icons'
import { Alert, AlertContent, AlertDescription } from '../ui/alert'

/**
 * Reports that an action the person just took failed, together with the reason.
 * Use `Field`'s error instead when the problem belongs to one field.
 */
const ActionError = ({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) => (
  <Alert tone="danger" role="alert" className={className}>
    <AlertIcon />
    <AlertContent>
      <AlertDescription>{children}</AlertDescription>
    </AlertContent>
  </Alert>
)

export { ActionError }
