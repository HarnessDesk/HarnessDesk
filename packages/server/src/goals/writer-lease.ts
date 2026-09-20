import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rm, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'

import { syncDirectory } from './store.js'

interface Writer {
  version: 1
  pid: number
  token: string
  startedAt: number
}

const ownerOf = (text: string): Writer => {
  try {
    const value = JSON.parse(text) as Partial<Writer> | null
    if (!value || value.version !== 1 || !Number.isSafeInteger(value.pid) || Number(value.pid) < 1 ||
      typeof value.token !== 'string' || !value.token || !Number.isFinite(value.startedAt)) {
      throw new Error('invalid owner')
    }
    return value as Writer
  } catch {
    throw new Error('The desk writer lock is unreadable. Repair desk-writer.lock before opening this desk.')
  }
}

const dead = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

export async function acquireDeskWriter(
  home: string,
  write: (handle: FileHandle, text: string) => Promise<void> = async (handle, text) => {
    await handle.writeFile(text)
    await handle.sync()
  },
): Promise<{ release(): Promise<void> }> {
  await mkdir(home, { recursive: true })
  const file = join(home, 'desk-writer.lock')
  const recovery = join(home, 'desk-writer-recovery')
  const mine: Writer = { version: 1, pid: process.pid, token: randomUUID(), startedAt: Date.now() }
  const create = async (): Promise<void> => {
    const handle = await open(file, 'wx', 0o600)
    try {
      await write(handle, JSON.stringify(mine))
    } catch (error) {
      await handle.close()
      await rm(file, { force: true })
      throw error
    }
    await handle.close()
    await syncDirectory(home)
  }
  try {
    await create()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const observed = ownerOf(await readFile(file, 'utf8'))
    if (!dead(observed.pid)) {
      throw new Error('Another desk holds this state directory. Close it before opening this desk.')
    }
    try {
      await mkdir(recovery)
    } catch {
      throw new Error('Desk writer recovery is already held. Repair desk-writer-recovery before retrying.')
    }
    try {
      const current = ownerOf(await readFile(file, 'utf8'))
      if (current.token !== observed.token || !dead(current.pid)) {
        throw new Error('The desk writer changed during recovery. Close the other desk and retry.')
      }
      await rm(file)
      await create()
    } finally {
      await rm(recovery, { recursive: true })
    }
  }
  return {
    async release(): Promise<void> {
      let current: Writer
      try {
        current = ownerOf(await readFile(file, 'utf8'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      if (current.token !== mine.token) return
      await rm(file)
      await syncDirectory(home)
    },
  }
}
