import { DropdownExample } from '../design/catalog/popup-examples'
import { MenuExample } from '../design/catalog/popup-examples'
export const PopupWall = () => {
  const one = new URLSearchParams(location.search).get('popup')
  if (one === 'dropdown-none' || one === 'dropdown-icons') return <div className="fixed left-(--hd-sidebar-width) top-(--hd-bar-h)"><DropdownExample icons={one === 'dropdown-icons' ? 'all' : 'none'} /></div>
  return <div className="fixed left-(--hd-sidebar-width) top-(--hd-bar-h)">{one === 'menu-icons' ? <MenuExample /> : one === 'menu-none' ? <MenuExample icons="none" /> : null}</div>
}
