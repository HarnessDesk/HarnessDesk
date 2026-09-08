import { Checkbox as CheckboxPrimitive } from 'radix-ui'
import type * as React from 'react'

import { CheckIcon } from '@/components/Icons'
import { cn } from '@/lib/utils'

/*
 * Vendored from shadcn/ui (checkbox); façade icon, ring utilities dropped.
 *
 * Checked is the accent — the same mark an on switch and a chosen radio wear,
 * see `--hd-toggle-on` — so the three controls that answer "is this on" answer
 * it in one colour, and the Accent dial reaches all three. It is spelled with
 * the toggle tokens rather than Tailwind's `bg-primary` so that stays true
 * through a foundation swap.
 */

const Checkbox = ({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) => (
  <CheckboxPrimitive.Root
    data-slot="checkbox"
    className={cn(
      'peer border-input dark:bg-input/30 data-[state=checked]:bg-(--hd-toggle-on) data-[state=checked]:text-(--hd-toggle-knob-on) data-[state=checked]:border-(--hd-toggle-on) size-4 shrink-0 rounded-(--hd-radius-sm) border transition-colors outline-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive',
      className,
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator
      data-slot="checkbox-indicator"
      className="grid place-items-center text-current transition-none"
    >
      <CheckIcon size={12} />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
)

export { Checkbox }
