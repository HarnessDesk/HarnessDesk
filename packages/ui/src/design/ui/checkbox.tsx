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
 *
 * `label` is the box with the words it answers for: one `<label>`, so the
 * words are part of the target and name the box, the box first and the words
 * a small step after it on the box's centre line. A list of agents to install
 * for, the cards a job waits on, the items of an import — each drew that pair
 * for itself, at its own gap. With a `label`, the part is the label, and
 * `className` places the whole of it; the words bring their own text role.
 */

type CheckboxProps = Omit<React.ComponentProps<typeof CheckboxPrimitive.Root>, 'checked' | 'defaultChecked'> & {
  checked?: boolean | 'indeterminate'
  defaultChecked?: boolean | 'indeterminate'
  /** The words the box answers for, drawn after it inside one `<label>`. */
  label?: React.ReactNode
}

const Checkbox = ({ className, checked, defaultChecked, label, ...props }: CheckboxProps) => {
  const box = (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        'peer border-input dark:bg-input/30 data-checked:bg-(--hd-toggle-on) data-checked:text-(--hd-toggle-knob-on) data-checked:border-(--hd-toggle-on) size-4 shrink-0 rounded-(--hd-radius-sm) border transition-colors outline-none data-disabled:cursor-not-allowed data-disabled:opacity-50 aria-invalid:border-destructive',
        label == null && className,
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
  if (label == null) return box
  return (
    <label data-slot="checkbox-label" className={cn('inline-flex min-w-0 items-center gap-2', className)}>
      {box}
      {label}
    </label>
  )
}

export { Checkbox, type CheckboxProps }
