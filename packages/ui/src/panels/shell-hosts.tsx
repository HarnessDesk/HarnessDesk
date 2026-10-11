import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { renderShellSlot } from '../design'
import { TopBarOutlet } from './top-bar'
import { WorkTopBar } from './WorkTopBar'
import { ConnectionNotice } from './ConnectionNotice'
import { PaneProvider, useSnapshot } from '../state/context'
import { findPane } from '../state/layout'

type Hosts = { readonly top: HTMLElement | null; readonly main: HTMLElement | null }
const hostsRegistry = () => {
  let hosts = new Map<string, { token: object; nodes: Hosts }>()
  let next = 0
  const claims = new WeakMap<object, Map<string, number>>()
  const latest = new Map<string, number>()
  const listeners = new Set<() => void>()
  const emit = () => { for (const listener of listeners) listener() }
  return {
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    getSnapshot: () => hosts,
    claim: (owner: string, token: object) => {
      const version = ++next, owners = claims.get(token) ?? new Map<string, number>()
      owners.set(owner, version); claims.set(token, owners); latest.set(owner, version)
    },
    publish: (owner: string, token: object, nodes: Hosts) => {
      if (claims.get(token)?.get(owner) !== latest.get(owner)) return
      const current = hosts.get(owner)
      if (current?.token === token && current.nodes.top === nodes.top && current.nodes.main === nodes.main) return
      hosts = new Map(hosts).set(owner, { token, nodes }); emit()
    },
    remove: (owner: string, token: object) => {
      if (hosts.get(owner)?.token !== token) return
      hosts = new Map(hosts); hosts.delete(owner); emit()
    },
  }
}
const HostsContext = createContext<ReturnType<typeof hostsRegistry> | null>(null)
export const ShellHostsProvider = ({ children }: { children: ReactNode }) => {
  const source = useMemo(hostsRegistry, [])
  return <HostsContext.Provider value={source}>{children}</HostsContext.Provider>
}
export const useShellHosts = (owner: string) => {
  const source = useContext(HostsContext)
  const nodes = useRef<Hosts>({ top: null, main: null })
  const token = useRef<object>({})
  const topRef = useCallback((top: HTMLElement | null) => {
    nodes.current = { ...nodes.current, top }
    source?.publish(owner, token.current, nodes.current)
  }, [source, owner])
  const mainRef = useCallback((main: HTMLElement | null) => {
    nodes.current = { ...nodes.current, main }
    source?.publish(owner, token.current, nodes.current)
  }, [source, owner])
  useLayoutEffect(() => {
    const identity = token.current
    source?.claim(owner, identity)
    source?.publish(owner, identity, nodes.current)
    return () => source?.remove(owner, identity)
  }, [source, owner])
  return { topRef, mainRef }
}
export const ShellOutlets = ({ activeOwner, hostOwner }: { activeOwner: string | null; hostOwner?: string }) => {
  const source = useContext(HostsContext), snapshot = useSnapshot()
  if (!source) throw new Error('ShellOutlets requires ShellHostsProvider')
  const hosts = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
  const pane = findPane(snapshot.layout, snapshot.layout.focused)
  const nodes = hosts.get(hostOwner ?? activeOwner ?? 'work')?.nodes
  if (!nodes) return null
  const scope = pane ? { paneId: pane.id, view: pane.view, sessionKey: pane.view.kind === 'conversation' ? pane.view.session : null } : null
  const top = nodes.top && renderShellSlot(activeOwner
    ? <TopBarOutlet owner={activeOwner} fallback={{ place: 'New session', more: () => null }} />
    : <WorkTopBar />, nodes.top)
  const main = nodes.main && renderShellSlot(<ConnectionNotice />, nodes.main)
  return scope ? <PaneProvider scope={scope}>{top}{main}</PaneProvider> : <>{top}{main}</>
}
