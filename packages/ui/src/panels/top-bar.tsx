import { CaretIcon } from '../components/Icons'
import { TerminalMenuItem } from '../components/TerminalToggle'
import { createContext, useContext, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { TopBar, PageOptions, Popover, type TopBarProps, type TopBarAction } from '../design'
export type ViewSlots = Pick<TopBarProps, 'verb' | 'view'> & { readonly more?: readonly TopBarAction[] }
type Entry = {
  readonly base?: TopBarProps
  readonly view?: ViewSlots
  readonly more?: TopBarProps['more']
  readonly details?: ReactNode
}
type Published = { readonly value: Entry; readonly tokens: Partial<Record<keyof Entry, object>> }
const registry = () => {
  let entries = new Map<string, Published>()
  const claims = new Map<string, Partial<Record<keyof Entry, object>>>()
  const listeners = new Set<() => void>()
  const emit = () => { for (const listener of listeners) listener() }
  const publish = <K extends keyof Entry>(owner: string, part: K, value: Entry[K], token: object): void => {
    if (claims.get(owner)?.[part] !== token) return
    const before = entries.get(owner)
    if (before?.tokens[part] === token && before.value[part] === value) return
    entries = new Map(entries).set(owner, {
      value: { ...before?.value, [part]: value }, tokens: { ...before?.tokens, [part]: token },
    })
    emit()
  }
  const remove = (owner: string, part: keyof Entry, token: object): void => {
    const before = entries.get(owner)
    if (before?.tokens[part] !== token) return
    const value = { ...before.value }, tokens = { ...before.tokens }
    delete value[part]; delete tokens[part]
    entries = new Map(entries)
    if (Object.keys(tokens).length) entries.set(owner, { value, tokens })
    else entries.delete(owner)
    emit()
  }
  return { claim: (owner: string, part: keyof Entry, token: object) => {
    claims.set(owner, { ...claims.get(owner), [part]: token })
  }, publish, remove, subscribe: (fn: () => void) => {
    listeners.add(fn); return () => { listeners.delete(fn) }
  }, getSnapshot: () => entries }
}
const emptyRegistry = registry()
const Context = createContext<ReturnType<typeof registry> | null>(null)
export const TopBarProvider = ({ children }: { children: ReactNode }) => {
  const value = useMemo(registry, [])
  return <Context.Provider value={value}>{children}</Context.Provider>
}
const usePart = <K extends keyof Entry>(owner: string, part: K, value: Entry[K], enabled: boolean): void => {
  const source = useContext(Context)
  const token = useRef<object>({})
  useLayoutEffect(() => {
    const identity = token.current
    if (enabled) source?.claim(owner, part, identity)
    return () => source?.remove(owner, part, identity)
  }, [source, owner, part, enabled])
  useLayoutEffect(() => {
    if (enabled) source?.publish(owner, part, value, token.current)
  }, [source, owner, part, value, enabled])
}
export const useTopBar = (owner: string, slots: TopBarProps, enabled = true): void => usePart(owner, 'base', slots, enabled)
export const useTopBarView = (owner: string, slots: ViewSlots, enabled = true): void => usePart(owner, 'view', slots, enabled)
export const useTopBarMore = (owner: string, rows: TopBarProps['more'], enabled = true): void => usePart(owner, 'more', rows, enabled)
export const useWorkDetails = (owner: string, body: ReactNode, enabled = true): void => usePart(owner, 'details', body, enabled)
export const useRegisteredOwner = (owner: string): boolean => {
  const source = useContext(Context)
  if (!source) throw new Error('useRegisteredOwner requires TopBarProvider')
  return useSyncExternalStore(source.subscribe,
    () => source.getSnapshot().get(owner)?.value.base !== undefined, () => false)
}
export const WorkDetailsOutlet = ({ owner }: { owner: string }) => {
  const source = useContext(Context)
  if (!source) throw new Error('WorkDetailsOutlet requires TopBarProvider')
  const entries = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
  return entries.get(owner)?.value.details ?? null
}
/** A view's choices live in its body's first row, under the permanent bar. */
export const WorkViewControlsOutlet = ({ owner, choices = [] }: { owner: string; choices?: import('../design').PageOption[] }) => {
  const source = useContext(Context) ?? emptyRegistry
  const entries = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
  const slots = entries.get(owner)?.value.view
  return <PageOptions choices={choices} actionLast action={slots?.verb ? { label: slots.verb.label, icon: slots.verb.icon, disabled: slots.verb.disabled || undefined, run: slots.verb.run } : undefined}
    read={slots?.view && !slots.view.disabled ? <Popover narrowed={slots.view.narrowed} title={slots.view.label ?? 'View'} aria-label={slots.view.label ?? 'View'} label={<>{slots.view.label ?? 'View'}<CaretIcon /></>} icons="none">{close => slots.view?.content(close)}</Popover> : undefined} />
}
export const TopBarOutlet = ({ owner, fallback, rightColumnWidth }: { owner: string; fallback: TopBarProps; rightColumnWidth?: TopBarProps['rightColumnWidth'] }) => {
  const source = useContext(Context)
  if (!source) throw new Error('TopBarOutlet requires TopBarProvider')
  const entries = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
  const current = entries.get(owner)?.value
  const base = current?.base ?? fallback
  return <TopBar {...base} rightColumnWidth={rightColumnWidth ?? base.rightColumnWidth} verb={base.verb}
    view={undefined}
    more={close => <>{base.more(close)}{current?.more?.(close)}{base.terminal && <TerminalMenuItem close={close} />}</>} extraMore={current?.view?.more} />
}
