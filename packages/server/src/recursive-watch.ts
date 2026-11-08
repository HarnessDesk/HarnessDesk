import { EventEmitter } from 'node:events'
import { watch, type FSWatcher } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'

/**
 * Linux's native recursive watch follows directory links. The roster follows
 * only the top-level links it has explicitly admitted, so watch real folders
 * individually there. macOS keeps its native, non-link-following recursion.
 */
export const watchRoster = (
  root: string,
  options: { readonly recursive: boolean; readonly persistent: boolean; /** Test-only selection of the portable folder walker. */ readonly platform?: NodeJS.Platform },
  listener: (event: string, filename: string | Buffer | null) => void,
): FSWatcher => {
  if ((options.platform ?? process.platform) !== 'linux' || !options.recursive) return watch(root, options, listener)
  const events = new EventEmitter() as FSWatcher
  events.on('change', listener)
  const folders = new Map<string, { readonly identity: string; readonly watcher: FSWatcher }>()
  let closed = false
  let referenced = options.persistent

  let scanning = false, pending = false
  const scan = async (): Promise<void> => {
    const wanted = new Set<string>()
    const visit = async (dir: string): Promise<void> => {
      if (closed) return
      let info
      try { info = await lstat(dir) } catch (error) {
        if (dir !== root && (error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      if (closed) return
      if (!info.isDirectory() || info.isSymbolicLink()) {
        if (dir === root) throw Object.assign(new Error('The watched folder was replaced.'), {
          code: info.isSymbolicLink() ? 'ELOOP' : 'ENOTDIR',
        })
        return
      }
      wanted.add(dir)
      const identity = `${info.dev}:${info.ino}`
      const previous = folders.get(dir)
      if (previous?.identity === '') folders.set(dir, { ...previous, identity })
      else if (previous?.identity !== identity) {
        previous?.watcher.close()
        attach(dir, identity)
      }
      let entries
      try { entries = await readdir(dir, { withFileTypes: true }) } catch (error) {
        if (dir !== root && (error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      if (closed) return
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(join(dir, entry.name))
      }
    }
    await visit(root)
    if (closed) return
    for (const [dir, { watcher }] of folders) {
      if (wanted.has(dir)) continue
      watcher.close()
      folders.delete(dir)
    }
  }
  // Coalesce rename bursts; an in-flight scan never races a newer walk or close.
  const schedule = (): void => {
    if (closed) return
    pending = true
    if (scanning) return
    scanning = true
    void (async () => {
      while (pending && !closed) { pending = false; await scan() }
    })().catch(error => { if (!closed) events.emit('error', error) }).finally(() => {
      scanning = false
      if (pending && !closed) schedule()
    })
  }
  const attach = (dir: string, identity: string): void => {
    const watcher = watch(dir, { persistent: referenced }, (event, filename) => {
      if (closed || folders.get(dir)?.watcher !== watcher) return
      if (folders.get(dir)?.identity === '') { schedule(); return }
      if (event === 'rename') schedule()
      events.emit('change', event, filename === null ? null : relative(root, join(dir, String(filename))))
    })
    watcher.on('error', error => {
      if (!closed && folders.get(dir)?.watcher === watcher) events.emit('error', error)
    })
    folders.set(dir, { identity, watcher })
  }
  events.close = () => {
    if (closed) return
    closed = true
    for (const { watcher } of folders.values()) watcher.close()
    folders.clear()
    events.emit('close')
  }
  events.ref = () => {
    referenced = true
    for (const { watcher } of folders.values()) watcher.ref()
    return events
  }
  events.unref = () => {
    referenced = false
    for (const { watcher } of folders.values()) watcher.unref()
    return events
  }
  // Opening the root still refuses a missing path synchronously. Directory
  // discovery and later reconciliations never read disk on the host thread.
  try { attach(root, ''); schedule() } catch (error) {
    events.close()
    throw error
  }
  return events
}
