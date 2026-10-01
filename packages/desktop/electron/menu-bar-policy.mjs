import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

const canonicalPath = (path) => {
  try {
    return realpathSync(path)
  } catch {
    // A home that does not exist yet (a first launch) or cannot be read is
    // compared as written: deciding about a menu bar item never stops a launch.
    return resolve(path)
  }
}

/** Whether this shell should create its macOS menu bar status item, and why. */
export const menuBarItemDecision = ({ stateDir, defaultDir, env }) => {
  const override = env?.['HARNESSDESK_MENU_BAR']
  if (override === 'on' || override === '1') return { show: true, reason: 'enabled by HARNESSDESK_MENU_BAR' }
  if (override === 'off' || override === '0') return { show: false, reason: 'disabled by HARNESSDESK_MENU_BAR' }
  if (canonicalPath(stateDir) === canonicalPath(defaultDir)) return { show: true, reason: 'default home' }
  return { show: false, reason: 'home is not the default' }
}

export const showsMenuBarItem = (options) => menuBarItemDecision(options).show
