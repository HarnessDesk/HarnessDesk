import { createHash } from 'node:crypto'

/**
 * The one digest both halves of the library use. The scanner detects
 * `differs` with it and the manifest vouches with it, so they must never
 * disagree about what a definition hashes to — trimmed, because a trailing
 * newline is file convention rather than content.
 */
export const digestOf = (text: string): string =>
  createHash('sha256').update(text.trim()).digest('hex').slice(0, 16)

/** Full bundle identity, shared by Library writes and attachment approvals. */
export function bundleDigest(files: readonly { readonly path: string; readonly bytes: Uint8Array }[]): string {
  const hash = createHash('sha256')
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const path = Buffer.from(file.path, 'utf8')
    const pathLength = Buffer.alloc(4)
    pathLength.writeUInt32BE(path.length)
    const byteLength = Buffer.alloc(4)
    byteLength.writeUInt32BE(file.bytes.length)
    hash.update(pathLength)
    hash.update(path)
    hash.update(byteLength)
    hash.update(file.bytes)
  }
  return hash.digest('hex')
}
