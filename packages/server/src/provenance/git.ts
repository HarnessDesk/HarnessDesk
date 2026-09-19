import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { devNull } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { setImmediate } from 'node:timers/promises'

import type { FilePatch, Patch } from './model.js'

export interface RepoHandle {
  readonly project: string
  readonly commonDir: string
  readonly objectDir: string
  readonly viewDir: string
  readonly checkouts: ReadonlyMap<string, string>
  readonly objectFormat: 'sha1' | 'sha256'
}

export interface RefSnapshot {
  readonly refs: ReadonlyMap<string, string>
  readonly heads: ReadonlyMap<string, string | null>
  readonly takenAt: number
}

export interface CommitObject {
  readonly sha: string
  readonly tree: string
  readonly parents: readonly string[]
}

export interface ReflogMove {
  readonly id: string
  readonly ref: string
  readonly checkout: string | null
  readonly before: string | null
  readonly after: string | null
  readonly recordedAt: number | null
}

export interface LogCursor {
  readonly fileId: string
  readonly offset: number
  readonly tailHash: string
}

export interface ReflogPage {
  readonly moves: readonly ReflogMove[]
  readonly cursors: ReadonlyMap<string, LogCursor>
  readonly gaps: readonly string[]
  readonly more: boolean
}

export interface GitReader {
  snapshot(signal: AbortSignal): Promise<RefSnapshot>
  reflogs(cursors: ReadonlyMap<string, LogCursor>, signal: AbortSignal): Promise<ReflogPage>
  commit(sha: string, signal: AbortSignal): Promise<CommitObject | null>
  patch(from: string | null, to: string, signal: AbortSignal): Promise<Patch>
  files(from: string | null, to: string, signal: AbortSignal): Promise<readonly FilePatch[]>
  ancestors(tips: readonly string[], known: ReadonlySet<string>, limit: number, signal: AbortSignal): Promise<readonly string[]>
  close(): Promise<void>
}

const OUTPUT_LIMIT = 8 * 1024 * 1024
const LOG_LIMIT = 2 * 1024 * 1024
const REF_LIMIT = 50_000
const hash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')
function fail(reason: string): never {
  throw new Error(reason)
}
const aborted = (signal: AbortSignal): void => {
  if (signal.aborted) fail('capture-aborted')
}
const missing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === 'ENOENT'
const inside = (root: string, path: string): boolean => {
  const part = relative(root, path)
  return part === '' || (!part.startsWith(`..${sep}`) && part !== '..' && !part.startsWith(sep))
}

export const oid = (value: string): string => {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) fail('Expected a full object id.')
  return value
}

