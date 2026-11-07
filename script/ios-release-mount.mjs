import { execFileSync } from 'node:child_process'
import { rmdirSync } from 'node:fs'
/** Only this read-only mount is owned here. Never remove a mounted volume's contents. */
export function withIosReleaseMount(dmg, mount, inspect, { run = (bin, args) => execFileSync(bin, args, { stdio: 'inherit' }), remove = rmdirSync, warn = console.warn } = {}) {
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
        if (mounted) throw new Error(`Could not detach the verification volume; retained mount at ${mount}.`, { cause: failure })
      }
      remove(mount)
    } catch (error) {
      if (primary) warn(error.message)
      else throw error
    }
  }
}
