import { useState, useLayoutEffect, useRef, type ReactNode, forwardRef, type ComponentProps, type CSSProperties } from 'react'

import { cn } from '@/lib/utils'

import { DialogPopup } from '../ui/dialog'
import { PanelSeam, RailSection } from './DockPanel'
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
        gridTemplateRows: `${FRAME.bar.height}px minmax(0, 1fr) ${FRAME.statusBar.height}px` } as CSSProperties}
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

import frameStyles from './AppWindow.module.css'

export const AppWindowLeftFrame = ({ left, top, body, status, placement, width, onWidth, onCloseFloat, native = false }: {
  left: ReactNode; top: ReactNode; body: ReactNode; status: ReactNode
  placement: 'column' | 'floating' | 'away'; native?: boolean; width: number; onWidth: (width: number) => void; onCloseFloat: () => void
}) => {
  const [live, setLive] = useState<number | null>(null)
  const leftRef = useRef<HTMLElement>(null)
  const saved = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => setLive(null), [width])
  useLayoutEffect(() => {
    if (placement === 'floating') {
      saved.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      leftRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    } else if (saved.current) {
      // Restore after the placement commit, when the active bar is mounted.
      const frame = leftRef.current?.closest('[data-app-window-left-frame]')
      const previous = saved.current
      const target = previous.isConnected && frame?.contains(previous) && !previous.closest('[hidden], [inert]')
        ? previous : frame?.querySelector<HTMLButtonElement>('[data-slot="top-bar"] button[aria-label="Show sidebar"]')
      target?.focus({ preventScroll: true })
      saved.current = null
    }
  }, [placement])
  const size = live ?? width
  return <div data-app-window-left-frame className={frameStyles.leftFrame}
    data-placement={placement} data-native={native ? '' : undefined} style={{ '--window-left-width': `${size}px`, '--window-status-height': `${FRAME.statusBar.height}px` } as CSSProperties}
    onKeyDown={event => {
      if (placement !== 'floating' || event.key !== 'Tab' || event.defaultPrevented) return
      const nodes = [...(leftRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href], [tabindex="0"]') ?? [])]
        .filter(node => node.tabIndex >= 0 && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden' && !node.closest('[hidden], [inert]'))
      const first = nodes[0], last = nodes[nodes.length - 1]
      if (!first || !last) return
      if (event.shiftKey && (document.activeElement === first || !leftRef.current?.contains(document.activeElement))) {
        event.preventDefault(); last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !leftRef.current?.contains(document.activeElement))) {
        event.preventDefault(); first.focus()
      }
    }}
    onPointerDownCapture={event => {
      if (placement !== 'floating' || leftRef.current?.contains(event.target as Node)) return
      // Popups render through portals inside this frame's React boundary.
      if (event.target instanceof Element && event.target.closest('[data-popup-kind], [data-slot="popover-popup"]')) return
      event.preventDefault(); event.stopPropagation(); onCloseFloat()
    }}>
    <aside ref={leftRef} data-app-window-left hidden={placement === 'away'} inert={placement === 'away'} className={frameStyles.left}>
      {left}
      {placement === 'column' && <PanelSeam orientation="vertical" label="Resize the sidebar" direction={1}
        size={width} min={FRAME.sidebar.min} max={FRAME.sidebar.max}
        onResize={setLive} onCancel={() => setLive(null)} onCommit={next => { onWidth(next); setLive(null) }}
        onDoubleClick={() => onWidth(FRAME.sidebar.width)} />}
    </aside>
    <div className={frameStyles.top}>{top}</div>
    <div className={frameStyles.body}>{body}</div>
    <div className={frameStyles.status}>{status}</div>
  </div>
}