/** A name is a map key. No name read here is passed to join or to a shell. */
const refName = (value: string): boolean =>
  value.startsWith('refs/') && !/[\x00-\x20\x7f~^:?*\[\\]/.test(value) &&
  !value.includes('..') && !value.includes('@{') &&
  value.split('/').every((part) => !!part && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock'))

const utf8 = (bytes: Buffer): string => {
  const value = bytes.toString('utf8')
  if (!Buffer.from(value, 'utf8').equals(bytes)) fail('unsupported-path')
  return value
}

/** Two children across all readers; waiting cancellation never starts a child. */
let activeChildren = 0
const childWaiters = new Set<() => void>()
const childSlot = async (signal: AbortSignal): Promise<() => void> => {
  while (activeChildren >= 2) {
    aborted(signal)
    await new Promise<void>((resolve) => {
      const wake = () => {
        childWaiters.delete(wake)
        signal.removeEventListener('abort', wake)
        resolve()
      }
      childWaiters.add(wake)
      signal.addEventListener('abort', wake, { once: true })
      if (signal.aborted) wake()
    })
  }
  aborted(signal)
  activeChildren += 1
  return () => {
    activeChildren -= 1
    for (const wake of [...childWaiters]) wake()
  }
}

/** Internal process boundary, exposed to these tests; never a wire operation. */
export const runChild = async (
  executable: string,
  args: readonly string[],
  options: {
    signal: AbortSignal
    env?: NodeJS.ProcessEnv
    input?: Buffer
    timeoutMs?: number
    stdoutLimit?: number
    started?: () => void
    stopped?: () => void
  },
): Promise<Buffer> => {
  const release = await childSlot(options.signal)
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      const child = spawn(executable, [...args], {
        shell: false,
        windowsHide: true,
        env: options.env ?? { PATH: process.env.PATH },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      options.started?.()
      let reason: string | null = null
      let bytes = 0
      let stderrBytes = 0
      const chunks: Buffer[] = []
      const stop = (why: string) => {
        reason ??= why
        child.kill('SIGKILL')
      }
      const abort = () => stop('capture-aborted')
      const timer = setTimeout(() => stop('git-timeout'), options.timeoutMs ?? 5000)
      options.signal.addEventListener('abort', abort, { once: true })
      if (options.signal.aborted) abort()
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > (options.stdoutLimit ?? OUTPUT_LIMIT)) stop('limit-exceeded')
        else chunks.push(chunk)
      })
      child.stderr.on('data', (chunk: Buffer) => {
        // Drain everything, retain no repository text, account for at most 4 KiB.
        stderrBytes = Math.min(4096, stderrBytes + chunk.length)
      })
      child.stdin.on('error', () => {})
      child.on('error', () => { reason ??= 'git-unavailable' })
      child.on('close', (code) => {
        clearTimeout(timer)
        options.signal.removeEventListener('abort', abort)
        options.stopped?.()
        if (reason || code !== 0) reject(new Error(reason ?? 'git-failed'))
        else resolve(Buffer.concat(chunks))
      })
      child.stdin.end(options.input)
    })
  } finally {
    release()
  }
}

/** Refuse metadata links before opening bytes. The descriptor is checked too. */
const fileBytes = async (path: string, limit = OUTPUT_LIMIT): Promise<Buffer | null> => {
  const info = await lstat(path).catch((error: unknown) => {
    if (missing(error)) return null
    throw error
  })
  if (!info) return null
  if (info.isSymbolicLink()) fail('Linked metadata is not captured.')
  if (!info.isFile()) fail('Special metadata is not captured.')
  if (info.size > limit) fail('limit-exceeded')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await file.stat()
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) fail('metadata-changed')
    const bytes = Buffer.alloc(limit + 1)
    let used = 0
    while (used < bytes.length) {
      const read = await file.read(bytes, used, bytes.length - used, used)
      if (!read.bytesRead) break
      used += read.bytesRead
    }
    if (used > limit) fail('limit-exceeded')
    return bytes.subarray(0, used)
  } finally {
    await file.close()
  }
}

/**
 * Initial admission checks every entry, yielding every 200. Later batches
 * recheck directory identities and enumerate only directories that changed.
 */
class MetadataWalk {
  readonly directories = new Map<string, { stamp: string; children: readonly string[] }>()
  private steps = 0

  async check(path: string, signal: AbortSignal): Promise<void> {
    aborted(signal)
    const info = await lstat(path)
    if (info.isSymbolicLink()) fail('Linked metadata is not captured.')
    if (!info.isFile() && !info.isDirectory()) fail('Special metadata is not captured.')
    if (++this.steps % 200 === 0) await setImmediate()
    if (!info.isDirectory()) return
    const stamp = `${info.dev}:${info.ino}:${info.mtimeMs}:${info.ctimeMs}`
    const cached = this.directories.get(path)
    if (cached?.stamp === stamp) {
      for (const child of cached.children) await this.check(child, signal)
      return
    }
    const children: string[] = []
    for (const name of await readdir(path)) {
      const child = join(path, name)
      const entry = await lstat(child).catch((error: unknown) => {
        if (missing(error)) return null
        throw error
      })
      if (!entry) continue
      if (entry.isSymbolicLink()) fail('Linked metadata is not captured.')
      if (!entry.isFile() && !entry.isDirectory()) fail('Special metadata is not captured.')
      if (++this.steps % 200 === 0) await setImmediate()
      if (entry.isDirectory()) {
        children.push(child)
        await this.check(child, signal)
      }
    }
    this.directories.set(path, { stamp, children })
  }
}

