import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

/** A small host-owned JSON file, read without following a link and never past `maxBytes`. Any failure is `undefined`. */
export const readBoundedJson = async (file: string, maxBytes: number): Promise<unknown> => {
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > maxBytes) return undefined
      const bytes = Buffer.alloc(maxBytes + 1)
      let length = 0
      while (length < bytes.length) {
        const read = await handle.read(bytes, length, bytes.length - length, length)
        if (read.bytesRead === 0) break
        length += read.bytesRead
      }
      if (length > maxBytes) return undefined
      return JSON.parse(bytes.subarray(0, length).toString('utf8'))
    } finally { await handle.close() }
  } catch { return undefined }
}

/** Temporary file, fsync, `recheck`, rename, directory fsync. `recheck` throwing leaves the old file. */
export const writeAtomicJson = async (file: string, value: unknown, recheck: () => Promise<void>): Promise<void> => {
  const directory = dirname(file)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync() } finally { await handle.close() }
    await recheck()
    await rename(temporary, file)
    const parent = await open(directory, 'r')
    try { await parent.sync() } finally { await parent.close() }
  } finally { await rm(temporary, { force: true }) }
}
