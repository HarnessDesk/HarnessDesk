import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** A launch record is host-owned, never read from a checkout or a backup. */
interface CheckProcess { readonly version: 1; readonly pgid: number; readonly identity: string }

const identityOf = (pid: number): string | null => {
  try {
    const row = execFileSync('ps', ['-o', 'pgid=', '-o', 'lstart=', '-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    if (Number(row.split(/\s+/)[0]) !== pid) return null
    return createHash('sha256').update(row).digest('hex')
  } catch (error) {
    if ((error as { status?: number }).status === 1) return null // already reaped
    throw error // an unreadable identity cannot authorize a signal
  }
}

const syncDirectory = (dir: string): void => {
  const fd = openSync(dir, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

/** Called while the new shell still waits for its launch handshake. */
export const recordCheckProcess = (dir: string, pgid: number): (() => void) => {
  if (!Number.isSafeInteger(pgid) || pgid <= 1 || pgid === process.pid) throw new Error('Invalid check process group.')
  const identity = identityOf(pgid)
  if (!identity) throw new Error('The check process group could not be identified.')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, `${randomUUID()}.json`)
  const pending = `${path}.pending`
  const fd = openSync(pending, 'wx', 0o600)
  try {
    writeFileSync(fd, JSON.stringify({ version: 1, pgid, identity } satisfies CheckProcess))
    fsyncSync(fd)
  } finally { closeSync(fd) }
  renameSync(pending, path)
  syncDirectory(dir)
  return () => { unlinkSync(path); syncDirectory(dir) }
}

const groupAlive = (pgid: number): boolean => {
  try { process.kill(-pgid, 0); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      // macOS may refuse the probe for a group of only dying/unreaped
      // processes. Prove that from ps; EPERM alone never establishes cleanup.
      const rows = execFileSync('ps', ['-axo', 'pgid=,stat='], { encoding: 'utf8' }).trim().split('\n')
      const live = rows.some((row) => {
        const [group, state] = row.trim().split(/\s+/)
        if (!group || !state || !Number.isSafeInteger(Number(group))) throw error
        return Number(group) === pgid && !state.startsWith('Z') && !state.startsWith('X') &&
          !(process.platform === 'darwin' && state.includes('E'))
      })
      if (!live) return false
    }
    throw error
  }
}

/** Before Flow recovery: signal only the exact recorded groups, and refuse startup if one cannot be stopped. */
export const recoverCheckProcesses = async (dir: string): Promise<void> => {
  let files: string[]
  try { files = readdirSync(dir) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    const path = join(dir, file)
    const record = JSON.parse(readFileSync(path, 'utf8')) as CheckProcess
    if (record.version !== 1 || !Number.isSafeInteger(record.pgid) || record.pgid <= 1 || record.pgid === process.pid || typeof record.identity !== 'string') {
      throw new Error('A check process launch record is invalid; no check can restart safely.')
    }
    const identity = identityOf(record.pgid)
    // A reused leader pid belongs to someone else. Never signal it.
    if (identity !== null && identity !== record.identity) {
      unlinkSync(path)
      syncDirectory(dir)
      continue
    }
    if (groupAlive(record.pgid)) {
      if (identity === null) throw new Error('A previous check process group has no matching leader identity; no check can restart safely.')
      process.kill(-record.pgid, 'SIGKILL')
      const deadline = Date.now() + 5000
      while (groupAlive(record.pgid)) {
        if (Date.now() >= deadline) throw new Error('A previous check process group could not be stopped; no duplicate check will start.')
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    unlinkSync(path)
    syncDirectory(dir)
  }
}
