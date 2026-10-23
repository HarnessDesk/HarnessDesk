import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { HARDENED_GIT_CONFIG, automaticMutationConfig } from './git-hardening.js'
import { parsePorcelain, type PorcelainEntry } from './porcelain.js'

const exec = promisify(execFile)
const commandAt = (args: readonly string[]): number => {
  for (let i = 0; i < args.length; i++) {
    if (['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(args[i]!)) i++
    else if (!args[i]!.startsWith('-')) return i
  }
  return -1
}
interface ReadOptions {
  readonly timeout?: number
  readonly maxBuffer?: number
  readonly signal?: AbortSignal
  readonly env?: NodeJS.ProcessEnv
}
type Output = { readonly stdout: string; readonly stderr: string }
type Setting = { readonly key: string; readonly value: string | null }
/** Standard input comes from one place: bytes written once, or the output of another git command. */
type StreamSource =
  | { readonly input?: string | Buffer; readonly feed?: undefined }
  | { readonly feed: readonly string[]; readonly input?: undefined }
type StreamOptions = StreamSource & {
  /** Variables added to the view's environment for this command only. */
  readonly env?: NodeJS.ProcessEnv
}
interface View {
  readonly root: string
  readonly gitDir: string
  readonly settings: readonly Setting[]
  /** One command, its output held and bounded by the caller's `maxBuffer`. */
  run(args: readonly string[], input?: string, env?: NodeJS.ProcessEnv): Promise<Output>
  /**
   * One command whose output is handed over as it arrives and never held, so
   * none of it counts against `maxBuffer`. That limit bounds what the host
   * returns to a caller, not what it reads to decide what to return: a status
   * has to look at every index entry however small its own answer is.
   */
  stream(args: readonly string[], onData: (chunk: Buffer) => void, options?: StreamOptions): Promise<void>
}

const STDERR_KEPT = 64 * 1024

/**
 * Start git, and settle at its `close` the way `exec` does: quietly after a
 * clean exit, otherwise with an error that carries the exit `code`, or `killed`
 * and `signal` when a timeout stopped it, or the abort error. Settling only
 * after `close` means nothing the process was writing outlives the caller.
 */
const launch = (
  argv: readonly string[],
  limits: { readonly env: NodeJS.ProcessEnv; readonly timeout: number; readonly signal?: AbortSignal },
  stdin: { readonly mode: 'ignore' | 'pipe'; readonly input?: string | Buffer },
  onData?: (chunk: Buffer) => void,
): { readonly child: ChildProcess; readonly closed: Promise<void> } => {
  const child: ChildProcess = spawn('git', argv, { ...limits, stdio: [stdin.mode, 'pipe', 'pipe'] })
  let failure: unknown
  let stderr = ''
  child.stderr!.setEncoding('utf8')
  child.stderr!.on('data', (text: string) => { if (stderr.length < STDERR_KEPT) stderr += text })
  if (onData) {
    child.stdout!.on('data', (chunk: Buffer) => {
      if (failure !== undefined) return
      try { onData(chunk) } catch (error) { failure = error; child.kill() }
    })
  }
  const closed = new Promise<void>((resolve, reject) => {
    child.once('error', (error) => { failure ??= error })
    child.once('close', (code, signal) => {
      if (failure !== undefined) reject(failure)
      else if (code === 0) resolve()
      else reject(Object.assign(new Error(`Command failed: git ${argv.join(' ')}\n${stderr}`), { code, signal, killed: child.killed, stderr }))
    })
  })
  if (stdin.mode === 'pipe') {
    child.stdin!.on('error', () => {}) // the process result owns a refusal
    if (stdin.input !== undefined) child.stdin!.end(stdin.input)
  }
  return { child, closed }
}

/** NUL-terminated fields across chunks. `ended` says whether the last one was terminated. */
const nulFields = (onField: (field: Buffer) => void) => {
  let tail: Buffer = Buffer.alloc(0)
  return {
    push: (chunk: Buffer): void => {
      let start = 0
      for (let end = chunk.indexOf(0); end >= 0; end = chunk.indexOf(0, start)) {
        onField(tail.length > 0 ? Buffer.concat([tail, chunk.subarray(start, end)]) : chunk.subarray(start, end))
        tail = Buffer.alloc(0)
        start = end + 1
      }
      if (start < chunk.length) tail = Buffer.concat([tail, chunk.subarray(start)])
    },
    ended: (): boolean => tail.length === 0,
  }
}

const settingsOf = (text: string): Setting[] => text.split('\0').filter(Boolean).map(field => {
  const at = field.indexOf('\n')
  return at < 0 ? { key: field, value: null } : { key: field.slice(0, at), value: field.slice(at + 1) }
})
const valueOf = (settings: readonly Setting[], key: string): string | undefined =>
  settings.findLast(setting => setting.key === key)?.value ?? undefined
const quote = (value: string): string => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n').replaceAll('\t', '\\t').replaceAll('\b', '\\b')}"`

/** Flatten includes once. The consumer has no includes, filter definitions or live config path. */
const sanitizedConfig = (settings: readonly Setting[]): string => settings.map(({ key, value }) => {
  const first = key.indexOf('.')
  const last = key.lastIndexOf('.')
  const section = key.slice(0, first).toLowerCase()
  if (section === 'filter') {
    // Retain the existing refusal for names command-line overrides cannot represent.
    if (key.slice(first + 1, last).includes('=')) throw new Error('This git filter name cannot be disabled for an automatic read.')
    return ''
  }
  if (section === 'include' || section === 'includeif' || key.toLowerCase() === 'extensions.worktreeconfig') return ''
  const variable = key.slice(last + 1)
  if (!/^[a-z0-9-]+$/.test(section) || !/^[a-z][a-z0-9-]*$/i.test(variable)) {
    throw new Error('Git configuration could not be copied for this read.')
  }
  const subsection = first === last ? '' : ` ${quote(key.slice(first + 1, last))}`
  return `[${section}${subsection}]\n${variable}${value === null ? '' : ` = ${quote(value)}`}\n`
}).join('')

/**
 * Share repository data, never its configuration. A private Git directory
 * keeps refs, objects and the index readable without consulting config again.
 * Optional index writes and lazy fetching are disabled for the whole read.
 */
const withView = async <T>(cwd: string, options: ReadOptions, consume: (view: View) => Promise<T>): Promise<T> => {
  const original = (args: readonly string[]) => exec('git', ['-C', cwd, ...HARDENED_GIT_CONFIG, ...args], {
    ...options, timeout: options.timeout ?? 20_000, maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
  })
  const [root, dir, common, listed] = await Promise.all([
    ...['--show-toplevel', '--git-dir', '--git-common-dir'].map(async flag =>
      (await original(['rev-parse', '--path-format=absolute', flag])).stdout.replace(/\n$/, '')),
    original(['config', '--null', '--list', '--includes']).then(result => result.stdout),
  ])
  const settings = settingsOf(listed!)
  const config = sanitizedConfig(settings)
  const home = await mkdtemp(join(tmpdir(), 'hd-git-read-'))
  try {
    await writeFile(join(home, 'config'), config, { mode: 0o600 })
    await writeFile(join(home, 'HEAD'), await readFile(join(dir!, 'HEAD')))
    for (const name of ['objects', 'refs', 'packed-refs', 'shallow', 'reftable']) {
      await symlink(join(common!, name), join(home, name))
    }
    await symlink(join(dir!, 'index'), join(home, 'index'))
    for (const name of (await readdir(dir!)).filter(name => /^sharedindex\.[0-9a-f]+$/.test(name))) {
      await symlink(join(dir!, name), join(home, name))
    }
    await mkdir(join(home, 'info'))
    for (const name of ['exclude', 'attributes']) {
      await symlink(join(common!, 'info', name), join(home, 'info', name))
    }
    await symlink(join(dir!, 'info', 'sparse-checkout'), join(home, 'info', 'sparse-checkout'))
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(options.env ?? process.env).filter(([key]) => !key.startsWith('GIT_')))
    Object.assign(env, {
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0',
      GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat',
      ...(options.env?.GIT_INDEX_FILE ? { GIT_INDEX_FILE: options.env.GIT_INDEX_FILE } : {}),
    })
    const argv = (args: readonly string[]) => [
      '-C', cwd, `--git-dir=${home}`, `--work-tree=${root}`, ...HARDENED_GIT_CONFIG, '-c', 'core.bare=false', ...args,
    ]
    const timeout = options.timeout ?? 20_000
    return await consume({ root: root!, gitDir: dir!, settings, run: async (args, input, extra) => {
      const pending = exec('git', argv(args), {
        ...options, env: extra ? { ...env, ...extra } : env, timeout, maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
      })
      const closed = new Promise<void>(resolve => pending.child.once('close', () => resolve()))
      if (input !== undefined) {
        pending.child.stdin?.on('error', () => {}) // the process result owns a refusal
        pending.child.stdin?.end(input)
      }
      // Keep the private view until an aborted process has finished writing.
      try { return await pending } finally { await closed }
    }, stream: async (args, onData, streamOptions = {}) => {
      const limits = { env: streamOptions.env ? { ...env, ...streamOptions.env } : env, timeout, signal: options.signal }
      const piped = streamOptions.feed !== undefined || streamOptions.input !== undefined
      const reader = launch(argv(args), limits, { mode: piped ? 'pipe' : 'ignore', input: streamOptions.input }, onData)
      const writer = streamOptions.feed ? launch(argv(streamOptions.feed), limits, { mode: 'ignore' }) : undefined
      if (writer) writer.child.stdout!.pipe(reader.child.stdin!)
      // The first failure is the cause. Stopping the other end is how it learns of it:
      // a listing nobody reads would wait on its pipe, and a reader cannot tell a short listing.
      let cause: { readonly error: unknown } | undefined
      const failed = (error: unknown, other?: ChildProcess) => { cause ??= { error }; other?.kill() }
      await Promise.all([
        reader.closed.catch(error => failed(error, writer?.child)),
        writer?.closed.catch(error => failed(error, reader.child)),
      ])
      if (cause) throw cause.error
    } })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

const NEEDS_FILTER = 'This checkout needs a git filter (such as LFS). Create it yourself so its files are converted.'

/**
 * Walk the target tree's attributes as they are listed, holding none of them.
 * Refuses at the first path that names a driver; returns the paths whose filter
 * reads `unset` or `unspecified`. Git prints those words both for an attribute
 * that is off and for a driver literally called that, and `--all` leaves out
 * the unspecified ones, so only an explicit setting is ever returned.
 */
const unsetFilters = async (view: View): Promise<Buffer[]> => {
  const unset: Buffer[] = []
  let place = 0
  let path: Buffer = Buffer.alloc(0)
  let filter = false
  const fields = nulFields(field => {
    if (place === 0) path = field
    else if (place === 1) filter = field.toString('latin1') === 'filter'
    else if (filter) {
      const value = field.toString('latin1')
      if (value !== 'unspecified' && value !== 'unset') throw new Error(NEEDS_FILTER)
      unset.push(Buffer.from(path))
    }
    place = (place + 1) % 3
  })
  await view.stream(['check-attr', '--cached', '--all', '-z', '--stdin'], fields.push, { feed: ['ls-files', '-z'] })
  if (!fields.ended() || place !== 0) throw new Error('Git ended its attribute listing in the middle of a record.')
  return unset
}

/**
 * Tell a driver literally named `unset` or `unspecified` from the attribute
 * being off, for the paths `unsetFilters` could not. Git's conversion does:
 * with required drivers of those names that have no command, it refuses a path
 * that names one. An empty file validates the attributes without reading data.
 */
const refuseLiteralDrivers = async (view: View, paths: readonly Buffer[], scratch: string): Promise<void> => {
  const sentinels = ['-c', 'filter.unset.required=true', '-c', 'filter.unspecified.required=true']
  // One question per line: `cat-file` drops leading blanks and a trailing CR and cannot hold a newline.
  const asked: Buffer[] = []
  const alone: Buffer[] = []
  for (const path of paths) {
    (path.includes(10) || path.at(-1) === 13 || path[0] === 32 || path[0] === 9 ? alone : asked).push(path)
  }
  if (asked.length > 0) {
    // The empty blob the questions name, kept apart from the repository's own objects.
    const store = join(scratch, 'objects')
    await mkdir(store)
    const blob = (await view.run(['hash-object', '-w', '--stdin'], '', { GIT_OBJECT_DIRECTORY: store })).stdout.trim()
    const lead = Buffer.from(`${blob} `)
    const input = Buffer.allocUnsafe(asked.reduce((size, path) => size + lead.length + path.length + 1, 0))
    let at = 0
    for (const path of asked) {
      at += lead.copy(input, at)
      at += path.copy(input, at)
      input[at++] = 10
    }
    const answers: Buffer[] = []
    await view.stream([...sentinels, 'cat-file', '--batch=ok', '--buffer', '--filters'], chunk => answers.push(chunk), {
      input, env: { GIT_ALTERNATE_OBJECT_DIRECTORIES: store },
    })
    // One acknowledgement per path. A missing object prints a different line and still exits cleanly.
    if (!Buffer.concat(answers).equals(Buffer.from('ok\n\n'.repeat(asked.length)))) {
      throw new Error('The checkout could not be checked for git filters.')
    }
  }
  for (const path of alone) {
    const spelled = path.toString('utf8')
    if (!Buffer.from(spelled).equals(path)) throw new Error('The checkout could not be checked for git filters.')
    await view.run([...sentinels, 'hash-object', `--path=${spelled}`, '--stdin'], '')
  }
}

/** Validate and optionally materialize a tree using one private configuration and index. */
export const automaticCheckout = async (
  cwd: string, revision: string, options: ReadOptions & { readonly materialize?: boolean } = {},
): Promise<{ readonly at: string; readonly config: readonly string[] }> => {
  const scratch = await mkdtemp(join(tmpdir(), 'hd-checkout-index-'))
  const index = join(scratch, 'index')
  try {
    return await withView(cwd, { ...options, env: { ...(options.env ?? process.env), GIT_INDEX_FILE: index } }, async view => {
      const at = (await view.run(['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`])).stdout.trim()
      await view.run(['read-tree', at])
      const unset = await unsetFilters(view)
      if (options.materialize) {
        // Apply sparse patterns while writing the tree and the private index.
        await view.run(['read-tree', '--reset', '-u', '--no-recurse-submodules', at])
        await refuseLiteralDrivers(view, unset, scratch)
        const lock = join(view.gitDir, 'index.lock')
        await writeFile(lock, await readFile(index), { flag: 'wx' })
        try { await rename(lock, join(view.gitDir, 'index')) }
        finally { await rm(lock, { force: true }) }
      }
      return { at, config: HARDENED_GIT_CONFIG }
    })
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/** Git's C-style pathname spelling for non-NUL porcelain readers. */
const shownPath = (path: string, quoteHigh: boolean): string => {
  const escapes: Record<number, string> = { 7: '\\a', 8: '\\b', 9: '\\t', 10: '\\n', 11: '\\v', 12: '\\f', 13: '\\r', 34: '\\"', 92: '\\\\' }
  let needsQuote = path.includes(' ')
  let shown = ''
  // Preserve Unicode when quotePath is off, while escaping ASCII controls.
  for (const char of path) {
    const code = char.codePointAt(0)!
    if (escapes[code] || code < 32 || code === 127 || (quoteHigh && code > 127)) {
      needsQuote = true
      shown += escapes[code] ?? [...Buffer.from(char)].map(byte => `\\${byte.toString(8).padStart(3, '0')}`).join('')
    } else shown += char
  }
  return needsQuote ? `"${shown}"` : shown
}

const serialize = (entries: readonly PorcelainEntry[], nul: boolean, quoteHigh: boolean): string => entries.map(entry => {
  const status = entry.index + entry.worktree + ' '
  if (nul) return `${status}${entry.path}\0${entry.origin === null ? '' : `${entry.origin}\0`}`
  return `${status}${entry.origin === null ? '' : `${shownPath(entry.origin, quoteHigh)} -> `}${shownPath(entry.path, quoteHigh)}\n`
}).join('')

const submoduleSettings = async (view: View): Promise<Setting[]> => {
  const file = join(view.root, '.gitmodules')
  if (!await access(file).then(() => true, () => false)) return [...view.settings]
  const local = settingsOf((await view.run(['config', '--null', '--file', file, '--list'])).stdout)
  return [...local, ...view.settings]
}

/** Never let parent status start a child status. Read each initialized child through its own view. */
const statusInView = async (view: View, args: readonly string[], options: ReadOptions, seen: ReadonlySet<string>): Promise<Output> => {
  const root = await realpath(view.root)
  if (seen.has(root) || seen.size >= 16) throw new Error('The submodule checkout layout cannot be read.')
  const visited = new Set([...seen, root])
  const command = commandAt(args)
  const end = args.indexOf('--') < 0 ? args.length : args.indexOf('--')
  const nul = args.slice(0, end).includes('-z') || args.slice(0, end).includes('--null')
  const ignore = args.slice(0, end).findLast(arg => arg.startsWith('--ignore-submodules'))
  const explicit = ignore === '--ignore-submodules' ? 'all' : ignore?.split('=')[1]
  const statusArgs = args.filter((arg, i) => i >= end || (arg !== '-z' && arg !== '--null' && !arg.startsWith('--ignore-submodules')))
  statusArgs.splice(command + 1, 0, `--ignore-submodules=${explicit === 'all' ? 'all' : 'dirty'}`, '-z')
  const output = await view.run(statusArgs)
  const entries = [...parsePorcelain(output.stdout)]
  if (explicit !== 'all') {
    const pathspec = args.indexOf('--')
    // Only the gitlinks are kept; the listing itself is as long as the index and is not held.
    const links: string[] = []
    const listing = nulFields(record => {
      if (record.toString('latin1', 0, 7) === '160000 ') links.push(record.toString('utf8'))
    })
    await view.stream(['ls-files', '--stage', '--full-name', '-z', ...(pathspec < 0 ? ['--', ':/'] : args.slice(pathspec))], listing.push)
    if (!listing.ended()) throw new Error('Git ended its index listing in the middle of a record.')
    const settings = links.length > 0 ? await submoduleSettings(view) : view.settings
    const untrackedFlag = args.slice(command + 1, end).findLast(arg => /^(-u(no|normal|all)?|--untracked-files(=(no|normal|all))?)$/.test(arg))
    const untracked = untrackedFlag === undefined
      ? valueOf(view.settings, 'status.showuntrackedfiles') ?? 'normal'
      : untrackedFlag.startsWith('--') ? untrackedFlag.split('=')[1] ?? 'all' : untrackedFlag.slice(2) || 'all'
    for (const link of links) {
      const match = /^160000 ([0-9a-f]+) 0\t(.+)$/s.exec(link)
      if (!match) continue
      const indexed = match[1]!
      const path = match[2]!
      const name = settings.find(setting => setting.key.startsWith('submodule.') && setting.key.endsWith('.path') && setting.value === path)?.key.slice(0, -5)
      const ignored = explicit ?? (name ? valueOf(settings, `${name}.ignore`) : undefined) ?? valueOf(settings, 'diff.ignoresubmodules') ?? 'none'
      if (ignored === 'all') {
        const at = entries.findIndex(entry => entry.path === path)
        const entry = entries[at]
        if (entry?.worktree === 'M') {
          if (entry.index === ' ') entries.splice(at, 1)
          else entries[at] = { ...entry, worktree: ' ' }
        }
        continue
      }
      const child = join(view.root, path)
      if (!await access(join(child, '.git')).then(() => true, () => false)) continue
      const changed = await withView(child, options, async childView => {
        if (await realpath(childView.root) !== await realpath(child)) throw new Error('The submodule checkout root changed.')
        const head = (await childView.run(['rev-parse', '--verify', 'HEAD'])).stdout.trim()
        if (head !== indexed) return true
        if (ignored === 'dirty') return false
        const status = await statusInView(childView, ['status', '--porcelain=v1', '-z', `--untracked-files=${ignored === 'untracked' || untracked === 'no' ? 'no' : 'normal'}`], options, visited)
        return status.stdout.length > 0
      })
      if (!changed) continue
      const at = entries.findIndex(entry => entry.path === path)
      if (at >= 0) {
        const entry = entries[at]!
        if (entry.worktree === ' ') entries[at] = { ...entry, worktree: 'M' }
      } else {
        const before = entries.findIndex(entry => entry.index === '?' || entry.index === '!' || Buffer.compare(Buffer.from(entry.path), Buffer.from(path)) > 0)
        entries.splice(before < 0 ? entries.length : before, 0, { index: ' ', worktree: 'M', path, origin: null })
      }
    }
  }
  return { ...output, stdout: serialize(entries, nul, !/^(false|no|off|0)$/i.test(valueOf(view.settings, 'core.quotepath') ?? 'true')) }
}

/** Automatic working-file reads consume a private config; requested writes keep their existing runners. */
export const readGit = async (cwd: string, args: readonly string[], options: ReadOptions = {}): Promise<Output> => {
  const command = commandAt(args)
  if (args[command] === 'status') return withView(cwd, options, view => statusInView(view, args, options, new Set()))
  if (args[command] === 'diff') return withView(cwd, options, view => {
    const end = args.indexOf('--') < 0 ? args.length : args.indexOf('--')
    const flags = args.filter((arg, i) => i >= end || (!arg.startsWith('--ignore-submodules') && !arg.startsWith('--submodule') && arg !== '--ext-diff' && arg !== '--textconv'))
    flags.splice(command + 1, 0, '--ignore-submodules=dirty', '--submodule=short', '--no-ext-diff', '--no-textconv')
    return view.run(flags)
  })
  return exec('git', ['-C', cwd, ...await automaticMutationConfig(cwd, args, options), ...args], {
    ...options, timeout: options.timeout ?? 20_000, maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
  })
}
