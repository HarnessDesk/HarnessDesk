import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Four outstanding fs operations at most; symbolic links are measured, never followed. */
export const diskBytes = (root: string): Promise<number> => new Promise((resolve, reject) => {
  const queue = [root]
  let active = 0, bytes = 0, failed = false
  const pump = (): void => {
    if (failed) return
    if (!queue.length && !active) { resolve(bytes); return }
    while (queue.length && active < 4) {
      const path = queue.pop()!
      active++
      void (async () => {
        let info
        try { info = await lstat(path) }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
        if (info.isDirectory()) for (const name of await readdir(path)) queue.push(join(path, name))
        else bytes += info.size
      })().then(() => { active--; pump() }, error => { failed = true; reject(error) })
    }
  }
  pump()
})
