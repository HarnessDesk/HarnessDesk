import { EventEmitter } from 'node:events'
import { lstatSync, readdirSync, watch, type FSWatcher } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Linux's native recursive watch follows directory links. The roster follows
 * only the top-level links it has explicitly admitted, so watch real folders
 * individually there. macOS keeps its native, non-link-following recursion.
 */
export const watchRoster = (
  root: string,
  options: { readonly recursive: boolean; readonly persistent: boolean },
  listener: (event: string, filename: string | Buffer | null) => void,
): FSWatcher => {
  if (process.platform !== 'linux' || !options.recursive) return watch(root, options, listener)
  const events = new EventEmitter() as FSWatcher
  events.on('change', listener)
  const folders = new Map<string, { readonly identity: string; readonly watcher: FSWatcher }>()
  let closed = false
  let referenced = options.persistent

  const scan = (): void => {
    const wanted = new Set<string>()
    const visit = (dir: string): void => {
      let info
      try { info = lstatSync(dir) } catch (error) {
        if (dir !== root && (error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      if (!info.isDirectory() || info.isSymbolicLink()) {
        if (dir === root) throw Object.assign(new Error('The watched folder was replaced.'), {
          code: info.isSymbolicLink() ? 'ELOOP' : 'ENOTDIR',
        })
        return
      }
      wanted.add(dir)
      const identity = `${info.dev}:${info.ino}`
      const previous = folders.get(dir)
      if (previous?.identity !== identity) {
        previous?.watcher.close()
        const watcher = watch(dir, { persistent: referenced }, (event, filename) => {
          if (closed || folders.get(dir)?.watcher !== watcher) return
          // Reconcile removed/replaced folders and attach newly made ones.
          if (event === 'rename') {
            try { scan() } catch (error) { events.emit('error', error) }
          }
          events.emit('change', event, filename === null ? null : relative(root, join(dir, String(filename))))
        })
        watcher.on('error', (error) => {
          if (!closed && folders.get(dir)?.watcher === watcher) events.emit('error', error)
        })
        folders.set(dir, { identity, watcher })
      }
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.isSymbolicLink()) visit(join(dir, entry.name))
      }
    }
    visit(root)
    for (const [dir, { watcher }] of folders) {
      if (wanted.has(dir)) continue
      watcher.close()
      folders.delete(dir)
    }
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
  try { scan() } catch (error) {
    events.close()
    throw error
  }
  return events
}
