import { execFileSync } from 'node:child_process'
import { hostname } from 'node:os'

/** Read the Mac's user-facing ComputerName; never writes an OS name. */
export function systemDeskName({ platform = process.platform, read = execFileSync, fallback = hostname } = {}) {
  if (platform === 'darwin') {
    try {
      const name = read('/usr/sbin/scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 1000, maxBuffer: 1024 }).trim()
      if (name && name.length <= 80) return name
    } catch { /* Headless or unavailable system configuration uses the hostname. */ }
  }
  return fallback().slice(0, 80) || 'This desk'
}
