import { Menu as DropdownMenuPrimitive } from '@base-ui/react/menu'
import * as React from 'react'

import { CheckIcon, BulletIcon } from '@/components/Icons'
import { cn } from '@/lib/utils'

/* Vendored from shadcn/ui (dropdown-menu). Icons come from the app's
 * façade — the one place allowed to draw one — and the floating surface
 * takes the app's popover z-name rather than a bare number. */

const DropdownMenu = ({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) => (
  <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />
)

const DropdownMenuPortal = ({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Portal>) => (
  <DropdownMenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />
)

const DropdownMenuPositioner = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Positioner>,
  React.ComponentProps<typeof DropdownMenuPrimitive.Positioner>
>(({ ...props }, ref) => (
  <DropdownMenuPrimitive.Positioner ref={ref} data-slot="dropdown-menu-positioner" {...props} />
))
DropdownMenuPositioner.displayName = 'DropdownMenuPositioner'

const DropdownMenuPopup = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Popup>,
  React.ComponentProps<typeof DropdownMenuPrimitive.Popup>
>(({ ...props }, ref) => (
  <DropdownMenuPrimitive.Popup ref={ref} data-slot="dropdown-menu-popup" {...props} />
))
DropdownMenuPopup.displayName = 'DropdownMenuPopup'

const DropdownMenuTrigger = ({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) => (
  <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />
)

const DropdownMenuContent = ({
  className,
  sideOffset = 4,
  align = 'start',
  side = 'bottom',
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Popup> &
  Pick<React.ComponentProps<typeof DropdownMenuPrimitive.Positioner>, 'align' | 'side' | 'sideOffset'>) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Positioner align={align} side={side} sideOffset={sideOffset} className="z-(--hd-z-popover)">
      <DropdownMenuPrimitive.Popup
        data-slot="dropdown-menu-content"
        className={cn(
          'bg-popover text-popover-foreground data-starting-style:animate-in data-starting-style:fade-in-0 data-starting-style:zoom-in-95 data-ending-style:animate-out data-ending-style:fade-out-0 data-ending-style:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 max-h-(--available-height) min-w-32 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg border p-1 shadow-md',
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Positioner>
  </DropdownMenuPrimitive.Portal>
)

const DropdownMenuGroup = ({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Group>) => (
  <DropdownMenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />
)

const DropdownMenuItem = ({
  className,
  inset,
  variant = 'default',
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  inset?: boolean
  variant?: 'default' | 'destructive'
}) => (
  <DropdownMenuPrimitive.Item
    data-slot="dropdown-menu-item"
    data-inset={inset}
    data-variant={variant}
    className={cn(
      "focus:bg-accent focus:text-accent-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive data-[variant=destructive]:*:[svg]:!text-destructive [&_svg:not([class*='text-'])]:text-muted-foreground relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0",
      className,
    )}
    {...props}
  />
)

const DropdownMenuCheckboxItem = ({
  className,
  children,
  checked,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) => (
  <DropdownMenuPrimitive.CheckboxItem
    data-slot="dropdown-menu-checkbox-item"
    className={cn(
      'focus:bg-accent focus:text-accent-foreground relative flex cursor-default items-center gap-2 rounded-sm py-1 pr-2 pl-8 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
      className,
    )}
    checked={checked ?? false}
    {...props}
  >
    <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
      <DropdownMenuPrimitive.CheckboxItemIndicator>
        <CheckIcon size={14} />
      </DropdownMenuPrimitive.CheckboxItemIndicator>
    </span>
    {children}
  </DropdownMenuPrimitive.CheckboxItem>
)

const DropdownMenuRadioGroup = ({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>) => (
  <DropdownMenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />
)

const DropdownMenuRadioItem = ({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) => (
  <DropdownMenuPrimitive.RadioItem
    data-slot="dropdown-menu-radio-item"
    className={cn(
      'focus:bg-accent focus:text-accent-foreground relative flex cursor-default items-center gap-2 rounded-sm py-1 pr-2 pl-8 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
      className,
    )}
    {...props}
  >
    <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
      <DropdownMenuPrimitive.RadioItemIndicator>
        <BulletIcon size={14} />
      </DropdownMenuPrimitive.RadioItemIndicator>
    </span>
    {children}
  </DropdownMenuPrimitive.RadioItem>
)

const DropdownMenuLabel = ({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.GroupLabel> & {
  inset?: boolean
}) => (
  <DropdownMenuPrimitive.GroupLabel
    data-slot="dropdown-menu-label"
    data-inset={inset}
    className={cn('px-2 py-1 text-xs font-medium text-muted-foreground data-[inset]:pl-8', className)}
    {...props}
  />
)

const DropdownMenuSeparator = ({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) => (
  <DropdownMenuPrimitive.Separator
    data-slot="dropdown-menu-separator"
    className={cn('bg-border -mx-1 my-1 h-px', className)}
    {...props}
  />
)

const DropdownMenuShortcut = ({ className, ...props }: React.ComponentProps<'span'>) => (
  <span
    data-slot="dropdown-menu-shortcut"
    className={cn('text-muted-foreground ml-auto text-xs tracking-widest', className)}
    {...props}
  />
)

const DropdownMenuSub = ({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubmenuRoot>) => (
  <DropdownMenuPrimitive.SubmenuRoot data-slot="dropdown-menu-sub" {...props} />
)

const DropdownMenuSubTrigger = ({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubmenuTrigger> & {
  inset?: boolean
}) => (
  <DropdownMenuPrimitive.SubmenuTrigger
    data-slot="dropdown-menu-sub-trigger"
    data-inset={inset}
    className={cn(
      'focus:bg-accent focus:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground flex cursor-default items-center rounded-sm px-2 py-1 text-sm outline-hidden select-none data-[inset]:pl-8',
      className,
    )}
    {...props}
  >
    {/* No chevron of its own: the row that opens a flyout draws one where its
        pattern places it, and a second here stood beside it at the edge. */}
    {children}
  </DropdownMenuPrimitive.SubmenuTrigger>
)

const DropdownMenuSubContent = ({
  className,
  align = 'start',
  side = 'right',
  sideOffset = 0,
  collisionAvoidance,
  sticky,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Popup> &
  Pick<
    React.ComponentProps<typeof DropdownMenuPrimitive.Positioner>,
    'align' | 'side' | 'sideOffset' | 'collisionAvoidance' | 'sticky'
  >) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Positioner
      align={align}
      side={side}
      sideOffset={sideOffset}
      collisionAvoidance={collisionAvoidance}
      sticky={sticky}
      className="z-(--hd-z-popover)"
    >
      <DropdownMenuPrimitive.Popup
        data-slot="dropdown-menu-sub-content"
        className={cn(
          'bg-popover text-popover-foreground data-starting-style:animate-in data-starting-style:fade-in-0 data-starting-style:zoom-in-95 data-ending-style:animate-out data-ending-style:fade-out-0 data-ending-style:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 min-w-32 origin-(--transform-origin) overflow-hidden rounded-lg border p-1 shadow-lg',
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Positioner>
  </DropdownMenuPrimitive.Portal>
)

export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuPositioner,
  DropdownMenuPopup,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
}
