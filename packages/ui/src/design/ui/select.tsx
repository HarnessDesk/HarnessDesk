import { Select as SelectPrimitive } from '@base-ui/react/select'
import * as React from 'react'
import { registerMenu } from './popup-state'
import { MenuPresentation, MenuRowContent, menuRowAttributes, type MenuRowData } from './menu-row'

import { CaretIcon, CheckIcon } from '@/components/Icons'
import { cn } from '@/lib/utils'
import { floatingMotion } from './motion'

/* Vendored from shadcn/ui (select); façade icons, app measure tokens, ring
 * utilities dropped. For a picker that must survive jsdom (tests drive it
 * with a plain change event), reach for NativeSelect instead. */

const Select = ({ open: controlledOpen, defaultOpen, onOpenChange, ...props }: React.ComponentProps<typeof SelectPrimitive.Root>) => {
  const [localOpen, setLocalOpen] = React.useState(defaultOpen ?? false)
  const effectiveOpen = controlledOpen ?? localOpen
  const menuId = React.useRef(Symbol('select'))
  React.useLayoutEffect(() => effectiveOpen ? registerMenu(menuId.current) : undefined, [effectiveOpen])
  return <SelectPrimitive.Root {...props} open={effectiveOpen} onOpenChange={(next, details) => { onOpenChange?.(next, details); if (!details.isCanceled) setLocalOpen(next) }} data-slot="select" />
}

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
  className: _className,
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
      <SelectPrimitive.Popup {...props} data-slot="select-content" data-popup-kind="menu" data-menu-icons="none" className={floatingMotion}>
        <MenuPresentation icons="none">
          <SelectScrollUpButton />
          <SelectPrimitive.List>{children}</SelectPrimitive.List>
          <SelectScrollDownButton />
        </MenuPresentation>
      </SelectPrimitive.Popup>
    </SelectPrimitive.Positioner>
  </SelectPrimitive.Portal>
)

const SelectLabel = ({ className: _className, ...props }: React.ComponentProps<typeof SelectPrimitive.GroupLabel>) => <SelectPrimitive.GroupLabel {...props} data-slot="select-label" data-menu-group="" />

const SelectItem = ({ label, hint, className: _className, children, ...props }:
  React.ComponentProps<typeof SelectPrimitive.Item> & Partial<Pick<MenuRowData, 'label' | 'hint'>>) => {
  const data: MenuRowData = {
    label: <SelectPrimitive.ItemText>{label ?? children}</SelectPrimitive.ItemText>,
    hint,
    trailing: <SelectPrimitive.ItemIndicator className="inline-flex"><CheckIcon size={16} /></SelectPrimitive.ItemIndicator>,
  }
  return <SelectPrimitive.Item {...props} label={label} {...menuRowAttributes(data)} data-slot="select-item">
    <MenuRowContent {...data} />
  </SelectPrimitive.Item>
}

const SelectSeparator = ({ className: _className, ...props }: React.ComponentProps<typeof SelectPrimitive.Separator>) => <SelectPrimitive.Separator {...props} data-slot="select-separator" data-menu-separator="" />

const SelectScrollUpButton = ({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpArrow>) => (
  <SelectPrimitive.ScrollUpArrow
    data-slot="select-scroll-up-button"
    className={cn('inset-x-1 top-1 z-1 flex cursor-default items-center justify-center rounded-sm bg-popover py-1', className)}
    {...props}
  >
    <CaretIcon size={14} className="rotate-180" />
  </SelectPrimitive.ScrollUpArrow>
)

const SelectScrollDownButton = ({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownArrow>) => (
  <SelectPrimitive.ScrollDownArrow
    data-slot="select-scroll-down-button"
    className={cn('inset-x-1 bottom-1 z-1 flex cursor-default items-center justify-center rounded-sm bg-popover py-1', className)}
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
