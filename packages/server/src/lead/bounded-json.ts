import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

export type BoundedJsonResult = { readonly kind: 'missing' } | { readonly kind: 'unreadable' } | { readonly kind: 'value'; readonly value: unknown }

/** ENOENT alone is a clean absence. Links, invalid bytes and every other I/O failure are unreadable. */
export const readBoundedJsonResult = async (file: string, maxBytes: number): Promise<BoundedJsonResult> => {
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > maxBytes) return { kind: 'unreadable' }
      const bytes = Buffer.alloc(maxBytes + 1)
      let length = 0
      while (length < bytes.length) {
        const read = await handle.read(bytes, length, bytes.length - length, length)
        if (read.bytesRead === 0) break
        length += read.bytesRead
      }
      if (length > maxBytes) return { kind: 'unreadable' }
      return { kind: 'value', value: JSON.parse(bytes.subarray(0, length).toString('utf8')) }
    } finally { await handle.close() }
  } catch (error) { return { kind: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable' } }
}

/** Existing observation-only stores treat unreadable and absent alike; control records use the full result. */
export const readBoundedJson = async (file: string, maxBytes: number): Promise<unknown> => {
  const read = await readBoundedJsonResult(file, maxBytes)
  return read.kind === 'value' ? read.value : undefined
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
