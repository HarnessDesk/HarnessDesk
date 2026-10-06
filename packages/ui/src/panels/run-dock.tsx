import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { useSnapshot } from '../state/context'
import { PanelEmpty } from '../design'
import { RunInspector, type RunInspectorProps } from '../components/RunInspector'
import { RunSteps } from '../components/RunSteps'
import type { ComponentProps } from 'react'

export interface RunDockContent {
  readonly inspector: RunInspectorProps
  readonly steps: ComponentProps<typeof RunSteps>
}
const registry = () => {
  let content = new Map<string, RunDockContent>()
  const producers = new Map<string, object>()
  const listeners = new Set<() => void>()
  const collapsedOnLeave = new Set<string>()
  const returnTabs = new Map<string, { area: 'right' | 'bottom' | 'sidebar'; id: string }>()
  return {
    getSnapshot: () => content,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    markCollapsedOnLeave: (owner: string) => { collapsedOnLeave.add(owner) },
    takeCollapsedOnLeave: (owner: string) => {
      const collapsed = collapsedOnLeave.delete(owner)
      return collapsed
    },
    rememberReturnTab: (owner: string, tab: { area: 'right' | 'bottom' | 'sidebar'; id: string } | null) => {
      if (tab) returnTabs.set(owner, tab)
      else returnTabs.delete(owner)
    },
    getReturnTab: (owner: string) => returnTabs.get(owner) ?? null,
    clearReturnTab: (owner: string) => { returnTabs.delete(owner) },
    isPublishedBy: (owner: string, producer: object) => producers.get(owner) === producer,
    publish: (owner: string, next: RunDockContent, producer: object) => {
      content = new Map(content).set(owner, next)
      producers.set(owner, producer)
      for (const listener of listeners) listener()
      return () => {
        if (content.get(owner) !== next) return
        content = new Map(content)
        content.delete(owner)
        producers.delete(owner)
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
