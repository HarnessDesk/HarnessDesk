import { Checkbox as CheckboxPrimitive } from '@base-ui/react/checkbox'
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
  checked,
  defaultChecked,
  ...props
}: Omit<React.ComponentProps<typeof CheckboxPrimitive.Root>, 'checked' | 'defaultChecked'> & {
  checked?: boolean | 'indeterminate'
  defaultChecked?: boolean | 'indeterminate'
}) => (
  <CheckboxPrimitive.Root
    data-slot="checkbox"
    className={cn(
      'peer border-input dark:bg-input/30 data-checked:bg-(--hd-toggle-on) data-checked:text-(--hd-toggle-knob-on) data-checked:border-(--hd-toggle-on) size-4 shrink-0 rounded-(--hd-radius-sm) border transition-colors outline-none data-disabled:cursor-not-allowed data-disabled:opacity-50 aria-invalid:border-destructive',
      className,
    )}
    checked={checked === 'indeterminate' ? false : checked}
    defaultChecked={defaultChecked === 'indeterminate' ? false : defaultChecked}
    indeterminate={checked === 'indeterminate' || defaultChecked === 'indeterminate'}
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
