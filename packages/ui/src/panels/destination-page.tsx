// packages/ui/src/panels/destination-page.tsx
import { createContext, useContext, type ReactNode } from 'react'
import type { TopBarProps } from '../design'
import { useTopBar } from './top-bar'
import { useSnapshot } from '../state/context'
import { sidebarPlacement } from '../state/workbench'
import { terminalCwdForSnapshot } from '../lib/terminal-scope'
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
export const useDestinationActive = (): boolean => useContext(PageContext)?.active ?? true
export const DestinationBar = ({ more = () => null }: Pick<TopBarProps, 'place'> & { readonly more?: TopBarProps['more'] }) => {
  const scope = useDestinationPage(), snapshot = useSnapshot()
  const away = sidebarPlacement(snapshot) !== 'column'
  const settings = snapshot.workbench.navigation.current.kind === 'settings'
  useTopBar(scope.owner, settings
    ? { place: null, more: () => null, terminal: false, lead: away ? <WindowControls history={false} /> : undefined, corner: away }
    : { place: null, terminal: Boolean(terminalCwdForSnapshot(snapshot)), lead: <WindowControls />, corner: away, more }, scope.active)
  return null
}
