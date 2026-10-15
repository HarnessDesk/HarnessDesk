import { useLayoutEffect, useRef, useState } from 'react'
import { App } from '../app/App'
import { useStore } from '../state/context'
import type { PaneView } from '../state/layout'

/** A synthetic Team uses the production shell, including its independent rail
 * and tool pane. Only its store and embedded viewport belong to the preview. */
export const TeamFramePreview = ({ room, view }: { room: string; view?: Extract<PaneView, { kind: 'room' }> }) => {
  const store = useStore()
  useState(() => {
    const snapshot = store.getSnapshot()
    const roomView = view ?? { kind: 'room' as const, room }
    const main = { root: { kind: 'pane' as const, id: 'preview-team-main', view: roomView }, focused: 'preview-team-main', expanded: null }
    Object.assign(snapshot, { layout: main, workbench: { ...snapshot.workbench, main,
      navigation: { current: { kind: 'work', view: roomView }, back: [], forward: [] } },
      activeSessionKey: null, sidebarCollapsed: true, sidebarFloating: false })
    return true
  })
  const viewport = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = viewport.current
    if (!element) return
    const measure = () => {
      const box = element.getBoundingClientRect()
      if (box.width > 0 && box.height > 0) store.setWindowSize(box.width, box.height)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [store])
  return <div ref={viewport} className="h-full min-h-0 overflow-hidden"><App /></div>
}
