// packages/ui/src/panels/destination-page.tsx
import { createContext, useContext, type ReactNode } from 'react'
import type { TopBarProps } from '../design'
import { useTopBar } from './top-bar'
import { useSnapshot } from '../state/context'
import { sidebarPlacement } from '../state/workbench'
import { WindowControls } from '../components/WindowControls'
const PageContext = createContext<{ readonly owner: string; readonly active: boolean } | null>(null)
export const DestinationPageScope = ({ owner, active, children }: {
  readonly owner: string; readonly active: boolean; readonly children: ReactNode
}) => <PageContext.Provider value={{ owner, active }}>{children}</PageContext.Provider>
export const useDestinationPage = (): { readonly owner: string; readonly active: boolean } => {
  const scope = useContext(PageContext)
  if (!scope) throw new Error('Page requires DestinationPageScope')
  return scope
}
export const useDestinationActive = (): boolean => useDestinationPage().active
export const DestinationBar = ({ more = () => null, ...slots }: Omit<TopBarProps,
  'more' | 'lead' | 'corner' | 'tools' | 'view' | 'rightColumnWidth'> & { readonly more?: TopBarProps['more'] }) => {
  const scope = useDestinationPage(), snapshot = useSnapshot()
  const away = sidebarPlacement(snapshot) !== 'column'
  useTopBar(scope.owner, { ...slots, lead: away ? <WindowControls /> : undefined, corner: away, more }, scope.active)
  return null
}