interface Admission {
  readonly walk: MetadataWalk
  readonly stamps: ReadonlyMap<string, string>
  readonly pointers: ReadonlyMap<string, string>
}
const admissions = new WeakMap<RepoHandle, Admission>()
const identity = async (path: string): Promise<string> => {
  const info = await lstat(path)
  if (info.isSymbolicLink()) fail('Linked metadata is not captured.')
  return `${info.dev}:${info.ino}`
}

/** Read storage declarations as data; never ask Git to expand project config. */
const storage = async (commonDir: string): Promise<'sha1' | 'sha256'> => {
  const config = utf8((await fileBytes(join(commonDir, 'config'))) ?? Buffer.alloc(0))
  let section = ''
  let format = 'sha1'
  for (const line of config.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]/.exec(line)
    if (header) {
      section = header[1]!.toLowerCase()
      continue
    }
    if (section !== 'extensions') continue
    const value = /^\s*([a-z]+)\s*=\s*([^#;]*?)\s*(?:[#;].*)?$/i.exec(line)
    if (!value) continue
    const key = value[1]!.toLowerCase()
    const text = value[2]!.replace(/^"(.*)"$/, '$1').toLowerCase()
    if (key === 'objectformat') format = text
    if (key === 'refstorage' && text !== 'files') fail('unsupported-ref-storage')
  }
  if (format !== 'sha1' && format !== 'sha256') fail('unsupported-object-format')
  for (const name of ['alternates', 'http-alternates']) {
    if (await fileBytes(join(commonDir, 'objects/info', name)) !== null) fail('external-objects')
  }
  return format
}

export const admitProject = async (
  root: string,
  stateDir: string,
  known: readonly string[],
): Promise<RepoHandle> => {
  const opened = await realpath(root)
  const roots = [...new Set((await Promise.all(known.map((path) =>
    realpath(path).catch((error: unknown) => {
      if (missing(error)) return null
      throw error
    }),
  ))).filter((path): path is string => path !== null))]
  if (!roots.includes(opened)) fail('unregistered-project')
  const mains = new Map<string, string>()
  const markers = new Set<string>()
  for (const path of roots) {
    const marker = join(path, '.git')
    const info = await lstat(marker).catch((error: unknown) => {
      if (missing(error) && path !== opened) return null
      throw error
    })
    if (!info) continue
    if (info.isSymbolicLink()) {
      if (path === opened) fail('Linked metadata is not captured.')
      continue
    }
    if (info.isDirectory()) mains.set(path, marker)
    else if (info.isFile()) markers.add(path)
    else if (path === opened) fail('Special metadata is not captured.')
  }
  let project = opened
  let commonDir = mains.get(opened)
  const pointers = new Map<string, string>()
  const linked = async (path: string): Promise<{ common: string; gitdir: string } | null> => {
    const marker = join(path, '.git')
    const text = utf8((await fileBytes(marker, 4096)) ?? fail('missing-metadata'))
    const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(text)
    if (!match) return null
    const gitdir = resolve(path, match[1]!)
    // Lexical admission precedes reading any repository-supplied pointer target.
    const common = (commonDir ? [commonDir] : [...mains.values()]).find((candidate) =>
      dirname(gitdir) === join(candidate, 'worktrees'),
    )
    if (!common) return null
    if (await realpath(gitdir) !== gitdir) fail('Linked metadata is not captured.')
    const backPath = join(gitdir, 'gitdir')
    const back = utf8((await fileBytes(backPath, 4096)) ?? fail('metadata-changed'))
    if (resolve(gitdir, back.trim()) !== marker) fail('metadata-changed')
    const commonPath = join(gitdir, 'commondir')
    const commonText = utf8((await fileBytes(commonPath, 4096)) ?? fail('metadata-changed'))
    if (resolve(gitdir, commonText.trim()) !== common) fail('metadata-changed')
    pointers.set(marker, text)
    pointers.set(backPath, back)
    pointers.set(commonPath, commonText)
    return { common, gitdir }
  }
  if (!commonDir) {
    const link = await linked(opened)
    if (!link) fail('Open its main checkout to capture this project.')
    commonDir = link.common
    project = [...mains].find(([, common]) => common === commonDir)![0]
  }
  if (!inside(project, commonDir)) fail('external-metadata')
  const checkouts = new Map<string, string>([[project, commonDir]])
  for (const path of markers) {
    const link = await linked(path)
    if (link?.common === commonDir) checkouts.set(path, link.gitdir)
  }
  const walk = new MetadataWalk()
  await walk.check(commonDir, new AbortController().signal)
  const objectFormat = await storage(commonDir)
  const objectDir = join(commonDir, 'objects')
  const stamps = new Map<string, string>()
  for (const path of [commonDir, objectDir, ...checkouts.values()]) stamps.set(path, await identity(path))
  await mkdir(stateDir, { recursive: true })
  const viewDir = await mkdtemp(join(await realpath(stateDir), 'provenance-view-'))
  try {
    await mkdir(join(viewDir, 'refs'))
    await mkdir(join(viewDir, 'objects'))
    await writeFile(join(viewDir, 'HEAD'), 'ref: refs/heads/capture\n', { mode: 0o600 })
    await writeFile(join(viewDir, 'config'), objectFormat === 'sha256'
      ? '[core]\nrepositoryformatversion = 1\nbare = true\n[extensions]\nobjectFormat = sha256\n'
      : '[core]\nrepositoryformatversion = 0\nbare = true\n', { mode: 0o600 })
    const handle: RepoHandle = { project, commonDir, objectDir, viewDir, checkouts, objectFormat }
    admissions.set(handle, { walk, stamps, pointers })
    return handle
  } catch (error) {
    await rm(viewDir, { recursive: true, force: true })
    throw error
  }
}

export const gitReader = (handle: RepoHandle): GitReader => {
  const admission = admissions.get(handle) ?? fail('unadmitted-project')
  const lifetime = new AbortController()
  let queue: Promise<unknown> = Promise.resolve()
  const width = handle.objectFormat === 'sha1' ? 40 : 64
  const objectId = (value: string) => {
    oid(value)
    if (value.length !== width) fail('wrong-object-format')
    return value
  }
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    LANG: 'C', LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull,
    GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
    GIT_NO_LAZY_FETCH: '1', GIT_ALTERNATE_OBJECT_DIRECTORIES: '',
    GIT_OBJECT_DIRECTORY: handle.objectDir,
  }
  const run = (args: readonly string[], signal: AbortSignal, input?: Buffer) => runChild('git', [
    '--no-pager', '--no-replace-objects', '--literal-pathspecs', '-C', handle.viewDir,
    '-c', `core.hooksPath=${devNull}`, '-c', 'core.fsmonitor=false',
    '-c', 'diff.external=', '-c', 'core.quotePath=true', ...args,
  ], { signal, input, env })
  const validate = async (signal: AbortSignal) => {
    aborted(signal)
    for (const [path, stamp] of admission.stamps) {
      if (await identity(path) !== stamp) fail('metadata-changed')
    }
    await admission.walk.check(handle.commonDir, signal)
    if (await storage(handle.commonDir) !== handle.objectFormat) fail('metadata-changed')
    for (const [path, text] of admission.pointers) {
      if ((await fileBytes(path, 4096))?.toString('utf8') !== text) fail('metadata-changed')
    }
  }
  const job = <T>(signal: AbortSignal, action: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const combined = AbortSignal.any([signal, lifetime.signal])
    const next = queue.then(async () => {
      aborted(combined)
      await validate(combined)
      return action(combined)
    })
    queue = next.catch(() => {})
    return next
  }
  const kind = async (sha: string, signal: AbortSignal): Promise<string | null> => {
    const answer = utf8(await run(['cat-file', '--batch-check=%(objecttype)'], signal,
      Buffer.from(`${objectId(sha)}\n`))).trim()
    return answer.endsWith(' missing') ? null : answer
  }
  const commit = async (sha: string, signal: AbortSignal): Promise<CommitObject | null> => {
    if (await kind(sha, signal) !== 'commit') return null
    const bytes = await run(['cat-file', 'commit', objectId(sha)], signal)
    const end = bytes.indexOf('\n\n')
    if (end < 0) fail('invalid-commit')
    const headers = utf8(bytes.subarray(0, end)).split('\n')
    const tree = headers.find((line) => line.startsWith('tree '))?.slice(5)
    if (!tree) fail('invalid-commit')
    return {
      sha,
      tree: objectId(tree),
      parents: headers.filter((line) => line.startsWith('parent ')).map((line) => objectId(line.slice(7))),
    }
  }
  const peel = async (sha: string, signal: AbortSignal): Promise<string | null> => {
    for (let depth = 0; depth < 8; depth += 1) {
      const type = await kind(sha, signal)
      if (type === 'commit') return sha
      if (type !== 'tag') return null
      const tag = utf8(await run(['cat-file', 'tag', objectId(sha)], signal))
      const target = /^object ([a-f0-9]+)\n/.exec(tag)?.[1]
      if (!target) fail('invalid-tag')
      sha = objectId(target)
    }
    return fail('tag-depth-exceeded')
  }
  const entries = async (root: string): Promise<readonly { path: string; name: string }[]> => {
    const found: { path: string; name: string }[] = []
    let visited = 0
    const visit = async (path: string, prefix: string) => {
      const names = await readdir(path).catch((error: unknown) => {
        if (missing(error)) return []
        throw error
      })
      for (const name of names.sort()) {
        if (name.endsWith('.lock')) continue
        if (++visited > REF_LIMIT) fail('limit-exceeded')
        const full = join(path, name)
        const info = await lstat(full)
        if (info.isSymbolicLink()) fail('Linked metadata is not captured.')
        if (info.isDirectory()) await visit(full, `${prefix}${name}/`)
        else if (info.isFile()) found.push({ path: full, name: `${prefix}${name}` })
        else fail('Special metadata is not captured.')
        if (found.length > REF_LIMIT) fail('limit-exceeded')
      }
    }
    await visit(root, '')
    return found
  }
  const snapshot = async (signal: AbortSignal): Promise<RefSnapshot> => {
    const values = new Map<string, string>()
    const packed = await fileBytes(join(handle.commonDir, 'packed-refs'))
    for (const line of packed?.toString('utf8').split('\n') ?? []) {
      if (!line || line.startsWith('#') || line.startsWith('^')) continue
      const split = line.indexOf(' ')
      const name = line.slice(split + 1)
      if (split < 0 || !refName(name)) fail('invalid-ref')
      values.set(name, objectId(line.slice(0, split)))
    }
    for (const entry of await entries(join(handle.commonDir, 'refs'))) {
      const name = `refs/${entry.name}`
      if (!refName(name)) fail('invalid-ref')
      const bytes = await fileBytes(entry.path, 4096)
      if (bytes) values.set(name, utf8(bytes).trim())
    }
    if (values.size > REF_LIMIT) fail('limit-exceeded')
    const resolveRef = (value: string): string | null => {
      const seen = new Set<string>()
      for (let depth = 0; depth < 8; depth += 1) {
        if (!value.startsWith('ref: ')) return objectId(value)
        const name = value.slice(5)
        if (!refName(name)) fail('invalid-ref')
        if (seen.has(name)) fail('symbolic-ref-cycle')
        seen.add(name)
        const next = values.get(name)
        if (!next) return null
        value = next
      }
      return fail('symbolic-ref-depth-exceeded')
    }
    const refs = new Map<string, string>()
    for (const [name, value] of values) {
      const sha = resolveRef(value)
      if (sha) refs.set(name, sha)
    }
    const heads = new Map<string, string | null>()
    for (const [cwd, gitdir] of handle.checkouts) {
      const head = await fileBytes(join(gitdir, 'HEAD'), 4096)
      const sha = head ? resolveRef(utf8(head).trim()) : null
      heads.set(cwd, sha ? await peel(sha, signal) : null)
    }
    return { refs, heads, takenAt: Date.now() }
  }
  const deltaArgs = (from: string | null, to: string, names: boolean, path?: string): string[] => [
    'diff-tree', '--no-commit-id', '-r', '--no-renames',
    ...(names ? ['--name-only', '-z'] : [
      '-p', '--binary', '--no-ext-diff', '--no-textconv', '--full-index',
      '--src-prefix=a/', '--dst-prefix=b/',
    ]),
    ...(from === null ? ['--root', objectId(to)] : [objectId(from), objectId(to)]),
    '--', ...(path === undefined ? [] : [path]),
  ]
  const fingerprint = async (from: string | null, to: string, signal: AbortSignal, path?: string): Promise<Patch> => {
    const target = await commit(to, signal)
    if (!target || (from !== null && !await commit(from, signal))) fail('missing-object')
    if (from === null && target.parents.length > 1) fail('unsupported-merge')
    const bytes = await run(deltaArgs(from, to, false, path), signal)
    const names = utf8(await run(deltaArgs(from, to, true, path), signal))
      .split('\0').filter(Boolean).sort()
    if (!names.length) return { stable: '', exact: '', files: [] }
    const stable = utf8(await run(['patch-id', '--stable'], signal, bytes)).trim().split(' ')[0]!
    const exact = utf8(await run(['patch-id', '--verbatim'], signal, bytes)).trim().split(' ')[0]!
    oid(stable)
    oid(exact)
    return { stable, exact, files: names }
  }
  const reflogs = async (previous: ReadonlyMap<string, LogCursor>, signal: AbortSignal): Promise<ReflogPage> => {
    const logs: { key: string; path: string; ref: string; checkout: string | null }[] = []
    for (const entry of await entries(join(handle.commonDir, 'logs/refs'))) {
      const ref = `refs/${entry.name}`
      if (!refName(ref)) fail('invalid-ref')
      logs.push({ key: `common:${ref}`, path: entry.path, ref, checkout: null })
    }
    for (const [checkout, gitdir] of handle.checkouts) {
      const path = join(gitdir, 'logs/HEAD')
      if (await lstat(path).catch((error: unknown) => missing(error) ? null : Promise.reject(error))) {
        logs.push({ key: `head:${checkout}`, path, ref: 'HEAD', checkout })
      }
    }
    const cursors = new Map(previous)
    const moves: ReflogMove[] = []
    const gaps = new Set<string>()
    for (const key of previous.keys()) {
      if (!logs.some((log) => log.key === key)) {
        gaps.add('reflog-missing')
        cursors.delete(key)
      }
    }
    let budget = LOG_LIMIT
    let more = false
    for (const log of logs.sort((a, b) => a.key.localeCompare(b.key))) {
      aborted(signal)
      if (budget <= 0) {
        more = true
        break
      }
      const info = await lstat(log.path)
      if (info.isSymbolicLink()) fail('Linked metadata is not captured.')
      if (!info.isFile()) fail('Special metadata is not captured.')
      const file = await open(log.path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const opened = await file.stat()
        if (opened.dev !== info.dev || opened.ino !== info.ino) fail('metadata-changed')
        const fileId = `${info.dev}:${info.ino}:${info.birthtimeMs}`
        let offset = previous.get(log.key)?.offset ?? 0
        const prior = previous.get(log.key)
        const tail = async (at: number) => {
          const bytes = Buffer.alloc(Math.min(256, at))
          const read = await file.read(bytes, 0, bytes.length, at - bytes.length)
          return hash(bytes.subarray(0, read.bytesRead))
        }
        if (prior && (prior.fileId !== fileId || offset > info.size || prior.tailHash !== await tail(offset))) {
          gaps.add('reflog-replaced')
          offset = 0
        }
        const bytes = Buffer.alloc(Math.min(budget, Math.max(0, info.size - offset)))
        const read = await file.read(bytes, 0, bytes.length, offset)
        const page = bytes.subarray(0, read.bytesRead)
        const end = page.lastIndexOf(10) + 1
        if (end < page.length && offset + page.length === info.size) gaps.add('incomplete-reflog')
        let start = 0
        while (start < end) {
          const stop = page.indexOf(10, start)
          const line = page.subarray(start, stop)
          if (line.length > 64 * 1024) fail('limit-exceeded')
          const before = line.subarray(0, width).toString('ascii')
          const after = line.subarray(width + 1, 2 * width + 1).toString('ascii')
          if (line[width] !== 32 || line[2 * width + 1] !== 32) fail('invalid-reflog')
          objectId(before)
          objectId(after)
          const time = / (\d+) [+-]\d{4}\t/.exec(line.subarray(2 * width + 2).toString('utf8'))
          moves.push({
            id: hash(JSON.stringify([log.key, fileId, offset + start, hash(line)])),
            ref: log.ref,
            checkout: log.checkout,
            before: /^0+$/.test(before) ? null : before,
            after: /^0+$/.test(after) ? null : after,
            recordedAt: time ? Number(time[1]) * 1000 : null,
          })
          start = stop + 1
        }
        if (!end && page.length === budget && info.size - offset > page.length) fail('limit-exceeded')
        offset += end
        budget -= page.length
        cursors.set(log.key, { fileId, offset, tailHash: await tail(offset) })
        if (offset < info.size && end === page.length) more = true
        if (end < page.length && info.size > offset + page.length - end) more = true
      } finally {
        await file.close()
      }
    }
    return { moves, cursors, gaps: [...gaps].sort(), more }
  }
  return {
    snapshot: (signal) => job(signal, snapshot),
    reflogs: (cursors, signal) => job(signal, (signal) => reflogs(cursors, signal)),
    commit: (sha, signal) => job(signal, (signal) => commit(objectId(sha), signal)),
    patch: (from, to, signal) => job(signal, (signal) => fingerprint(from, to, signal)),
    files: (from, to, signal) => job(signal, async (signal) => {
      const patch = await fingerprint(from, to, signal)
      const files: FilePatch[] = []
      for (const path of patch.files) {
        const file = await fingerprint(from, to, signal, path)
        files.push({ path, stable: file.stable, exact: file.exact })
      }
      return files
    }),
    ancestors: (tips, known, limit, signal) => job(signal, async (signal) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) fail('limit-exceeded')
      const input = [...tips.map(objectId), ...[...known].map((sha) => `^${objectId(sha)}`)]
      const bytes = await run(['rev-list', '--topo-order', '--reverse', `--max-count=${limit}`, '--stdin'], signal,
        Buffer.from(`${input.join('\n')}\n`))
      return utf8(bytes).trim().split('\n').filter(Boolean).map(objectId)
    }),
    close: async () => {
      lifetime.abort()
      await queue
      await rm(handle.viewDir, { recursive: true, force: true })
    },
  }
}
