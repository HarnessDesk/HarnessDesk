import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Workbench } from '../panels/Workbench'
import { ShellProvider } from '../panels/views'
import { TopBarProvider } from '../panels/top-bar'
import { ShellHostsProvider, ShellOutlets } from '../panels/shell-hosts'
import { useStore } from '../state/context'
import { fixedSubject } from '../state/workbench'
import type { PaneView } from '../state/layout'
import type { AppSnapshot, AppStore } from '../state/store'

/** A synthetic Team uses the production shell, including its independent rail
 * and tool pane. Only its store and embedded viewport belong to the preview. */
type TeamFrameView = Extract<PaneView, { kind: 'room' }>
type Seedable = { patch: (partial: Partial<AppSnapshot>) => void }

/** The layout a Team frame stands on. A store that patches it before mounting keeps it when the
 * snapshot is later replaced; mutating a decorated copy of the snapshot does not. */
export const teamFrameSeed = (snapshot: AppSnapshot, room: string, view?: TeamFrameView, railOpen = true): Partial<AppSnapshot> => {
  const roomView = view ?? { kind: 'room' as const, room }
  const main = { root: { kind: 'pane' as const, id: 'preview-team-main', view: roomView }, focused: 'preview-team-main', expanded: null }
  return { layout: main, workbench: { ...snapshot.workbench, main,
    ...(!railOpen ? { frameTools: { ...snapshot.workbench.frameTools, [fixedSubject(main)!]: { tool: 'details', mode: 'details', open: false, railOpen: false } } } : {}),
    navigation: { current: { kind: 'work', view: roomView }, back: [], forward: [] } },
    activeSessionKey: null, sidebarCollapsed: true, sidebarFloating: false }
}
export const seedTeamFrame = (store: AppStore, room: string, view?: TeamFrameView, railOpen = true) =>
  (store as unknown as Seedable).patch(teamFrameSeed(store.getSnapshot(), room, view, railOpen))

/** A synthetic Team uses the production shell, including its independent rail
 * and tool pane. Only its store and embedded viewport belong to the preview. */
/** `sidebar` fills the left column when the frame opens it; without one the column stays empty, as a frame that never opens it needs. */
export const TeamFramePreview = ({ room, view, railOpen = true, sidebar = null }: { railOpen?: boolean; room: string; view?: TeamFrameView; sidebar?: ReactNode }) => {
  const store = useStore()
  useState(() => {
    Object.assign(store.getSnapshot(), teamFrameSeed(store.getSnapshot(), room, view, railOpen))
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
  return <div ref={viewport} className="h-full min-h-0 overflow-hidden"><ShellProvider actions={{ chooseProject: () => {}, signIn: () => {}, openUsage: () => {}, openRuntimes: () => {}, openAgents: () => {}, reviewImports: () => {} }}>
    <TopBarProvider><ShellHostsProvider><Workbench sidebar={sidebar} /><ShellOutlets activeOwner={null} /></ShellHostsProvider></TopBarProvider>
  </ShellProvider></div>
}
