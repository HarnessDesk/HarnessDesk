import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

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
export const menuBarItemDecision = ({ stateDir, defaultDir, env, preference }) => {
  // A person's choice in View is stronger than a launcher's defaults. Fresh
  // worker homes still inherit the quiet policy until someone chooses otherwise.
  if (typeof preference === 'boolean') return { show: preference, reason: 'saved user choice' }
  const override = env?.['HARNESSDESK_MENU_BAR']
  if (override === 'on' || override === '1') return { show: true, reason: 'enabled by HARNESSDESK_MENU_BAR' }
  if (override === 'off' || override === '0') return { show: false, reason: 'disabled by HARNESSDESK_MENU_BAR' }
  if (canonicalPath(stateDir) === canonicalPath(defaultDir)) return { show: true, reason: 'default home' }
  return { show: false, reason: 'home is not the default' }
}

export const showsMenuBarItem = (options) => menuBarItemDecision(options).show

/** A broken or absent preference must never prevent the shell from opening. */
export const readMenuBarPreference = (file) => {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'))?.visible
    return typeof value === 'boolean' ? value : undefined
  } catch { return undefined }
}

export const writeMenuBarPreference = (file, visible) => {
  mkdirSync(dirname(file), { recursive: true })
  const pending = `${file}.${process.pid}.tmp`
  writeFileSync(pending, `${JSON.stringify({ visible })}\n`)
  renameSync(pending, file)
}
