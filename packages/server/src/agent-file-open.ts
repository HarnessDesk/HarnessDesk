import { constants } from 'node:fs'
import { open } from 'node:fs/promises'

/**
 * Opens content on a canonical absolute path, without following a link in
 * any component. Callers resolve their chosen root once, then join plain
 * names below it; resolving again here would follow a swapped-in link.
 *
 * macOS's O_NOFOLLOW_ANY is forwarded by libuv but unnamed in Node. It
 * includes the final component and must not be combined with O_NOFOLLOW.
 * Linux instead opens each directory relative to its held parent through
 * /proc/self/fd. Each lookup has only one unchecked name, so O_NOFOLLOW
 * covers it; renaming an opened parent cannot redirect the next lookup.
 * A missing procfs is a refusal, never a fallback to path-only opens.
 * Other platforms refuse until they have an equivalent traversal.
 *
 * Tests may select the platform; host callers use the running platform.
 */
export const openAgentFile = async (path: string, flags: number, mode?: number, platform: NodeJS.Platform = process.platform) => {
  if (platform === 'darwin') return open(path, flags | 0x20000000, mode)
  if (platform !== 'linux') {
    throw Object.assign(new Error('Agent file content cannot be opened safely on this platform.'), { code: 'ENOTSUP' })
  }
  const parts = path.split('/')
  if (parts.shift() !== '' || parts.some((part) => !part || part === '.' || part === '..')) {
    throw Object.assign(new Error('An Agent file needs a canonical absolute path.'), { code: 'EINVAL' })
  }
  const name = parts.pop()!
  const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  let directory = await open('/', directoryFlags)
  try {
    for (const part of parts) {
      let next
      try {
        next = await open(`/proc/self/fd/${directory.fd}/${part}`, directoryFlags)
      } catch (error) {
        // Linux reports a linked directory with ENOTDIR when O_DIRECTORY
        // and O_NOFOLLOW are combined. Use the same refusal as macOS so
        // callers retain their existing replaced-folder explanation.
        if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') {
          throw Object.assign(new Error(`${path} has an ancestor that is no longer a real folder.`), { code: 'ELOOP' })
        }
        throw error
      }
      const parent = directory
      directory = next
      await parent.close()
    }
    return await open(`/proc/self/fd/${directory.fd}/${name}`, flags | constants.O_NOFOLLOW, mode)
  } finally {
    await directory.close()
  }
}
