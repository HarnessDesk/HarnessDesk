import { Menu as DropdownMenuPrimitive } from '@base-ui/react/menu'
import * as React from 'react'

import { CheckIcon, BulletIcon, ChevronIcon } from '@/components/Icons'
import { DialogFormContext } from '@/lib/dialog-form'
import { cn } from '@/lib/utils'
import { floatingMotion } from './motion'
import { MenuPresentation, MenuRowContent, menuRowAttributes, useMenuPresentation, type MenuRowData, type MenuIcons } from './menu-row'

/* Vendored from shadcn/ui (dropdown-menu). Icons come from the app's
 * façade — the one place allowed to draw one — and the floating surface
 * takes the app's popover z-name rather than a bare number. */

const DropdownMenu = ({ icons = 'none', wide = false, children, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Root> & { icons?: MenuIcons; wide?: boolean }) =>
  <MenuPresentation icons={icons} wide={wide}><DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props}>{children}</DropdownMenuPrimitive.Root></MenuPresentation>

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

/* A surface that takes focus wears no ring; see `SURFACE_FOCUS` in dialog.tsx. */
const SURFACE_FOCUS = 'outline-none focus-visible:outline-none'
const surfaceFocus = <S,>(className: string | ((state: S) => string | undefined) | undefined) =>
  typeof className === 'function' ? (state: S) => cn(SURFACE_FOCUS, className(state)) : cn(SURFACE_FOCUS, className)

const DropdownMenuPopup = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Popup>,
  React.ComponentProps<typeof DropdownMenuPrimitive.Popup>
>(({ className, ...props }, ref) => (
  <DialogFormContext.Provider value={false}>
    <DropdownMenuPrimitive.Popup ref={ref} data-slot="dropdown-menu-popup" className={surfaceFocus(className)} {...props} />
  </DialogFormContext.Provider>
))
DropdownMenuPopup.displayName = 'DropdownMenuPopup'

