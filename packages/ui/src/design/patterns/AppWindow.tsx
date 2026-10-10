import { forwardRef, type ComponentProps, type CSSProperties } from 'react'

import { cn } from '@/lib/utils'

import { DialogPopup } from '../ui/dialog'
import { RailSection } from './DockPanel'
import { FRAME } from '../frame'

/**
 * The full-window destination shell shared by Settings and Dashboard.
 * Base UI still owns focus and modality; this pattern owns the window ground
 * and the two plates that meet inside it.
 */
export const AppWindowSurface = forwardRef<HTMLDivElement, ComponentProps<typeof DialogPopup> & { modal?: boolean; nativeCorner?: boolean }>(
  ({ className, modal, nativeCorner = false, style, ...props }, ref) => (
    <DialogPopup
      ref={ref}
      data-slot="app-window"
      aria-modal={modal || undefined}
      className={cn('bg-(--hd-card) outline-none', className)}
      {...props}
      style={{ ...style, '--titlebar-inset': nativeCorner ? 'var(--hd-titlebar-lights)' : '0px', display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr)',
        gridTemplateRows: `${FRAME.bar.height}px minmax(0, 1fr)` } as CSSProperties}
    />
  ),
)
AppWindowSurface.displayName = 'AppWindowSurface'

/** Work and window destinations share the standing sidebar's top-row origin. */
export const AppWindowTopHost = ({ columnWidth, style, ...props }: ComponentProps<'div'> & { columnWidth: number }) => (
  <div {...props} style={{ ...style, marginInlineStart: columnWidth }} />
)

export const AppWindowRail = ({ className, ...props }: ComponentProps<'nav'>) => (
  <nav
    data-slot="app-window-nav"
    className={cn('bg-(--hd-sidebar)', className)}
    {...props}
  />
)

/** The window rail's head, under the window buttons: the system's rail section. */
export const AppWindowRailTop = (props: ComponentProps<'div'>) => (
  <RailSection stretch="head" density="comfortable" {...props} />
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
      '@max-[720px]/app-window:px-(--hd-space-4) @max-[720px]/app-window:pt-(--hd-space-4)',
      className,
    )}
    {...props}
  />
)

/** Main consumes the window's remaining height; notices precede the retained page. */
export const AppWindowContent = ({ children }: { children: React.ReactNode }) =>
  <div data-slot="app-window-content" className="flex min-h-0 flex-col">{children}</div>
