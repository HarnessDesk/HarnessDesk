import { cloneElement, useId, type ReactElement, type ReactNode } from 'react'

import type { ButtonProps } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

/**
 * Keeps the reason for a disabled action reachable.
 *
 * Base UI keeps the disabled button focusable while refusing activation.
 * Its name remains the action; a persistent description supplies the reason
 * before a tooltip opens, including for assistive technology.
 */
const RefusedAction = ({
  reason,
  children,
}: {
  reason?: ReactNode
  children: ReactElement<ButtonProps>
}) => {
  const reasonId = useId()
  if (!reason) return children
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={cloneElement(children, {
            disabled: true,
            focusableWhenDisabled: true,
            className: `${children.props.className ?? ''} aria-disabled:pointer-events-auto`,
            'aria-describedby': [children.props['aria-describedby'], reasonId].filter(Boolean).join(' '),
          })}
          data-slot="refused-action"
        />
        <TooltipContent>{reason}</TooltipContent>
      </Tooltip>
      <span id={reasonId} className="sr-only">{reason}</span>
    </>
  )
}

export { RefusedAction }
