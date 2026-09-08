import { Switch as SwitchPrimitive } from '@base-ui/react/switch'
import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * Vendored from shadcn/ui — the **Base UI** switch, not the Radix one.
 *
 * Same warning as tabs.tsx: the two builds are not interchangeable. The state
 * arrives as `data-checked` / `data-unchecked` here, where Radix sends
 * `data-[state=checked]`. A stale class selector does not fail; it renders a
 * switch that never appears to move.
 *
 * Three things this build gives the app that the Radix one did not:
 *
 *   A `size` prop.        The desk has always had two switches — the settings
 *                         row's and the menu row's smaller one — and they were
 *                         two stylesheets agreeing by hand. Now they are one
 *                         component and a prop.
 *   A real hit target.    `after:-inset-x-3 after:-inset-y-2` extends the
 *                         pressable area past the 32×18 track without changing
 *                         a single pixel of layout. A switch that small is
 *                         under every touch-target guideline there is, and the
 *                         old one had no such padding.
 *   `render`.             Base UI can render its root as a different element,
 *                         which is what `SwitchShape` below needs.
 *
 * The knob is white at rest, the way a hardware switch's moving part is, and
 * takes `--hd-toggle-knob-on` once the track is the accent — which is not
 * white on every accent, because green and orange are too light to carry it.
 * Both values are tokens; this file states neither.
 */

/*
 * One shape, declared once.
 *
 * `Switch` wears it as an interactive root; `SwitchShape` wears it as an inert
 * span. That split is not a convenience — it is the app's one real constraint
 * on this control. A menu row IS the switch: it carries `role="switch"` and
 * its own click handler, so a Base UI root inside it would be a button nested
 * in a switch, which is invalid markup, swallows the row's click, and gets
 * announced twice. The row therefore needs the shape with no behaviour.
 *
 * The repo already learned this and had solved it by forking the CSS three
 * ways (see docs/design-system and the 2026-08-29 consolidation). Sharing one
 * `cva` between two mountings is that fix, kept, on the new primitive.
 */
const switchTrack = cva(
  'peer group/switch relative inline-flex shrink-0 items-center rounded-full border border-transparent transition-colors outline-none',
  {
    variants: {
      /* The app's own two sizes, counted rather than taken from the registry:
         twelve settings surfaces already stand at 34×20 and the menu's rows at
         30×18, against one caller on the registry's 32×18. Moving twelve to
         match one would be a redesign wearing a refactor's clothes.

         The travel falls out of the numbers — a 16px thumb in a 34px track
         moves `100% - 2px` = 14px, which is exactly what the stylesheet these
         replace hard-coded, and 12px for the small pair. So the shapes are
         pixel-identical to what shipped. */
      size: {
        default: 'h-5 w-[34px]',
        sm: 'h-[18px] w-[30px]',
      },
      on: {
        true: 'bg-(--hd-toggle-on)',
        false: 'bg-(--hd-toggle-track)',
      },
    },
    defaultVariants: { size: 'default', on: false },
  },
)

const switchThumb = cva(
  'pointer-events-none block rounded-full shadow-(--hd-shadow-sm) transition-transform',
  {
    variants: {
      size: { default: 'size-4', sm: 'size-3.5' },
      /* The knob is coloured by what it sits on, not by the theme: white on
         the grey track at rest, and whatever reads on the accent once the
         track is the accent — which is not white on every one of them, since
         green and orange are too light to carry it. */
      on: {
        true: 'translate-x-[calc(100%-2px)] bg-(--hd-toggle-knob-on)',
        false: 'translate-x-0.5 bg-(--hd-toggle-knob)',
      },
    },
    defaultVariants: { size: 'default', on: false },
  },
)

type SwitchSize = NonNullable<VariantProps<typeof switchTrack>['size']>

const Switch = ({
  className,
  size = 'default',
  ...props
}: SwitchPrimitive.Root.Props & { size?: SwitchSize }) => (
  <SwitchPrimitive.Root
    data-slot="switch"
    data-size={size}
    className={cn(
      switchTrack({ size }),
      /* State comes from the primitive rather than from the `on` variant here:
         an uncontrolled switch has no boolean to hand the cva, and asking the
         caller for one would make `defaultChecked` a lie. */
      'data-checked:bg-(--hd-toggle-on) data-unchecked:bg-(--hd-toggle-track)',
      'data-disabled:cursor-not-allowed data-disabled:opacity-50',
      /* The hit target, past the track and behind everything. */
      'after:absolute after:-inset-x-3 after:-inset-y-2',
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb
      data-slot="switch-thumb"
      className={cn(
        switchThumb({ size }),
        'data-checked:translate-x-[calc(100%-2px)] data-checked:bg-(--hd-toggle-knob-on)',
        'data-unchecked:translate-x-0.5 data-unchecked:bg-(--hd-toggle-knob)',
      )}
    />
  </SwitchPrimitive.Root>
)

/**
 * The switch as a picture: no role, no focus, no handler.
 *
 * For the one mounting that cannot take a root — a row that is itself the
 * switch. `aria-hidden`, because the row it sits in has already been announced
 * as a switch and its state read out; announcing it twice is worse than not
 * drawing it.
 */
const SwitchShape = ({
  className,
  checked = false,
  size = 'default',
  disabled,
  ...props
}: Omit<React.ComponentProps<'span'>, 'children'> & {
  checked?: boolean
  size?: SwitchSize
  disabled?: boolean
}) => (
  <span
    data-slot="switch-shape"
    data-size={size}
    {...(checked ? { 'data-checked': '' } : { 'data-unchecked': '' })}
    {...(disabled ? { 'data-disabled': '' } : {})}
    aria-hidden="true"
    className={cn(switchTrack({ size, on: checked }), disabled && 'opacity-50', className)}
    {...props}
  >
    <span data-slot="switch-thumb" className={switchThumb({ size, on: checked })} />
  </span>
)

export { Switch, SwitchShape, switchTrack, switchThumb }
