import type { ReactElement, ReactNode } from 'react'

import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

/**
 * Keeps the reason for a disabled action reachable.
 *
 * A disabled native control cannot receive focus, so a `title` on that control
 * is pointer-only and may never be announced. The wrapper is the focusable
 * explanation target while the child remains a genuinely disabled control.
 */
const RefusedAction = ({
  reason,
  children,
}: {
  reason?: ReactNode
  children: ReactElement
}) => {
  if (!reason) return children
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            data-slot="refused-action"
            tabIndex={0}
            className="inline-flex max-w-full rounded-(--hd-btn-radius) focus-visible:shadow-(--hd-focus-ring) focus-visible:outline-none"
            aria-label={typeof reason === 'string' ? reason : undefined}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  )
}

export { RefusedAction }
