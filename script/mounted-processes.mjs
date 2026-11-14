import { execFileSync } from 'node:child_process'

/**
 * Processes still running from a release volume or a packaged bundle, found
 * by the path their command starts with — the path each was started from,
 * which is how the app and every helper of a bundle are launched — never by
 * name. An installed copy of the
 * same app under /Applications, or a developer's own running desk, has the
 * same name and must never be touched by a release check.
 *
 * Why this exists: the x64 smoke of 0.7.1 passed every check, and then its
 * volume would not detach — a HarnessDesk with the smoke's own arguments was
 * still running from it, with its helpers, after the process the smoke had
 * spawned was gone. Whatever started it, the volume is only free once nothing
 * runs from it.
 */

/** `ps` lines (`pid command`) whose command starts with `<prefix>/`, never this process. */
export function processesUnder(prefix, psOutput, { self = process.pid } = {}) {
  const root = prefix.replace(/\/+$/, '') + '/'
  if (root === '/') throw new Error('Refusing to match every process: the prefix is the filesystem root.')
  const found = []
  for (const line of psOutput.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (!match) continue
    const pid = Number(match[1]), command = match[2]
    if (pid === self || !command.startsWith(root)) continue
    found.push({ pid, command })
  }
  return found
}

/**
 * `-ww`: an unlimited width, so a long mount path is never cut short of the
 * prefix. Unlimited width is also more than the default 1 MB of output on a
 * busy Mac (measured: ENOBUFS), hence the larger buffer.
 */
const listProcesses = () => execFileSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })

const sendSignal = (pid, signal) => {
  try { process.kill(pid, signal); return true } catch { return false }
}

const pause = (ms) => new Promise((done) => setTimeout(done, ms))

/**
 * SIGTERM every process running from under `prefix`, wait up to `timeoutMs`
 * for them to go, SIGKILL whatever is left. Every poll scans again, so a
 * process that appears meanwhile — a relaunch starting the app anew — is
 * stopped too. Returns every process it found.
 */
export async function stopProcessesUnder(prefix, {
  ps = listProcesses,
  kill = sendSignal,
  sleep = pause,
  log = console.log,
  label = 'stop',
  timeoutMs = 10_000,
  pollMs = 250,
} = {}) {
  const seen = new Map()
  for (let waited = 0; ; waited += pollMs) {
    const running = processesUnder(prefix, ps())
    if (running.length === 0) return [...seen.values()]
    if (waited >= timeoutMs) {
      log(`${label}: ${running.length} process(es) did not quit within ${timeoutMs / 1000}s; killing ${running.map(({ pid }) => pid).join(', ')}`)
      for (const { pid } of running) kill(pid, 'SIGKILL')
      return [...seen.values()]
    }
    const fresh = running.filter(({ pid }) => !seen.has(pid))
    if (fresh.length > 0) {
      log(`${label}: stopping ${fresh.length} process(es) still running from ${prefix}:`)
      for (const proc of fresh) {
        log(`  ${proc.pid} ${proc.command}`)
        seen.set(proc.pid, proc)
        kill(proc.pid, 'SIGTERM')
      }
    }
    await sleep(pollMs)
  }
}
