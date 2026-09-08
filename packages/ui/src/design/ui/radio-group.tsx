import { Radio } from '@base-ui/react/radio'
import { RadioGroup as RadioGroupPrimitive } from '@base-ui/react/radio-group'
import type * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * Vendored from shadcn/ui (radio-group) &mdash; the **Base UI** build.
 *
 * Adopted for one reason, and it is a keyboard one. The app's own segmented
 * control is a row of hand-rolled `role="radio"` buttons, and hand-rolled is
 * exactly what it sounds like: every option is a tab stop, so reaching the
 * fourth choice in a settings row takes four presses, where a real radio group
 * is one press to enter and arrows to choose. That is not a nicety &mdash; it is
 * the difference between a settings page a keyboard can move through and one it
 * has to wade through.
 *
 * `Kit.Segmented` is now this component wearing the segmented shape (see
 * Kit.tsx). The two are not two answers: one owns the behaviour, the other
 * owns the look.
 */

const RadioGroup = ({ className, ...props }: RadioGroupPrimitive.Props) => (
  <RadioGroupPrimitive
    data-slot="radio-group"
    className={cn('grid gap-2', className)}
    {...props}
  />
)

const RadioGroupItem = ({ className, ...props }: Radio.Root.Props) => (
  <Radio.Root
    data-slot="radio-group-item"
    className={cn(
      'aspect-square size-4 shrink-0 rounded-full border border-(--hd-border-strong) outline-none transition-colors',
      /* Checked is the solid, the same ink a filled button and an on switch
         are drawn in — see `--hd-solid`. */
      'data-checked:border-(--hd-toggle-on) data-checked:bg-(--hd-toggle-on)',
      'data-disabled:cursor-not-allowed data-disabled:opacity-50',
      className,
    )}
    {...props}
  >
    <Radio.Indicator
      data-slot="radio-group-indicator"
      className="flex size-full items-center justify-center"
    >
      {/* The dot is what reads on the solid rather than a hole punched
          through, for the same reason the switch's knob is: it is the mark,
          not a gap in the surface. */}
      <span className="block size-1.5 rounded-full bg-(--hd-toggle-knob-on)" />
    </Radio.Indicator>
  </Radio.Root>
)

export { RadioGroup, RadioGroupItem }
