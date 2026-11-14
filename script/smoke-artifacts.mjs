import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync } from 'node:fs'
import { constants } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { withIosReleaseMountAsync } from './ios-release-mount.mjs'

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

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/**
 * The packaged smoke as a child in a process group of its own, so that
 * stopping it reaches the app it launched too: the app runs from the mounted
 * volume, and the volume cannot be detached while it does.
 */
export const startSmoke = (app, { script = SMOKE, stdio = 'inherit' } = {}) => {
  const child = spawn(process.execPath, [script, app], { cwd: root, stdio, detached: true })
  const done = new Promise((settle) => {
    child.once('error', () => settle(1))
    child.once('exit', (code, signal) => settle(code ?? 128 + (constants.signals[signal] ?? 0)))
  })
  const group = (signal) => { try { process.kill(-child.pid, signal); return true } catch { return false } }
  return {
    done,
    stop: async (signal) => {
      group(signal)
      await done
      for (let waited = 0; waited < 10_000; waited += 200) {
        if (!group(0)) return
        await sleep(200)
      }
      group('SIGKILL')
    },
  }
}

/**
 * Smoke every DMG in `dir`. Returns what passed, failed and was skipped, and
 * the signal that interrupted the run, if one did; the caller decides the
 * exit. A mount or detach that fails counts as a failure of that DMG, never
 * as a pass. On SIGINT or SIGTERM the running smoke and the app it launched
 * are stopped, the volume is detached, and no further DMG is mounted.
 */
export async function smokeArtifacts(dir, {
  list = (folder) => readdirSync(folder),
  mount = withIosReleaseMountAsync,
  makeMount = (folder) => mkdtempSync(join(folder, '.smoke-')),
  smoke = startSmoke,
  canRun = cannotRun,
  signals = process,
  run,
  log = console.log,
} = {}) {
  const dmgs = list(dir).filter((file) => file.endsWith('.dmg')).sort()
  const result = { dmgs, passed: [], failed: [], skipped: [], interrupted: null }
  let current = null, stopping = null
  const onSignal = (signal) => {
    if (result.interrupted) return
    result.interrupted = signal
    log(`\nsmoke-artifacts: ${signal} — stopping the smoke and detaching the volume.`)
    stopping = current?.stop('SIGTERM') ?? null
  }
  signals.on('SIGINT', onSignal)
  signals.on('SIGTERM', onSignal)
  try {
    for (const dmg of dmgs) {
      if (result.interrupted) break
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
        const status = await mount(join(dir, dmg), at, async () => {
          // A signal that landed while hdiutil attached is handled only now.
          if (result.interrupted) return null
          current = smoke(join(at, 'HarnessDesk.app'))
          try {
            const code = await current.done
            if (stopping) await stopping
            return code
          } finally { current = null }
        }, run ? { run } : undefined)
        if (result.interrupted) result.failed.push({ dmg, reason: `interrupted by ${result.interrupted}` })
        else if (status === 0) result.passed.push(dmg)
        else result.failed.push({ dmg, reason: `the packaged smoke exited ${status}` })
      } catch (error) {
        result.failed.push({ dmg, reason: error instanceof Error ? error.message : String(error) })
      }
    }
  } finally {
    signals.off('SIGINT', onSignal)
    signals.off('SIGTERM', onSignal)
  }
  return result
}

/**
 * The summary and the exit for a run. A DMG that was not smoked is never a
 * pass: it fails the gate unless `allowSkip`, and is named as NOT SMOKED
 * either way.
 */
export function smokeVerdict({ passed, failed, skipped, interrupted }, { allowSkip = false } = {}) {
  const lines = [
    ...passed.map((dmg) => `  passed       ${dmg}`),
    ...failed.map(({ dmg, reason }) => `  FAILED       ${dmg}: ${reason}`),
    ...skipped.map(({ dmg, reason }) => `  NOT SMOKED: ${dmg} (${reason})`),
  ]
  const refuse = (problem, exitCode = 1) => ({ lines, problem, exitCode })
  if (interrupted) return refuse(`Interrupted by ${interrupted}; nothing is proven to start — do not publish.`, 128 + (constants.signals[interrupted] ?? 0))
  if (failed.length > 0) return refuse(`${failed.length} artifact(s) did not pass the packaged smoke — do not publish them.`)
  if (passed.length === 0) return refuse('No artifact could be smoked on this Mac, so nothing is proven to start — do not publish.')
  if (skipped.length > 0 && !allowSkip) {
    return refuse(`${skipped.length} artifact(s) NOT SMOKED on this Mac, so not proven to start — smoke them on a Mac that can run them, or pass --allow-skip to accept that.`)
  }
  if (skipped.length > 0) lines.push(`  --allow-skip: passing with ${skipped.length} artifact(s) NOT SMOKED.`)
  return { lines, problem: null, exitCode: 0 }
}
