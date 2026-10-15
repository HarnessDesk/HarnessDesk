import { useSyncExternalStore } from 'react'
import { Button, MenuItem } from '../design'
import { TerminalIcon } from './Icons'
import { terminals } from '../state/workbench'
import { useSnapshot, useStore } from '../state/context'
import { chordOf, SHORTCUTS } from '../lib/shortcuts'
import { terminalCwdForSnapshot } from '../lib/terminal-scope'
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
/** Menu and keyboard share one pending intent, including a second press during startup. */
export const toggleTerminal = (store: AppStore): void => {
  const snapshot = store.getSnapshot()
  if (snapshot.workbench.navigation.current.kind !== 'work' && !terminalCwdForSnapshot(snapshot)) return
  const pending = pendingFor(store)
  if (terminals(store.getSnapshot().workbench).length > 0 || pending.operation !== null) {
    pending.operation = null; publish(pending); store.closeTerminalDock(); return
  }
  if (!terminalCwdForSnapshot(store.getSnapshot())) return
  const operation = Symbol('terminal-open')
  pending.operation = operation; publish(pending)
  void store.openTerminal().finally(() => {
    if (pending.operation === operation) { pending.operation = null; publish(pending) }
  })
}
const useTerminalToggle = () => {
  const store = useStore(), snapshot = useSnapshot(), pending = pendingFor(store)
  const opening = useSyncExternalStore(listener => { pending.listeners.add(listener); return () => pending.listeners.delete(listener) },
    () => pending.operation !== null)
  return { on: terminals(snapshot.workbench).length > 0 || opening, run: () => toggleTerminal(store) }
}
export const TerminalToggle = () => {
  const { on, run } = useTerminalToggle()
  return <Button variant="ghost" size="icon-sm" aria-label={on ? 'Close terminal' : 'Open terminal'}
    title={on ? 'Close terminal' : 'Open terminal'} aria-pressed={on} onClick={run}><TerminalIcon /></Button>
}
export const TerminalMenuItem = ({ close }: { close: () => void }) => {
  const { on, run } = useTerminalToggle()
  const snapshot = useSnapshot()
  const cwd = terminalCwdForSnapshot(snapshot)
  if (!cwd) return null
  return <MenuItem label="Terminal" icon={<TerminalIcon size={16} />} selected={on}
    shortcut={chordOf(SHORTCUTS.find(one => one.action === 'toggle-terminal')!)}
    onSelect={() => { run(); close() }} />
}
