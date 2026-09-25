import { forwardRef, type ComponentProps } from 'react'

import { cn } from '@/lib/utils'

import { DialogPopup } from '../ui/dialog'
import { RailSection } from './DockPanel'

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

/** The window rail's head, under the window buttons: the system's rail section. */
export const AppWindowRailTop = (props: ComponentProps<'div'>) => (
  <RailSection stretch="head" density="comfortable" corner {...props} />
)

/** The window rail's scrolling list: the system's rail section. */
export const AppWindowRailScroll = (props: ComponentProps<'div'>) => (
  <RailSection stretch="list" density="comfortable" {...props} />
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
