import { useSyncExternalStore } from 'react'
const held = new Set<symbol>()
const listeners = new Set<() => void>()
const emit = () => { for (const listener of listeners) listener() }
export const menusOpen = (): boolean => held.size > 0
export const registerMenu = (id: symbol): (() => void) => {
  const before = menusOpen()
  held.add(id)
  if (before !== menusOpen()) emit()
  return () => {
    const before = menusOpen()
    held.delete(id)
    if (before !== menusOpen()) emit()
  }
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export const useMenusOpen = (): boolean => useSyncExternalStore(subscribe, menusOpen, () => false)
