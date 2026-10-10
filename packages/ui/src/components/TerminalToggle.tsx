import { useSyncExternalStore } from 'react'
import { Button } from '../design'
import { TerminalIcon } from './Icons'
import { terminals } from '../state/workbench'
import { useSnapshot, useStore } from '../state/context'
import type { AppStore } from '../state/store'

/** Pending intent belongs to the store's desk, surviving footer host remounts. */
interface PendingTerminal { operation: symbol | null; listeners: Set<() => void> }
const pendingByStore = new WeakMap<AppStore, PendingTerminal>()
const pendingFor = (store: AppStore) => {
  let pending = pendingByStore.get(store)
  if (!pending) { pending = { operation: null, listeners: new Set() }; pendingByStore.set(store, pending) }
  return pending
}
const publish = (pending: PendingTerminal) => pending.listeners.forEach(listener => listener())
export const TerminalToggle = () => {
  const store = useStore(), snapshot = useSnapshot(), pending = pendingFor(store)
  const opening = useSyncExternalStore(listener => { pending.listeners.add(listener); return () => pending.listeners.delete(listener) },
    () => pending.operation !== null)
  const on = terminals(snapshot.workbench).length > 0 || opening
  return <Button variant="ghost" size="icon-sm" aria-label={on ? 'Close terminal' : 'Open terminal'}
    title={on ? 'Close terminal' : 'Open terminal'} aria-pressed={on} onClick={() => {
      if (on) { pending.operation = null; publish(pending); store.closeTerminalDock(); return }
      const operation = Symbol('terminal-open')
      pending.operation = operation; publish(pending)
      void store.openTerminal().finally(() => {
        if (pending.operation === operation) { pending.operation = null; publish(pending) }
      })
    }}><TerminalIcon /></Button>
}
