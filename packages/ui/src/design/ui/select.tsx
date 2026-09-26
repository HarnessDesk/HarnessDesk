import { Select as SelectPrimitive } from '@base-ui/react/select'
import type * as React from 'react'

import { CaretIcon, CheckIcon, MoveUpIcon } from '@/components/Icons'
import { cn } from '@/lib/utils'
import { floatingMotion } from './motion'

/* Vendored from shadcn/ui (select); façade icons, app measure tokens, ring
 * utilities dropped. For a picker that must survive jsdom (tests drive it
 * with a plain change event), reach for NativeSelect instead. */

const Select = ({ ...props }: React.ComponentProps<typeof SelectPrimitive.Root>) => (
  <SelectPrimitive.Root data-slot="select" {...props} />
)

const SelectGroup = ({ ...props }: React.ComponentProps<typeof SelectPrimitive.Group>) => (
  <SelectPrimitive.Group data-slot="select-group" {...props} />
)

const SelectValue = ({ ...props }: React.ComponentProps<typeof SelectPrimitive.Value>) => (
  <SelectPrimitive.Value data-slot="select-value" {...props} />
)

const SelectTrigger = ({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger>) => (
  <SelectPrimitive.Trigger
    data-slot="select-trigger"
    className={cn(
      "border-input data-[placeholder]:text-muted-foreground [&_svg:not([class*='text-'])]:text-muted-foreground flex h-(--hd-field-h) w-fit items-center justify-between gap-2 rounded-md border bg-transparent px-2.5 py-0 text-sm whitespace-nowrap transition-colors outline-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive dark:bg-input/30 [&_svg]:pointer-events-none [&_svg]:shrink-0 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2",
      className,
    )}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon className="flex">
      <CaretIcon size={13} />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
)

const SelectContent = ({
  className,
  children,
  align = 'start',
  side = 'bottom',
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Popup> &
  Pick<React.ComponentProps<typeof SelectPrimitive.Positioner>, 'align' | 'side' | 'sideOffset'>) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Positioner
      align={align}
      side={side}
      sideOffset={sideOffset}
      className="z-(--hd-z-popover)"
    >
      <SelectPrimitive.Popup
        data-slot="select-content"
        className={cn(
          floatingMotion,
          'bg-popover text-popover-foreground relative max-h-(--available-height) min-w-32 overflow-x-hidden overflow-y-auto rounded-lg border shadow-md data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1',
          className,
        )}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.List className="min-w-(--anchor-width) scroll-my-1 p-1">
          {children}
        </SelectPrimitive.List>
        <SelectScrollDownButton />
      </SelectPrimitive.Popup>
    </SelectPrimitive.Positioner>
  </SelectPrimitive.Portal>
)

const SelectLabel = ({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.GroupLabel>) => (
  <SelectPrimitive.GroupLabel
    data-slot="select-label"
    className={cn('text-muted-foreground px-2 py-1 text-xs', className)}
    {...props}
  />
)

const SelectItem = ({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) => (
  <SelectPrimitive.Item
    data-slot="select-item"
    className={cn(
      "focus:bg-accent focus:text-accent-foreground [&_svg:not([class*='text-'])]:text-muted-foreground relative flex w-full cursor-default items-center gap-2 rounded-sm py-1 pr-8 pl-2 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
      className,
    )}
    {...props}
  >
    <span className="absolute right-2 flex size-3.5 items-center justify-center">
      <SelectPrimitive.ItemIndicator>
        <CheckIcon size={14} />
      </SelectPrimitive.ItemIndicator>
    </span>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
)

const SelectSeparator = ({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Separator>) => (
  <SelectPrimitive.Separator
    data-slot="select-separator"
    className={cn('bg-border pointer-events-none -mx-1 my-1 h-px', className)}
    {...props}
  />
)

const SelectScrollUpButton = ({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpArrow>) => (
  <SelectPrimitive.ScrollUpArrow
    data-slot="select-scroll-up-button"
    className={cn('flex cursor-default items-center justify-center py-1', className)}
    {...props}
  >
    <MoveUpIcon size={14} />
  </SelectPrimitive.ScrollUpArrow>
)

const SelectScrollDownButton = ({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownArrow>) => (
  <SelectPrimitive.ScrollDownArrow
    data-slot="select-scroll-down-button"
    className={cn('flex cursor-default items-center justify-center py-1', className)}
    {...props}
  >
    <CaretIcon size={14} />
  </SelectPrimitive.ScrollDownArrow>
)

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
}