const DropdownMenuTrigger = ({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) => (
  <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />
)

type DropdownContentProps = Omit<React.ComponentProps<typeof DropdownMenuPrimitive.Popup>, 'className' | 'style'> &
  Pick<React.ComponentProps<typeof DropdownMenuPrimitive.Positioner>, 'align' | 'side' | 'sideOffset'>
const DropdownMenuContent = ({ sideOffset = 4, align = 'start', side = 'bottom', ...props }: DropdownContentProps) => {
  const { icons, wide } = useMenuPresentation()
  return <DialogFormContext.Provider value={false}><DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Positioner align={align} side={side} sideOffset={sideOffset} className="z-(--hd-z-popover)">
      <DropdownMenuPrimitive.Popup {...props} data-slot="dropdown-menu-content" data-popup-kind={wide ? 'wide-menu' : 'menu'} data-menu-icons={icons} className={cn(floatingMotion, SURFACE_FOCUS)} />
    </DropdownMenuPrimitive.Positioner>
  </DropdownMenuPrimitive.Portal></DialogFormContext.Provider>
}

const DropdownMenuGroup = ({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Group>) => (
  <DropdownMenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />
)

type DropdownRowProps = Omit<React.ComponentProps<typeof DropdownMenuPrimitive.Item>, 'children' | 'label' | 'style'> & Partial<MenuRowData> & {
  children?: React.ReactNode
  inset?: boolean
  variant?: 'default' | 'destructive'
}
const DropdownMenuItem = ({ label, children, icon, hint, hintId, trailing, badge, meter, variant = 'default', inset: _inset, ...props }: DropdownRowProps) => {
  const data = { label: label ?? children, icon, hint, hintId, trailing, badge, meter }
  return <DropdownMenuPrimitive.Item {...props} data-slot="dropdown-menu-item" data-variant={variant} {...menuRowAttributes(data)}>
    <MenuRowContent {...data} />
  </DropdownMenuPrimitive.Item>
}


const DropdownMenuCheckboxItem = ({ children, checked, icon, hint, indicator = true, ...props }: Omit<React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>, 'children' | 'className' | 'style'> & { children?: React.ReactNode; icon?: React.ReactNode; hint?: React.ReactNode; indicator?: boolean }) => {
  const data = { label: children, icon, hint, trailing: indicator ? <DropdownMenuPrimitive.CheckboxItemIndicator><CheckIcon size={16} /></DropdownMenuPrimitive.CheckboxItemIndicator> : undefined }
  return <DropdownMenuPrimitive.CheckboxItem {...props} data-slot="dropdown-menu-checkbox-item" checked={checked ?? false} {...menuRowAttributes(data)}><MenuRowContent {...data} /></DropdownMenuPrimitive.CheckboxItem>
}

const DropdownMenuRadioGroup = ({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>) => (
  <DropdownMenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />
)

const DropdownMenuRadioItem = ({ children, icon, hint, ...props }: Omit<React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>, 'children' | 'className' | 'style'> & { children?: React.ReactNode; icon?: React.ReactNode; hint?: React.ReactNode }) => {
  const data = { label: children, icon, hint, trailing: <DropdownMenuPrimitive.RadioItemIndicator><BulletIcon size={16} /></DropdownMenuPrimitive.RadioItemIndicator> }
  return <DropdownMenuPrimitive.RadioItem {...props} data-slot="dropdown-menu-radio-item" {...menuRowAttributes(data)}><MenuRowContent {...data} /></DropdownMenuPrimitive.RadioItem>
}

const DropdownMenuLabel = ({ children, inset: _inset, ...props }: Omit<React.ComponentProps<typeof DropdownMenuPrimitive.GroupLabel>, 'className' | 'style'> & { inset?: boolean }) =>
  <DropdownMenuPrimitive.GroupLabel {...props} data-slot="dropdown-menu-label" data-menu-group="">{children}</DropdownMenuPrimitive.GroupLabel>
const DropdownMenuSeparator = (props: Omit<React.ComponentProps<typeof DropdownMenuPrimitive.Separator>, 'className' | 'style'>) =>
  <DropdownMenuPrimitive.Separator {...props} data-slot="dropdown-menu-separator" data-menu-separator="" />

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

const DropdownMenuSubTrigger = ({ children, icon, hint, ...props }: Omit<React.ComponentProps<typeof DropdownMenuPrimitive.SubmenuTrigger>, 'children' | 'className' | 'style'> & { children?: React.ReactNode; icon?: React.ReactNode; hint?: React.ReactNode }) => {
  const data = { label: children, icon, hint, trailing: <ChevronIcon size={16} /> }
  return <DropdownMenuPrimitive.SubmenuTrigger {...props} data-slot="dropdown-menu-sub-trigger" {...menuRowAttributes(data)}><MenuRowContent {...data} /></DropdownMenuPrimitive.SubmenuTrigger>
}

const DropdownMenuSubContent = ({ wide = true, icons = 'none', align = 'start', side = 'right', sideOffset = 0, collisionAvoidance, sticky, children, ...props }:
  DropdownContentProps & Pick<React.ComponentProps<typeof DropdownMenuPrimitive.Positioner>, 'collisionAvoidance' | 'sticky'> & { icons?: MenuIcons; wide?: boolean }) =>
  <DialogFormContext.Provider value={false}><DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Positioner align={align} side={side} sideOffset={sideOffset} collisionAvoidance={collisionAvoidance} sticky={sticky} className="z-(--hd-z-popover)">
      <DropdownMenuPrimitive.Popup {...props} data-slot="dropdown-menu-sub-content" data-popup-kind={wide ? 'wide-menu' : 'menu'} data-menu-icons={icons} className={cn(floatingMotion, SURFACE_FOCUS)}>
        <MenuPresentation icons={icons} wide={wide}>{children}</MenuPresentation>
      </DropdownMenuPrimitive.Popup>
    </DropdownMenuPrimitive.Positioner>
  </DropdownMenuPrimitive.Portal></DialogFormContext.Provider>

const DropdownMenuCheckboxControl = DropdownMenuPrimitive.CheckboxItem
const DropdownMenuSubControl = DropdownMenuPrimitive.SubmenuTrigger

export {
  DropdownMenuCheckboxControl,
  DropdownMenuSubControl,
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
