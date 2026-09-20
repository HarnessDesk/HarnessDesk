import { forwardRef, type ComponentProps } from 'react'

import { cn } from '@/lib/utils'

import { DialogPopup } from '../ui/dialog'

/**
 * The full-window destination shell shared by Settings and Dashboard.
 * Base UI still owns focus and modality; this pattern owns the window ground
 * and the two plates that meet inside it.
 */
export const AppWindowSurface = forwardRef<HTMLDivElement, ComponentProps<typeof DialogPopup> & { modal?: boolean }>(
  ({ className, modal, ...props }, ref) => (
    <DialogPopup
      ref={ref}
      data-slot="app-window"
      aria-modal={modal || undefined}
      className={cn('bg-(--hd-card) outline-none', className)}
      {...props}
    />
  ),
)
AppWindowSurface.displayName = 'AppWindowSurface'

export const AppWindowRail = ({ className, ...props }: ComponentProps<'nav'>) => (
  <nav
    data-slot="app-window-nav"
    className={cn('bg-(--hd-sidebar)', className)}
    {...props}
  />
)

export const AppWindowRailTop = ({ className, ...props }: ComponentProps<'div'>) => (
  <div
    data-slot="app-window-rail-top"
    className={cn('px-3 pt-(--hd-titlebar-height) pb-2', className)}
    {...props}
  />
)

export const AppWindowRailScroll = ({ className, ...props }: ComponentProps<'div'>) => (
  <div
    data-slot="app-window-rail-scroll"
    className={cn('px-3 pt-1.5 pb-3', className)}
    {...props}
  />
)

export const AppWindowPage = ({ className, ...props }: ComponentProps<'div'>) => (
  <div
    data-slot="app-window-page"
    className={cn(
      'px-(--hd-space-8) pt-[max(var(--hd-space-6),var(--hd-titlebar-height))] pb-(--hd-space-10)',
      className,
    )}
    {...props}
  />
)
