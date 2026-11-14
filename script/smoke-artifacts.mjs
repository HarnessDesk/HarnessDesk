import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { withIosReleaseMount } from './ios-release-mount.mjs'

/**
 * The launch gate: boot the app inside each release DMG before it is published.
 *
 * `verify-artifacts` proves the DMGs are signed, notarized and stapled — 0.7.1
 * passed all of it and still opened to "HarnessDesk is incomplete". This runs
 * `packages/desktop/script/smoke-packaged.mjs` against the very bundle a
 * person would drag out of each DMG, mounted read-only.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const SMOKE = join(root, 'packages/desktop/script/smoke-packaged.mjs')

/**
 * Whether an x86_64 process can start here. Running the x86_64 slice of a
 * system binary asks exactly that question. `pgrep oahd` does not: the
 * translation daemon is started on demand, so an installed but idle Rosetta
 * reads as missing, and a running one says nothing about whether launching
 * an x86_64 binary will work.
 */
export const rosettaInstalled = () => spawnSync('/usr/bin/arch', ['-x86_64', '/usr/bin/true'], { stdio: 'ignore', timeout: 15_000 }).status === 0

export const dmgArch = (dmg) => (/-arm64\.dmg$/.test(dmg) ? 'arm64' : /-x64\.dmg$/.test(dmg) ? 'x64' : null)

/** Null when an app of `arch` can run on this Mac, otherwise the reason it cannot. */
export function cannotRun(arch, { hostArch = process.arch, rosetta = rosettaInstalled } = {}) {
  if (arch === hostArch) return null
  if (arch === 'x64' && hostArch === 'arm64') {
    return rosetta() ? null : 'Rosetta is not installed on this Apple-silicon Mac (`softwareupdate --install-rosetta` installs it), so the x64 app cannot run here'
  }
  return `an ${arch} app cannot run on an ${hostArch} Mac`
}

const runSmoke = (app) => spawnSync(process.execPath, [SMOKE, app], { cwd: root, stdio: 'inherit' }).status

/**
 * Smoke every DMG in `dir`. Returns what ran, passed, failed and was skipped;
 * the caller decides the exit. A mount or detach that fails counts as a
 * failure of that DMG, never as a pass.
 */
export function smokeArtifacts(dir, {
  list = (folder) => readdirSync(folder),
  mount = withIosReleaseMount,
  makeMount = (folder) => mkdtempSync(join(folder, '.smoke-')),
  smoke = runSmoke,
  canRun = cannotRun,
  run,
  log = console.log,
} = {}) {
  const dmgs = list(dir).filter((file) => file.endsWith('.dmg')).sort()
  const result = { dmgs, passed: [], failed: [], skipped: [] }
  for (const dmg of dmgs) {
    log(`\n=== ${dmg}`)
    const arch = dmgArch(dmg)
    if (!arch) { result.failed.push({ dmg, reason: 'the artifact name does not identify its architecture' }); continue }
    const reason = canRun(arch)
    if (reason) {
      log(`smoke-artifacts: skipping ${dmg}: ${reason}.`)
      result.skipped.push({ dmg, reason })
      continue
    }
    try {
      const at = makeMount(dir)
      const status = mount(join(dir, dmg), at, () => smoke(join(at, 'HarnessDesk.app')), run ? { run } : undefined)
      if (status === 0) result.passed.push(dmg)
      else result.failed.push({ dmg, reason: `the packaged smoke exited ${status}` })
    } catch (error) {
      result.failed.push({ dmg, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return result
}
