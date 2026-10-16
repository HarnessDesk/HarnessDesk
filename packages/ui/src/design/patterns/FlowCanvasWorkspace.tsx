import { useLayoutEffect, useRef, useState, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react'
import { FRAME } from '../frame'
import { ToolPaneBody } from '../ui/tool-pane'
import { DockPanel, WorkbenchScrim } from './DockPanel'
import styles from './FlowCanvasWorkspace.module.css'

/** A canvas and its card rail share one containing block below the shell bar. */
export const FlowCanvasWorkspace = ({ main, toolbar, rail, onCloseRail }: {
  readonly main: ReactNode
  readonly toolbar?: ReactNode
  readonly rail?: ReactNode
  readonly onCloseRail: () => void
}) => {
  const element = useRef<HTMLDivElement>(null)
  const mainElement = useRef<HTMLElement>(null)
  const [floating, setFloating] = useState(false)
  const [toolbarClearance, setToolbarClearance] = useState(0)
  useLayoutEffect(() => {
    const measure = () => {
      const width = element.current?.getBoundingClientRect().width ?? 0
      if (width > 0) setFloating(width < FRAME.main.min + FRAME.rightPanel.width)
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    if (element.current) observer?.observe(element.current)
    return () => observer?.disconnect()
  }, [])
  useLayoutEffect(() => {
    const main = mainElement.current
    const controls = main?.querySelector<HTMLElement>('[data-slot="flow-canvas-toolbar"]')
    if (!main || !controls) { setToolbarClearance(0); return }
    const measure = () => setToolbarClearance(Math.max(0, Math.ceil(
      controls.getBoundingClientRect().bottom - main.getBoundingClientRect().top + main.scrollTop,
    )))
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(controls)
    return () => observer?.disconnect()
  }, [toolbar])
  return <div ref={element} data-slot="flow-canvas-workspace" data-rail-floating={floating} className={styles.workspace}
    onKeyDown={event => { if (floating && rail && event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); onCloseRail() } }}>
    <main ref={mainElement} className={styles.main} aria-label="Flow editor" style={{ '--flow-toolbar-clearance': `${toolbarClearance}px` } as CSSProperties}>{toolbar}{main}</main>
    {rail && <>
      {floating && <WorkbenchScrim className={styles.scrim} onClick={onCloseRail} />}
      <aside className={styles.rail} aria-label="Flow details" style={{ width: FRAME.rightPanel.width }}>
        <DockPanel edge="left" floating={floating} className={styles.panel}>{rail}</DockPanel>
      </aside>
    </>}
  </div>
}

/** The graph fills the workspace; callers retain layout data and edit policy. */
export const FlowCanvasSurface = ({ children, className, ...props }: HTMLAttributes<HTMLDivElement>) => <div {...props}
  data-slot="flow-canvas-surface" className={`${styles.surface}${className ? ` ${className}` : ''}`}>{children}</div>

/** Text and ordered forms reserve the toolbar's own band above the shared page inset. */
export const FlowCanvasContent = ({ children }: { readonly children: ReactNode }) => <div data-slot="flow-canvas-content" className={styles.content}><ToolPaneBody inset="page">{children}</ToolPaneBody></div>
