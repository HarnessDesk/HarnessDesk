import { createContext, useContext, type ReactNode } from 'react'

export type MenuIcons = 'all' | 'none'
export interface MenuRowData {
  readonly label: ReactNode
  readonly hintId?: string
  readonly icon?: ReactNode
  readonly hint?: ReactNode
  readonly trailing?: ReactNode
  readonly badge?: ReactNode
  readonly meter?: ReactNode
}
interface Presentation { readonly icons: MenuIcons; readonly wide: boolean }
const PresentationContext = createContext<Presentation>({ icons: 'none', wide: false })
export const MenuPresentation = ({ icons, wide = false, children }: { readonly icons: MenuIcons; readonly wide?: boolean; readonly children: ReactNode }) =>
  <PresentationContext.Provider value={{ icons, wide }}>{children}</PresentationContext.Provider>
export const useMenuPresentation = (): Presentation => useContext(PresentationContext)
export const menuRowAttributes = (data: MenuRowData) => ({
  'data-menu-row': '',
  'data-has-hint': data.hint == null || data.hint === false || data.hint === '' ? undefined : '',
  'data-has-meter': data.meter == null ? undefined : '',
})
export const MenuRowContent = ({ label, icon, hint, hintId, trailing, badge, meter }: MenuRowData) => {
  const { icons } = useMenuPresentation()
  if (icons === 'all' && (icon == null || icon === false)) throw new Error('Every row in an icon menu needs an icon')
  return <>
    {icons === 'all' && <span data-menu-icon="" aria-hidden="true">{icon}</span>}
    <span data-menu-body="">
      <span data-menu-label="">{label}{badge != null && <span data-menu-badge="">{badge}</span>}</span>
      {hint != null && hint !== false && hint !== '' && <span data-menu-hint="" id={hintId}>{hint}</span>}
      {meter != null && <span data-menu-meter="">{meter}</span>}
    </span>
    {trailing != null && <span data-menu-trailing="">{trailing}</span>}
  </>
}
