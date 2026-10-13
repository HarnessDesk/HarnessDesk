import type { GitFileStatus, GitStatus } from '@harnessdesk/protocol'
import type { ExplorerFilter } from './state'

export interface ExplorerEntry {
  readonly name: string
  readonly path: string
  readonly kind: 'file' | 'directory'
}
export type ExplorerLetter = 'M' | 'A' | 'D' | 'R' | '!'
export interface ExplorerChange {
  readonly kind: 'file' | 'directory'
  readonly status: GitFileStatus['status']
}
export interface ExplorerTreeRow extends ExplorerEntry {
  readonly depth: number
  readonly letter: ExplorerLetter | null
}
/** Browser-side lexical normalization matches the host's absolute tab identities. */
export const explorerPath = (root: string, path: string): string | null => {
  if (!root.startsWith('/')) return null
  const absolute = path.startsWith('/') ? path : `${root}/${path}`
  const parts: string[] = []
  for (const part of absolute.split('/')) {
    if (part === '..') parts.pop()
    else if (part && part !== '.') parts.push(part)
  }
  const normalized = `/${parts.join('/')}`
  const base = root.replace(/\/+$/, '') || '/'
  return normalized === base || normalized.startsWith(base === '/' ? '/' : `${base}/`) ? normalized : null
}
const letterOf = (status: GitFileStatus['status']): ExplorerLetter => ({
  modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'A', conflicted: '!',
} as const)[status]
export const explorerChanges = (root: string, git: GitStatus | null): ReadonlyMap<string, ExplorerChange> => {
  const changes = new Map<string, ExplorerChange>()
  for (const file of git?.files ?? []) {
    const path = explorerPath(root, `${git!.root.replace(/\/$/, '')}/${file.path}`)
    if (!path || path === root) continue
    const previous = changes.get(path)
    // Conflicts survive the second status column. Other duplicates prefer the working tree.
    if (previous?.status === 'conflicted' || (previous && file.staged)) continue
    changes.set(path, { status: file.status, kind: file.path.endsWith('/') ? 'directory' : 'file' })
  }
  return changes
}
/** A flattened visible tree; unopened folders never need their contents to draw. */
export const explorerRows = (
  root: string,
  listings: ReadonlyMap<string, readonly ExplorerEntry[]>,
  expanded: readonly string[],
  filter: ExplorerFilter,
  changes: ReadonlyMap<string, ExplorerChange>,
): readonly ExplorerTreeRow[] => {
  const changedEntries = new Map<string, ExplorerEntry>()
  for (const [path, change] of changes) {
    const relative = path.slice(root.replace(/\/$/, '').length + 1)
    let parent = root.replace(/\/$/, '')
    const parts = relative.split('/')
    parts.forEach((name, index) => {
      parent += `/${name}`
      changedEntries.set(parent, { name, path: parent, kind: index < parts.length - 1 ? 'directory' : change.kind })
    })
  }
  const rows: ExplorerTreeRow[] = []
  const walk = (folder: string, depth: number, inherited?: ExplorerChange) => {
    const entries = new Map<string, ExplorerEntry>()
    for (const entry of listings.get(folder) ?? []) {
      if (explorerPath(root, entry.path) !== entry.path || entry.path.slice(0, entry.path.lastIndexOf('/')) !== folder.replace(/\/$/, '')) continue
      if (entry.name === '.git') continue
      if (filter === 'all' || inherited || changedEntries.has(entry.path)) entries.set(entry.path, entry)
    }
    for (const entry of changedEntries.values()) {
      if (entry.path.slice(0, entry.path.lastIndexOf('/')) === folder.replace(/\/$/, '')) entries.set(entry.path, entry)
    }
    for (const entry of [...entries.values()].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'directory' ? -1 : 1) || a.name.localeCompare(b.name))) {
      const change = changes.get(entry.path) ?? inherited
      rows.push({ ...entry, depth, letter: entry.kind === 'file' && change ? letterOf(change.status) : null })
      if (entry.kind === 'directory' && expanded.includes(entry.path)) walk(entry.path, depth + 1, change)
    }
  }
  walk(root, 0)
  return rows
}
