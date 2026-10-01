import { resolve } from 'node:path'

/** Whether this shell should create its macOS menu bar status item. */
export const showsMenuBarItem = ({ stateDir, defaultDir, env }) => {
  const override = env?.['HARNESSDESK_MENU_BAR']
  if (override === 'on' || override === '1') return true
  if (override === 'off' || override === '0') return false
  return resolve(stateDir) === resolve(defaultDir)
}
