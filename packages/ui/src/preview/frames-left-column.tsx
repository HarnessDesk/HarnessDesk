import { LeftColumnBoard } from '../design/explorer/boards-compositions'
import { FRAME } from '../design'
import { useTheme } from '../state/theme'
export const LeftColumnProbe = () => {
  useTheme()
  return <div data-frame-id="frame-wall" data-destination="left-column-probe"
  style={{ width: FRAME.sidebar.width, height: '100vh' }}><LeftColumnBoard /></div>
}


import { LeftColumnWorkBoard } from '../design/explorer/boards-compositions'
export const LeftColumnWorkProbe = () => {
  useTheme()
  return <div data-frame-id="frame-wall" data-destination="left-work-pattern"
    style={{ width: FRAME.sidebar.width, height: '100vh' }}><LeftColumnWorkBoard /></div>
}

import { SettingsNavigationBoard } from '../design/explorer/boards-compositions'
export const SettingsNavigationProbe = () => {
  useTheme()
  return <div data-frame-id="frame-wall" data-destination="settings-middle" className="flex h-screen min-h-0 flex-col overflow-hidden"
    style={{ width: FRAME.sidebar.width }}><SettingsNavigationBoard /></div>
}
