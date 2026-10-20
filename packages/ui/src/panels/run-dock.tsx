import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { usePane } from '../state/context'
import { RunInspector, type RunInspectorProps } from '../components/RunInspector'

export interface RunDockContent { readonly inspector: RunInspectorProps }
const registry = () => {
  let content = new Map<string, RunDockContent>()
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => content,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
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
/** The mounted owner supplies inspection to Details. Only outlets subscribe;
 * identity-checked cleanup cannot remove a newer Run's records and actions. */
export const RunDockProvider = ({ children }: { children: ReactNode }) => {
  const value = useMemo(registry, [])
  return <RunDockContext.Provider value={value}>{children}</RunDockContext.Provider>
}
export const useRunDock = () => useContext(RunDockContext)
const EmptyRegistry = registry()
export const RunDetailsView = ({ inspectionOnly = true }: { inspectionOnly?: boolean }) => {
  const source = useRunDock() ?? EmptyRegistry
  const contents = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
  const owner = usePane()?.paneId ?? ''
  const content = contents.get(owner)
  if (!content || !content.inspector.selectedRow) return null
  return <RunInspector {...content.inspector} inspectionOnly={content.inspector.selectedRow === 'run' ? false : inspectionOnly} />
}
