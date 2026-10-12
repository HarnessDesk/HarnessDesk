import { forwardRef, type ReactNode, type HTMLAttributes, type CSSProperties } from 'react'
import { WorkbenchCanvas, WorkbenchRail, DockPanel } from './DockPanel'
import styles from './FixedShell.module.css'
import { FRAME } from '../frame'

export interface FixedShellProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  readonly viewportWidth: number
  readonly left: ReactNode
  readonly top: ReactNode
  readonly main: ReactNode
  readonly right: ReactNode
  readonly bottom: ReactNode
  readonly leftFloating: boolean
  readonly panelFloating: boolean
  readonly leftOpen: boolean
  readonly rightOpen: boolean
  readonly bottomOpen: boolean
  readonly children?: ReactNode
}
/** Five stable regions: folding and closing affect geometry, never body identity. */
export const FixedShell = forwardRef<HTMLDivElement, FixedShellProps>(({ viewportWidth, left, top, main, right, bottom,
  leftFloating, panelFloating, leftOpen, rightOpen, bottomOpen, children, className, style, ...props }, ref) => <WorkbenchCanvas {...props} ref={ref}
    style={{ '--frame-window-width': `${viewportWidth}px`, '--frame-reading-min': `${FRAME.main.min}px`, '--frame-right-min': `${FRAME.rightPanel.min}px`, '--frame-canvas-gutter': `${FRAME.page.canvasGutter}px`, '--frame-right-max': `${FRAME.rightPanel.max}px`, ...style } as CSSProperties}
    data-slot="fixed-shell" data-left-floats={leftFloating} data-panel-floats={panelFloating}
    data-left-open={leftOpen} data-right-open={rightOpen} data-bottom-open={bottomOpen} className={`${styles.shell} ${className ?? ''}`}>
  {children}
  <WorkbenchRail data-frame-region="left" className={styles.left} inert={!leftOpen}>{left}</WorkbenchRail>
  <div data-frame-region="top" className={styles.top}>{top}</div>
  <div data-frame-region="main" className={styles.main}>{main}</div>
  <DockPanel data-slot="frame-panel" data-frame-region="right" edge="left" rule={false} floating={panelFloating} className={styles.right} inert={!rightOpen}>{right}</DockPanel>
  <DockPanel data-slot="frame-panel" data-frame-region="bottom" edge="top" rule={false} className={styles.bottom} inert={!bottomOpen}>{bottom}</DockPanel>
</WorkbenchCanvas>)
FixedShell.displayName = 'FixedShell'

/** A notice portal contributes only its Banner's height, including in flex main. */
export const ShellNoticeHost = forwardRef<HTMLDivElement>((_, ref) => <div ref={ref} data-shell-host="main-notice" className="contents" />)
ShellNoticeHost.displayName = 'ShellNoticeHost'
