import { execFileSync } from 'node:child_process'
import { rmdirSync } from 'node:fs'

const defaults = { run: (bin, args) => execFileSync(bin, args, { stdio: 'inherit' }), remove: rmdirSync, warn: console.warn }
const retained = (mount, failure) => new Error(`Could not detach the verification volume; retained mount at ${mount}.`, { cause: failure })

/** Only this read-only mount is owned here. Never remove a mounted volume's contents. */
export function withIosReleaseMount(dmg, mount, inspect, { run = defaults.run, remove = defaults.remove, warn = defaults.warn } = {}) {
  let mounted = false, primary
  try {
    run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg])
    mounted = true
    return inspect()
  } catch (error) { primary = error; throw error }
  finally {
    try {
      if (mounted) {
        let failure
        for (let attempt = 0; attempt < 2; attempt++) {
          try { run('hdiutil', ['detach', mount]); mounted = false; break }
          catch (error) { failure = error }
        }
        if (mounted) throw retained(mount, failure)
      }
      remove(mount)
    } catch (error) {
      if (primary) warn(error.message)
      else throw error
    }
  }
}

/**
 * The same ownership rules for an `inspect` that returns a promise — a
 * launched app, which can hold the volume for a moment after it exits, so a
 * failed detach waits `retryMs` before its second attempt.
 */
export async function withIosReleaseMountAsync(dmg, mount, inspect, { run = defaults.run, remove = defaults.remove, warn = defaults.warn, retryMs = 2000 } = {}) {
  let mounted = false, primary
  try {
    run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg])
    mounted = true
    return await inspect()
  } catch (error) { primary = error; throw error }
  finally {
    try {
      if (mounted) {
        let failure
        for (let attempt = 0; attempt < 2; attempt++) {
          if (attempt > 0 && retryMs > 0) await new Promise((resolve) => setTimeout(resolve, retryMs))
          try { run('hdiutil', ['detach', mount]); mounted = false; break }
          catch (error) { failure = error }
        }
        if (mounted) throw retained(mount, failure)
      }
      remove(mount)
    } catch (error) {
      if (primary) warn(error.message)
      else throw error
    }
  }
}
