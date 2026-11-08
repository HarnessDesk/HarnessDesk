import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const MARKER = 'HarnessDesk isolated native UI-system rig\n'
const MAX_BYTES = 64 * 1024
const EXIT_FILE = 'startup-exit.json'

function regularFile(path, limit) {
  const before = lstatSync(path)
  if (!before.isFile() || before.isSymbolicLink() || before.size > limit || constants.O_NOFOLLOW === undefined) return null
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const after = fstatSync(fd)
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino || after.size > limit) return null
    const bytes = Buffer.alloc(after.size)
    let read = 0
    while (read < bytes.length) { const n = readSync(fd, bytes, read, bytes.length - read, read); if (!n) break; read += n }
    return bytes.subarray(0, read)
  } finally { closeSync(fd) }
}
function validRig(rig) {
  if (constants.O_NOFOLLOW === undefined || dirname(realpathSync(rig)) !== realpathSync(tmpdir()) || !basename(rig).startsWith('harnessdesk-ui-system-') || !lstatSync(rig).isDirectory()) return false
  return regularFile(join(rig, '.harnessdesk-ui-system-rig'), Buffer.byteLength(MARKER))?.toString() === MARKER
}
function validHome(rig, home) {
  const info = lstatSync(home)
  return info.isDirectory() && !info.isSymbolicLink() && realpathSync(home) === join(realpathSync(rig), 'home')
}

/** Store only owned child exit scalars in the same marked synthetic rig. */
export function recordNativeStartupExit(home, error) {
  try {
    const rig = dirname(home)
    if (basename(home) !== 'home' || !validRig(rig) || !validHome(rig, home)) return false
    const pending = [error]
    for (let i = 0; i < pending.length && i < 8; i++) {
      const current = pending[i]
      if (!current || typeof current !== 'object') continue
      if (Object.hasOwn(current, 'exitCode') && Object.hasOwn(current, 'signalCode')) {
        const exitCode = Number.isInteger(current.exitCode) ? current.exitCode : null
        const signalCode = typeof current.signalCode === 'string' && /^SIG[A-Z0-9]+$/.test(current.signalCode) ? current.signalCode : null
        writeFileSync(join(home, EXIT_FILE), `${JSON.stringify({ exitCode, signalCode })}\n`, { flag: 'wx', mode: 0o600 })
        return true
      }
      if (current instanceof AggregateError) pending.push(...current.errors)
    }
  } catch { /* Observation cannot replace the launch failure. */ }
  return false
}
function readExit(home) {
  try {
    const bytes = regularFile(join(home, EXIT_FILE), 256)
    if (!bytes) return { status: 'refused' }
    const value = JSON.parse(bytes.toString())
    if (!value || Object.keys(value).sort().join(',') !== 'exitCode,signalCode' ||
        !(value.exitCode === null || Number.isInteger(value.exitCode)) ||
        !(value.signalCode === null || (typeof value.signalCode === 'string' && /^SIG[A-Z0-9]+$/.test(value.signalCode)))) return { status: 'refused' }
    return { status: 'observed', exitCode: value.exitCode, signalCode: value.signalCode }
  } catch (error) { return { status: error?.code === 'ENOENT' ? 'missing' : 'refused' } }
}

/** Copy only the bounded log of this marked synthetic rig before it is removed. */
export function captureNativeStartupLog(rig, output) {
  let result = { status: 'error' }
  const diagnostic = join(output, 'startup-diagnostics')
  let writable = false
  try {
    const outputInfo = lstatSync(output)
    if (!outputInfo.isDirectory() || outputInfo.isSymbolicLink()) throw new Error('invalid output')
    mkdirSync(diagnostic, { recursive: true })
    const diagnosticInfo = lstatSync(diagnostic)
    if (!diagnosticInfo.isDirectory() || diagnosticInfo.isSymbolicLink()) throw new Error('invalid diagnostic output')
    writable = true
    if (!validRig(rig)) result = { status: 'refused' }
    else {
      const home = join(rig, 'home'), log = join(home, 'app.log')
      let homeInfo
      try { homeInfo = lstatSync(home) } catch (error) { if (error?.code !== 'ENOENT') throw error }
      if (!homeInfo) result = { status: 'missing' }
      else if (!validHome(rig, home)) result = { status: 'refused' }
      else {
        const exit = readExit(home)
        let info
        try { info = lstatSync(log) } catch (error) { if (error?.code !== 'ENOENT') throw error }
        if (!info) result = { status: 'missing', exit }
        else if (!info.isFile() || info.isSymbolicLink()) result = { status: 'refused', exit }
        else {
          const fd = openSync(log, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
          try {
            const checked = fstatSync(fd)
            if (!checked.isFile() || checked.dev !== info.dev || checked.ino !== info.ino) result = { status: 'refused', exit }
            else {
              const size = Math.min(checked.size, MAX_BYTES), bytes = Buffer.alloc(size), start = Math.max(0, checked.size - size)
              let read = 0
              while (read < size) { const n = readSync(fd, bytes, read, size - read, start + read); if (!n) break; read += n }
              writeFileSync(join(diagnostic, 'app-log-tail.log'), bytes.subarray(0, read), { flag: 'wx', mode: 0o600 })
              result = { status: 'saved', bytes: read, truncated: checked.size > MAX_BYTES, exit }
            }
          } finally { closeSync(fd) }
        }
      }
    }
  } catch {
    result = { status: 'error' }
    // Observation must never replace the startup failure or print raw data.
    try { process.stderr.write('native startup log observation unavailable\n') } catch {}
  }
  if (writable) {
    try { writeFileSync(join(diagnostic, 'capture.json'), `${JSON.stringify(result)}\n`, { flag: 'wx', mode: 0o600 }) }
    catch { try { process.stderr.write('native startup log observation unavailable\n') } catch {} }
  }
  return result
}
