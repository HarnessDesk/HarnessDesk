import { execFile } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/**
 * A literal, bounded reader for one committed memory file — never a
 * repository-supplied path, never a working-tree read. `readMemoryBlob` asks
 * Git for exactly the tree entries a path names, one component at a time, so
 * a link anywhere in the chain is refused before its target is ever reached
 * rather than resolved and then inspected.
 */

/** The one shape a citation's path may have: a flat Markdown file directly inside `.harnessdesk/memory`. */
export function memoryPath(path: string): string {
  if (!/^\.harnessdesk\/memory\/[a-z0-9][a-z0-9-]{0,63}\.md$/.test(path)) {
    throw new Error('Choose a Markdown file directly inside .harnessdesk/memory.')
  }
  return path
}

/**
 * Reads exactly the cited revision of exactly the cited path, refusing a
 * link at any tree level and any blob outside the bounds below — proven in
 * `memory-git.test.ts` against old revisions, symbolic-link tree entries and
 * oversized blobs. `root` must already be admitted (`admitMemoryRoot`); this
 * function trusts it and does not re-check it.
 */
export async function readMemoryBlob(root: string, at: string, path: string): Promise<string> {
  memoryPath(path)
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(at)) throw new Error('Choose a full commit revision.')
  const git = async (args: string[], maxBuffer: number): Promise<Buffer> => {
    const out = await exec('git', ['--no-replace-objects', '-C', root, ...args], {
      encoding: 'buffer',
      maxBuffer,
      timeout: 5000,
      env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_LAZY_FETCH: '1' },
    })
    return out.stdout as Buffer
  }
  const parts = path.split('/')
  for (let i = 1; i <= parts.length; i++) {
    const prefix = parts.slice(0, i).join('/')
    const listing = (await git(['ls-tree', '-z', at, '--', `:(literal)${prefix}`], 4096)).toString('utf8')
    const match = /^(040000|100644|100755) (tree|blob) ([a-f0-9]{40}|[a-f0-9]{64})\t([^\0]+)\0$/.exec(listing)
    if (!match || match[4] !== prefix || match[2] !== (i === parts.length ? 'blob' : 'tree')) {
      throw new Error('Memory must be a regular committed file, with no links.')
    }
    if (i === parts.length) {
      const bytes = await git(['cat-file', 'blob', match[3]!], 65536)
      const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      if (source.includes('\0')) throw new Error('Memory must be UTF-8 text without NUL.')
      return source
    }
  }
  throw new Error('Memory file is unavailable.')
}

/**
 * Root admission — a separate, required boundary check `readMemoryBlob`
 * itself does not make. `citation.project` already comes from a Goal's own
 * `root`, itself set only from a room already confined to an open folder or
 * repository (`GoalPlanePort.confine`), so this is not re-confining against
 * open workspaces; it is admitting the repository's own metadata before any
 * `git` subprocess is pointed at it.
 *
 * Phase 9's own admission code (`provenance/git.ts`) is deliberately not
 * reused here — it is internal to that module, and extracting it would touch
 * files outside this task. This reader instead restricts itself to the
 * simpler, independently verifiable case the decision allows: an ordinary
 * checkout whose `.git` is a real, unlinked directory declaring no external
 * object alternates. A linked worktree is refused outright rather than
 * partially admitted.
 */
export async function admitMemoryRoot(root: string): Promise<string> {
  if (!isAbsolute(root)) throw new Error('Choose an absolute project root.')
  const real = await realpath(root)
  const dotGit = join(real, '.git')
  const info = await lstat(dotGit).catch(() => null)
  if (!info) throw new Error('This project has no .git — memory can only be read from an ordinary Git repository.')
  if (info.isSymbolicLink()) throw new Error('This project’s .git is a link, so memory cannot be read from it.')
  if (!info.isDirectory()) {
    throw new Error('This project is a linked worktree; memory can only be read from its own ordinary checkout.')
  }
  for (const name of ['alternates', 'http-alternates']) {
    const path = join(dotGit, 'objects', 'info', name)
    const exists = await lstat(path).catch(() => null)
    if (exists) {
      throw new Error('This repository declares external object alternates, so memory cannot be read safely from it.')
    }
  }
  return real
}

/**
 * Every `.harnessdesk/memory/*.md` entry at one commit — never their
 * contents. Bounded so a hostile tree cannot make a listing expensive: past
 * either limit the listing is refused outright, never silently clipped.
 */
export async function listMemoryFiles(root: string, at: string): Promise<readonly { path: string; problem: string | null }[]> {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(at)) throw new Error('Choose a full commit revision.')
  const out = await exec(
    'git',
    ['--no-replace-objects', '-C', root, 'ls-tree', '-z', at, '--', ':(literal).harnessdesk/memory/'],
    {
      encoding: 'buffer',
      maxBuffer: 256 * 1024 + 4096,
      timeout: 5000,
      env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_LAZY_FETCH: '1' },
    },
  ).catch(() => ({ stdout: Buffer.alloc(0) }))
  const text = (out.stdout as Buffer).toString('utf8')
  if (Buffer.byteLength(text) > 256 * 1024) {
    throw new Error('This project has more memory files than can be listed at once.')
  }
  const records = text.split('\0').filter(Boolean)
  if (records.length > 256) throw new Error('This project has more memory files than can be listed at once.')
  const files: { path: string; problem: string | null }[] = []
  for (const record of records) {
    const tab = record.indexOf('\t')
    if (tab < 0) continue
    const [mode, kind] = record.slice(0, tab).split(' ')
    // `ls-tree` already reports paths relative to the repository root, not
    // to the `.harnessdesk/memory/` pathspec that found them — prefixing
    // again here would silently double it.
    const path = record.slice(tab + 1)
    if (kind !== 'blob') continue // a nested directory is not one of this shape's files
    if (mode !== '100644' && mode !== '100755') {
      files.push({ path, problem: 'This entry is a link, not a regular file, so it is not readable memory.' })
      continue
    }
    try {
      memoryPath(path)
      files.push({ path, problem: null })
    } catch (error) {
      files.push({ path, problem: error instanceof Error ? error.message : String(error) })
    }
  }
  return files
}
