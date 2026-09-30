import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'

import { cn } from '@/lib/utils'
import { Input, type InputProps } from './input'
import { Separator } from './separator'

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

type SidebarProps = React.ComponentProps<'aside'>

const Sidebar = ({ className, ...props }: SidebarProps) => (
  <aside
    data-slot="sidebar"
    data-sidebar="sidebar"
    className={cn('flex h-full min-h-0 min-w-0 flex-col bg-sidebar text-sidebar-foreground', className)}
    {...props}
  />
)

const SidebarHeader = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div data-slot="sidebar-header" data-sidebar="header" className={cn('flex shrink-0 flex-col gap-(--hd-space-2) p-(--hd-space-2)', className)} {...props} />
)

const SidebarContent = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div
    data-slot="sidebar-content"
    data-sidebar="content"
    className={cn('flex min-h-0 min-w-0 flex-1 flex-col gap-(--hd-space-2) overflow-y-auto overflow-x-hidden', className)}
    {...props}
  />
)

const SidebarFooter = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div data-slot="sidebar-footer" data-sidebar="footer" className={cn('flex shrink-0 flex-col gap-(--hd-space-2) p-(--hd-space-2)', className)} {...props} />
)

const SidebarSeparator = ({ className, ...props }: React.ComponentProps<typeof Separator>) => (
  <Separator
    data-slot="sidebar-separator"
    data-sidebar="separator"
    className={cn('mx-(--hd-space-2) w-auto bg-sidebar-border', className)}
    {...props}
  />
)

const SidebarGroup = ({ className, ...props }: React.ComponentProps<'section'>) => (
  <section data-slot="sidebar-group" data-sidebar="group" className={cn('relative flex w-full min-w-0 flex-col px-(--hd-space-2)', className)} {...props} />
)

const SidebarGroupLabel = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div
    data-slot="sidebar-group-label"
    data-sidebar="group-label"
    className={cn('flex min-h-(--hd-nav-h-group) shrink-0 items-center pe-(--hd-space-8) text-sm text-sidebar-foreground', className)}
    {...props}
  />
)

const SidebarGroupAction = ({ className, type = 'button', ...props }: React.ComponentProps<'button'>) => (
  <button
    type={type}
    data-slot="sidebar-group-action"
    data-sidebar="group-action"
    className={cn('absolute end-(--hd-space-2) top-0 inline-flex size-(--hd-icon-target) items-center justify-center rounded-md text-sidebar-foreground hover:bg-sidebar-accent', className)}
    {...props}
  />
)

const SidebarGroupContent = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div data-slot="sidebar-group-content" data-sidebar="group-content" className={cn('min-w-0 text-sm', className)} {...props} />
)

const SidebarMenu = ({ className, ...props }: React.ComponentProps<'ul'>) => (
  <ul data-slot="sidebar-menu" data-sidebar="menu" className={cn('flex w-full min-w-0 flex-col gap-(--hd-space-0-5)', className)} {...props} />
)

const SidebarMenuItem = ({ className, ...props }: React.ComponentProps<'li'>) => (
  <li data-slot="sidebar-menu-item" data-sidebar="menu-item" className={cn('group/menu-item relative min-w-0', className)} {...props} />
)

const sidebarMenuButtonVariants = cva(
  'peer/menu-button flex w-full min-w-0 items-center gap-(--hd-space-2) overflow-hidden rounded-(--hd-nav-radius) pe-(--hd-space-8) ps-(--hd-space-2) text-left text-base text-sidebar-foreground transition-colors hover:bg-sidebar-accent focus-visible:bg-sidebar-accent active:bg-sidebar-accent disabled:pointer-events-none disabled:opacity-50 data-[active=true]:bg-(--hd-sidebar-selected) data-[active=true]:font-medium [&>svg]:size-4 [&>svg]:shrink-0',
  {
    variants: {
      size: {
        sm: 'h-(--hd-control-h-sm)',
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
    label?: React.ReactNode
    isActive?: boolean
    trailingActions?: 1 | 2
  }

const SidebarMenuButton = ({
  className,
  size = 'default',
  icon,
  label,
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
    className={cn(sidebarMenuButtonVariants({ size }), trailingActions === 2 && 'pe-(--hd-space-16)', className)}
    {...props}
  >
    {icon === undefined ? null : <span data-slot="sidebar-menu-icon" className="inline-flex size-4 shrink-0 items-center justify-center">{icon}</span>}
    <span data-slot="sidebar-menu-label" className="block min-w-0 flex-1 truncate">{label ?? children}</span>
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

type SidebarMenuSkeletonProps = React.ComponentProps<'div'> & { showIcon?: boolean }

const SidebarMenuSkeleton = ({ className, showIcon = false, ...props }: SidebarMenuSkeletonProps) => (
  <div data-slot="sidebar-menu-skeleton" data-sidebar="menu-skeleton" aria-hidden="true" className={cn('flex h-(--hd-nav-h) items-center gap-(--hd-space-2) rounded-(--hd-nav-radius) px-(--hd-space-2)', className)} {...props}>
    {showIcon && <span data-sidebar="menu-skeleton-icon" className="size-4 shrink-0 rounded-sm bg-muted" />}
    <span data-sidebar="menu-skeleton-text" className="h-3 max-w-(--skeleton-width) flex-1 rounded-sm bg-muted" style={{ '--skeleton-width': '66%' } as React.CSSProperties} />
  </div>
)

const SidebarMenuSub = ({ className, ...props }: React.ComponentProps<'ul'>) => (
  <ul data-slot="sidebar-menu-sub" data-sidebar="menu-sub" className={cn('ms-5 flex min-w-0 flex-col gap-(--hd-space-0-5) border-s border-sidebar-border ps-(--hd-space-2)', className)} {...props} />
)

const SidebarMenuSubItem = ({ className, ...props }: React.ComponentProps<'li'>) => (
  <li data-slot="sidebar-menu-sub-item" data-sidebar="menu-sub-item" className={cn('min-w-0', className)} {...props} />
)

type SidebarMenuSubButtonProps = React.ComponentProps<'a'> & { size?: 'sm' | 'md'; isActive?: boolean }

const SidebarMenuSubButton = ({ className, size = 'md', isActive = false, ...props }: SidebarMenuSubButtonProps) => (
  <a
    data-slot="sidebar-menu-sub-button"
    data-sidebar="menu-sub-button"
    data-size={size}
    data-active={isActive}
    className={cn('flex h-(--hd-nav-h) min-w-0 items-center gap-(--hd-space-2) overflow-hidden rounded-(--hd-nav-radius) px-(--hd-space-2) text-base text-sidebar-foreground hover:bg-sidebar-accent active:bg-sidebar-accent data-[active=true]:bg-(--hd-sidebar-selected) [&>svg]:size-4 [&>svg]:shrink-0', className)}
    {...props}
  />
)

const SidebarInput = ({ className, ...props }: InputProps) => (
  <Input
    controlSize="row"
    data-slot="sidebar-input"
    data-sidebar="input"
    className={cn('w-full bg-background shadow-none', className)}
    {...props}
  />
)

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarSeparator,
}
