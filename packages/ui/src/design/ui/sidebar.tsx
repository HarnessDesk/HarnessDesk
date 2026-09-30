import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'

import { cn } from '@/lib/utils'

/*
 * Vendored from shadcn/ui's Base UI Sidebar grammar, adapted to the desk's
 * workbench. The workbench already owns width, collapse, resizing and the
 * narrow-window floating state; a second provider, shortcut, rail or Sheet
 * would give one sidebar two owners. This file supplies its presentational
 * parts, and leaves the outer column and its state to the workbench.
 *
 * Menu rows keep one measure at every size and density. The trailing action
 * overlays the badge or state mark in the same fixed slot, so hover never
 * takes width from the label. The app's document rule draws the one focus ring.
 */

const sidebarMenuTrailingSlotClass =
  'sidebar-menu-trailing-slot absolute end-(--hd-space-1) top-1/2 z-10 inline-flex size-(--hd-icon-target) -translate-y-1/2 items-center justify-center rounded-md text-sidebar-foreground transition-colors'

const SidebarGroup = ({ className, ...props }: React.ComponentProps<'section'>) => (
  <section data-slot="sidebar-group" data-sidebar="group" className={cn('relative flex w-full min-w-0 flex-col px-(--hd-space-2)', className)} {...props} />
)

const SidebarGroupContent = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div data-slot="sidebar-group-content" data-sidebar="group-content" className={cn('min-w-0 text-sm', className)} {...props} />
)

const SidebarMenu = ({ className, nested = false, horizontal = false, ...props }: React.ComponentProps<'ul'> & { nested?: boolean; horizontal?: boolean }) => (
  <ul
    data-slot="sidebar-menu"
    data-sidebar="menu"
    data-nested={nested ? 'true' : undefined}
    className={cn(
      'flex w-full min-w-0 gap-(--hd-space-0-5)',
      horizontal ? 'flex-row items-center gap-(--hd-space-1) px-(--hd-space-2)' : 'flex-col',
      nested && 'ms-5 border-s border-sidebar-border ps-(--hd-space-2)',
      className,
    )}
    {...props}
  />
)

const SidebarMenuItem = ({ className, ...props }: React.ComponentProps<'li'>) => (
  <li data-slot="sidebar-menu-item" data-sidebar="menu-item" className={cn('group/menu-item relative min-w-0', className)} {...props} />
)

const sidebarMenuButtonVariants = cva(
  'peer/menu-button flex w-full min-w-0 items-center gap-(--hd-space-2) overflow-hidden rounded-(--hd-nav-radius) ps-(--hd-space-2) text-left text-base text-sidebar-foreground transition-colors hover:bg-sidebar-accent focus-visible:bg-sidebar-accent active:bg-sidebar-accent disabled:pointer-events-none disabled:opacity-50 data-[active=true]:bg-(--hd-sidebar-selected) data-[active=true]:text-[var(--hd-sidebar-selected-foreground,var(--hd-foreground))] data-[active=true]:[&_[data-slot=text]]:text-[var(--hd-sidebar-selected-foreground,var(--hd-foreground))] data-[active=true]:[&_[data-role=meta]]:text-[var(--hd-sidebar-selected-muted-foreground,var(--hd-muted-foreground))] [&>svg]:size-4 [&>svg]:shrink-0',
  {
    variants: {
      size: {
      sm: 'min-h-(--hd-nav-h) h-(--hd-nav-h)',
        default: 'h-(--hd-nav-h)',
        lg: 'h-(--hd-control-h-lg)',
      },
    },
    defaultVariants: { size: 'default' },
  },
)

type SidebarMenuButtonVariants = VariantProps<typeof sidebarMenuButtonVariants>
type SidebarMenuButtonProps = Omit<React.ComponentProps<'button'>, 'children'> &
  SidebarMenuButtonVariants & {
    children?: React.ReactNode
    icon?: React.ReactNode
    iconSize?: 'default' | 'lg'
    label?: React.ReactNode
    trailingOverlay?: boolean
    isActive?: boolean
    trailingActions?: 1 | 2
  }

const SidebarMenuButton = ({
  className,
  size = 'default',
  icon,
  iconSize = 'default',
  label,
  trailingOverlay = false,
  children,
  isActive = false,
  trailingActions = 1,
  type = 'button',
  ...props
}: SidebarMenuButtonProps) => (
  <button
    type={type}
    data-slot="sidebar-menu-button"
    data-sidebar="menu-button"
    data-size={size}
    data-active={isActive ? 'true' : undefined}
    className={cn(sidebarMenuButtonVariants({ size }), className)}
    {...props}
  >
    {icon === undefined ? null : <span data-slot="sidebar-menu-icon" data-size={iconSize} className={cn('inline-flex shrink-0 items-center justify-center', iconSize === 'lg' ? 'size-6' : 'size-4')}>{icon}</span>}
    <span data-slot="sidebar-menu-label" className={cn('block min-w-0 flex-1 truncate', (trailingOverlay || trailingActions === 2) && 'sidebar-menu-label-fade [mask-image:linear-gradient(to_right,black_calc(100%-var(--hd-space-8)),transparent)]')}>{label ?? children}</span>
  </button>
)

type SidebarMenuActionProps = React.ComponentProps<'button'> & { showOnHover?: boolean }

const SidebarMenuAction = ({ className, showOnHover = false, type = 'button', ...props }: SidebarMenuActionProps) => (
  <button
    type={type}
    data-slot="sidebar-menu-action"
    data-sidebar="menu-action"
    className={cn(
      sidebarMenuTrailingSlotClass,
      'bg-sidebar hover:bg-sidebar-accent focus-visible:bg-sidebar-accent',
      showOnHover && 'pointer-events-none opacity-0 group-hover/menu-item:pointer-events-auto group-hover/menu-item:opacity-100 group-focus-within/menu-item:pointer-events-auto group-focus-within/menu-item:opacity-100 data-[state=open]:pointer-events-auto data-[state=open]:opacity-100 data-[popup-open]:pointer-events-auto data-[popup-open]:opacity-100',
      className,
    )}
    {...props}
  />
)

const SidebarMenuBadge = ({ className, ...props }: React.ComponentProps<'span'>) => (
  <span
    data-slot="sidebar-menu-badge"
    data-sidebar="menu-badge"
    className={cn(sidebarMenuTrailingSlotClass, 'pointer-events-none whitespace-nowrap px-(--hd-space-1) text-xs tabular-nums', className)}
    {...props}
  />
)

export {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
}
