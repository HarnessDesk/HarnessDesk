import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
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
interface View {
  readonly root: string
  readonly settings: readonly Setting[]
  run(args: readonly string[]): Promise<Output>
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
    return await consume({ root: root!, settings, run: args => exec('git', [
      '-C', cwd, `--git-dir=${home}`, `--work-tree=${root}`, ...HARDENED_GIT_CONFIG,
      '-c', 'core.bare=false', ...args,
    ], { ...options, env, timeout: options.timeout ?? 20_000, maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024 }) })
  } finally {
    await rm(home, { recursive: true, force: true })
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
    const links = (await view.run(['ls-files', '--stage', '--full-name', '-z', ...(pathspec < 0 ? ['--', ':/'] : args.slice(pathspec))])).stdout.split('\0')
    const settings = await submoduleSettings(view)
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
        const status = await statusInView(childView, ['status', '--porcelain=v1', '-z', `--untracked-files=${ignored === 'untracked' ? 'no' : 'normal'}`], options, visited)
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
