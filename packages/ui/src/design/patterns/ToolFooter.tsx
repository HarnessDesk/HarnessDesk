import { createContext, useContext, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { Text } from './Settings'
import { SectionFooter } from '../ui/section'

export interface ToolFoot { readonly left: ReactNode; readonly right: ReactNode }
const createFeet = () => {
  let entries = new Map<string, { value: ToolFoot; token: object }>()
  const listeners = new Set<() => void>()
  const emit = () => { for (const listener of listeners) listener() }
  return {
    getSnapshot: () => entries,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    publish: (id: string, value: ToolFoot, token: object) => {
      const before = entries.get(id)
      if (before?.token === token && before.value.left === value.left && before.value.right === value.right) return
      entries = new Map(entries).set(id, { value, token }); emit()
    },
    remove: (id: string, token: object) => {
      if (entries.get(id)?.token !== token) return
      entries = new Map(entries); entries.delete(id); emit()
    },
  }
}
const Feet = createContext<ReturnType<typeof createFeet> | null>(null)
const FootId = createContext<string | null>(null)
export const ToolFooterProvider = ({ children }: { children: ReactNode }) => {
  const source = useMemo(createFeet, [])
  return <Feet.Provider value={source}>{children}</Feet.Provider>
}
export const ToolFooterScope = ({ id, children }: { id: string; children: ReactNode }) =>
  <FootId.Provider value={id}>{children}</FootId.Provider>
export const ToolFooterPublisher = ({ left, right }: ToolFoot) => {
  const source = useContext(Feet), id = useContext(FootId), token = useRef<object>({})
  useLayoutEffect(() => { if (source && id) source.publish(id, { left, right }, token.current) }, [source, id, left, right])
  useLayoutEffect(() => {
    const identity = token.current
    return () => { if (source && id) source.remove(id, identity) }
  }, [source, id])
  return !source || !id ? <SectionFooter variant="facts" ruled={false} data-slot="content-footer">
    <Text role="meta">{left}</Text><span className="flex-1" /><Text role="meta">{right}</Text>
  </SectionFooter> : null
}
export const ToolFooterOutlet = ({ id }: { id: string | null }) => {
  const source = useContext(Feet)
  if (!source) throw new Error('ToolFooterOutlet requires ToolFooterProvider')
  const entries = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
  const foot = id ? entries.get(id)?.value : undefined
  if (!foot) return null
  return <SectionFooter variant="facts" data-slot="tool-footer">
    <Text role="meta">{foot.left}</Text><span className="flex-1" /><Text role="meta">{foot.right}</Text>
  </SectionFooter>
}
