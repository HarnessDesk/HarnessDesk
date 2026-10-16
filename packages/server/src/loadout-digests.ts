import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { currentSkillBundleDigest, digestOf, knownRoots, MAX_BUNDLE_FILES } from '@harnessdesk/agent-inventory'

const MAX_BYTES = 64 * 1024 * 1024
const inside = (path: string, root: string): boolean => { const rest = relative(root, path); return rest === '' || (rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest)) }

/** One cache for the host's life. Every resource's metadata participates in a bundle's key. */
export class LoadoutDigests {
  readonly #cache = new Map<string, { fingerprint: string; digest: string | null }>()

  record(home: string, cwd: string): { digest(kind: 'skills' | 'memory', path: string): Promise<string | null> } {
    let items = 0, stopped = false
    const budget = { remaining: MAX_BYTES }
    return { digest: async (kind, path) => {
      if (stopped || budget.remaining <= 0 || items++ >= 300) return null
      try {
        if (!isAbsolute(path)) return null
        const roots = kind === 'skills' ? knownRoots('skill', home, cwd) : [cwd, home]
        const actual = await realpath(path)
        let admitted = false
        for (const root of roots) {
          if (!inside(resolve(path), resolve(root))) continue
          try { if (inside(actual, await realpath(root))) { admitted = true; break } } catch { /* missing root */ }
        }
        if (!admitted || (await lstat(path)).isSymbolicLink()) return null
        const files: { path: string; size: number; mtime: number; ctime: number }[] = []
        let total = 0, inspected = 0
        const walk = async (file: string): Promise<void> => {
          if (++inspected > MAX_BUNDLE_FILES * 4 + 4) throw new Error('Too many bundle entries.')
          const stats = await lstat(file)
          if (stats.isSymbolicLink()) return
          if (stats.isDirectory()) {
            for (const name of (await readdir(file)).sort()) await walk(join(file, name))
          } else {
            if (!stats.isFile() || files.length > MAX_BUNDLE_FILES) throw new Error('Not a bounded regular file bundle.')
            total += stats.size
            if (total > budget.remaining) { stopped = true; throw new Error('Record digest budget exhausted.') }
            files.push({ path: file, size: stats.size, mtime: stats.mtimeMs, ctime: stats.ctimeMs })
          }
        }
        const stats = await lstat(actual)
        // Adapters may report the definition or its bundle directory.
        const target = kind === 'skills' && !stats.isDirectory() && actual.endsWith(`${sep}SKILL.md`) ? dirname(actual) : actual
        if (kind === 'memory' && !stats.isFile()) return null
        await walk(target)
        const fingerprint = JSON.stringify(files)
        const key = `${kind}\0${actual}`
        const cached = this.#cache.get(key)
        if (cached?.fingerprint === fingerprint) return cached.digest
        let digest: string | null
        if (kind === 'skills') {
          digest = currentSkillBundleDigest(target, budget)
        } else {
          const handle = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW)
          try {
            const current = await handle.stat()
            // A growth between stat and read must not spend beyond the remaining budget.
            if (!current.isFile() || current.size > total || current.size > budget.remaining) return null
            const buffer = Buffer.alloc(current.size)
            const read = await handle.read(buffer, 0, buffer.length, 0)
            budget.remaining -= read.bytesRead
            if ((await handle.stat()).size !== current.size || read.bytesRead !== current.size) return null
            digest = digestOf(buffer.subarray(0, read.bytesRead).toString('utf8'))
          } finally { await handle.close() }
        }
        this.#cache.set(key, { fingerprint, digest })
        return digest
      } catch { return null }
    } }
  }
}
