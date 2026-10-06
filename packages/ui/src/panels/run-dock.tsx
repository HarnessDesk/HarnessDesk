import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { useSnapshot } from '../state/context'
import { PanelEmpty } from '../design'
import { RunInspector, type RunInspectorProps } from '../components/RunInspector'
import { RunSteps } from '../components/RunSteps'
import type { ComponentProps } from 'react'
import type { DockId } from '../state/workbench'

export interface RunDockContent {
  readonly inspector: RunInspectorProps
  readonly steps: ComponentProps<typeof RunSteps>
}
const registry = () => {
  let content = new Map<string, RunDockContent>()
  const listeners = new Set<() => void>()
  const collapsedOnLeave = new Set<DockId>()
  const returnTabs = new Map<DockId, { id: string; collapsed: boolean }>()
  return {
    getSnapshot: () => content,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    markCollapsedOnLeave: (area: DockId) => { collapsedOnLeave.add(area) },
    takeCollapsedOnLeave: (area: DockId) => {
      const collapsed = collapsedOnLeave.delete(area)
      return collapsed
    },
    rememberReturnTab: (area: DockId, tab: { id: string; collapsed: boolean } | null) => {
      if (tab) returnTabs.set(area, tab)
      else returnTabs.delete(area)
    },
    getReturnTab: (area: DockId) => returnTabs.get(area) ?? null,
    clearReturnTab: (area: DockId) => { returnTabs.delete(area) },
    publish: (owner: string, next: RunDockContent) => {
      content = new Map(content).set(owner, next)
      for (const listener of listeners) listener()
      return () => {
        if (content.get(owner) !== next) return
        content = new Map(content)
        content.delete(owner)
        for (const listener of listeners) listener()
      }
    },
  }
}
const RunDockContext = createContext<ReturnType<typeof registry> | null>(null)
/** The mounted Run supplies its reads and actions to the workbench's sibling inspectors.
 * Only the outlets subscribe: publishing must never rerender its own producer.
 * Clearing on unmount prevents another Team from inheriting this Run's actions. */
export const RunDockProvider = ({ children }: { children: ReactNode }) => {
  const value = useMemo(registry, [])
  return <RunDockContext.Provider value={value}>{children}</RunDockContext.Provider>
}
export const useRunDock = () => useContext(RunDockContext)
const EmptyRegistry = registry()
const RunDockView = ({ steps = false }: { steps?: boolean }) => {
  const source = useRunDock() ?? EmptyRegistry
  const contents = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
  const { workbench } = useSnapshot()
  // Dock focus stays with the Run in the main pane; background Teams keep their own records.
  const content = contents.get(workbench.main.focused) ?? contents.get('')
  if (!content) return <PanelEmpty>Open a Team’s Run to read its details and steps.</PanelEmpty>
  return steps ? <RunSteps {...content.steps} /> : <RunInspector {...content.inspector} />
}
export const RunDetailsView = () => <RunDockView />
export const RunStepsView = () => <RunDockView steps />
