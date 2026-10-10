import { MenuExample, WideMenuExample, MeteredMenuExample, InfoCardExample } from '../design/catalog/popup-examples'
export const PopupWall = () => {
  const one = new URLSearchParams(location.search).get('popup')
  return <div className="fixed left-(--hd-sidebar-width) top-(--hd-bar-h)">{one === 'menu-icons' ? <MenuExample /> : one === 'menu-none' ? <MenuExample icons="none" /> : one === 'wide' ? <WideMenuExample /> : one === 'metered' ? <MeteredMenuExample /> : one === 'info' ? <InfoCardExample /> : one === 'info-and-menu' ? <><InfoCardExample /><MenuExample /></> : null}</div>
}
