import type { HostParams, HostResult, RuntimeId, WorkspaceReadFileResult } from '@harnessdesk/protocol'
import { splitByFile } from './diff'
import { conversationPath, repositoryPath } from './git-paths'

type HeadMethod = 'git/status' | 'git/diff' | 'workspace/readFile'
export type HeadRequest = <M extends HeadMethod>(method: M, params: HostParams<M>) => Promise<HostResult<M>>
export interface HeadFile {
  /** null means the path does not exist at HEAD, not an empty file. */
  readonly content: string | null
  readonly status: 'tracked' | 'added' | 'untracked' | 'outside-repository'
}
export interface ReadHeadOptions {
  readonly root: string
  /** Repository-relative or absolute; aliases use the host's admitted folder mapping. */
  readonly path: string
  readonly runtime?: RuntimeId
  /** The same disk snapshot the caller loaded, to avoid a second read. */
  readonly disk?: WorkspaceReadFileResult
}

function mismatch(): never { throw new Error('The file and Git patch do not match. Reload before comparing changes.') }
const physicalLines = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? []

/** Reverse one plain text patch, verifying every context/addition and both hunk lengths. */
export const reverseTextPatch = (current: string | null, patch: string): string | null => {
  if (!patch.trim()) return current
  if (/^(?:Binary files |GIT binary patch|diff --cc |diff --combined |@@@)/m.test(patch)) {
    throw new Error('This Git patch cannot be compared as a text file.')
  }
  const raws = patch.split('\n')
  if (raws.at(-1) === '') raws.pop()
  const source = physicalLines(current ?? '')
  const output: string[] = []
  let cursor = 0
  let hasHunk = false
  const oldMissing = /^--- \/dev\/null\r?$/m.test(patch) || /^new file mode /m.test(patch)
  const newMissing = /^\+\+\+ \/dev\/null\r?$/m.test(patch) || /^deleted file mode /m.test(patch)
  if (newMissing ? current !== null : current === null) mismatch()
  for (let index = 0; index < raws.length; index++) {
    const raw = raws[index]!
    if (!raw.startsWith('@@')) continue
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: |\r?$)/.exec(raw)
    if (!header) mismatch()
    hasHunk = true
    const oldCount = Number(header[2] ?? 1)
    const newCount = Number(header[4] ?? 1)
    const oldStart = Number(header[1]) - (oldCount ? 1 : 0)
    const start = Number(header[3]) - (newCount ? 1 : 0)
    const old: string[] = []
    const now: string[] = []
    let previousMark = ''
    while (index + 1 < raws.length && !raws[index + 1]!.startsWith('@@')) {
      const line = raws[++index]!
      if (line === '\\ No newline at end of file') {
        if (!previousMark) mismatch()
        if (previousMark !== '+' && old.length) old[old.length - 1] = old.at(-1)!.slice(0, -1)
        if (previousMark !== '-' && now.length) now[now.length - 1] = now.at(-1)!.slice(0, -1)
        previousMark = ''
        continue
      }
      const mark = line[0]
      if (mark !== ' ' && mark !== '+' && mark !== '-') mismatch()
      const text = `${line.slice(1)}\n`
      if (mark !== '+') old.push(text)
      if (mark !== '-') now.push(text)
      previousMark = mark
    }
    if (old.length !== oldCount || now.length !== newCount || start < cursor || start + now.length > source.length) mismatch()
    if (output.length + start - cursor !== oldStart) mismatch()
    if (source.slice(start, start + now.length).join('') !== now.join('')) mismatch()
    for (let at = cursor; at < start; at++) output.push(source[at]!)
    for (const line of old) output.push(line)
    cursor = start + now.length
  }
  if (!hasHunk) {
    // Empty files and mode/rename-only patches carry metadata without hunks.
    if (oldMissing && source.length) mismatch()
    return oldMissing ? null : current ?? ''
  }
  for (let at = cursor; at < source.length; at++) output.push(source[at]!)
  if (oldMissing && output.length) mismatch()
  return oldMissing ? null : output.join('')
}

/** Existing wire only: index→disk reversed first, then HEAD→index reversed. */
export const readHead = async (request: HeadRequest, options: ReadHeadOptions): Promise<HeadFile> => {
  const status = await request('git/status', { root: options.root })
  if (!status) return { content: null, status: 'outside-repository' }
  const root = status.root.replace(/\/$/, '')
  const path = repositoryPath(options.root, options.path, status)
  if (!path) {
    throw new Error('The file is outside the repository.')
  }
  // Normal Git status collapses a wholly untracked directory to one row.
  // Only its trailing slash proves containment; a sibling prefix does not.
  const states = status.files.filter((file) => file.path === path || (
    file.status === 'untracked' && file.path.endsWith('/') && path.startsWith(file.path)
  ))
  if (states.some((file) => file.status === 'conflicted')) throw new Error('Resolve the Git conflict before comparing HEAD.')
  const recreated = states.some((file) => file.status === 'untracked') && states.some((file) => file.staged && file.status === 'deleted')
  if (!recreated && states.some((file) => file.status === 'untracked')) return { content: null, status: 'untracked' }
  const disk = options.disk ?? await request('workspace/readFile', {
    path: conversationPath(options.root, path, status) ?? `${root}/${path}`,
    ...(options.runtime ? { runtime: options.runtime } : {}),
  })
  if (disk.kind !== 'missing' && (disk.kind !== 'text' || disk.truncated)) throw new Error('A complete text file is needed to compare HEAD.')
  if (disk.kind === 'missing' && !states.some((file) => file.status === 'deleted')) mismatch()
  const select = (diff: string): string => {
    const files = splitByFile(diff)
    const match = files.filter((file) => file.path === path || file.path === '')
    if (match.length > 1 || (files.length && !match.length)) mismatch()
    return match[0]?.diff ?? ''
  }
  const unstaged = select((await request('git/diff', { root, path })).diff)
  const staged = select((await request('git/diff', { root, path, staged: true })).diff)
  // Git has no index entry after a staged deletion. A recreated untracked
  // file is separate working content and is absent from git/diff.
  const index = recreated ? null : reverseTextPatch(disk.kind === 'text' ? disk.content : null, unstaged)
  const content = reverseTextPatch(index, staged)
  return { content, status: content === null ? 'added' : 'tracked' }
}
