import { execFile } from 'node:child_process'
import { readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { repoKey, type RepoInfo } from '@harnessdesk/protocol'
import { HARDENED_GIT_CONFIG } from './git-hardening.js'

interface RepoCache {
  repo(cwd: string): { repo: RepoInfo | null; exists: boolean; checkedAt: number; identity?: string } | null
  putRepo(cwd: string, value: { repo: RepoInfo | null; exists: boolean; checkedAt: number; identity?: string }): void
}

interface Options {
  resolve?: (cwd: string) => Promise<RepoInfo | null>
  execute?: (args: readonly string[], env: NodeJS.ProcessEnv) => Promise<string>
  now?: () => number
  onResolved?: (cwd: string, repo: RepoInfo | null) => void
  env?: NodeJS.ProcessEnv
}

const run = promisify(execFile)
const executeGit = async (args: readonly string[], env: NodeJS.ProcessEnv): Promise<string> =>
  (await run('git', [...args], { env, timeout: 20_000, maxBuffer: 1024 * 1024 })).stdout

/** A persisted miss is an answer too; reads never wait for filesystem or Git. */
export class SessionIndexRepos {
  readonly #index: RepoCache
  readonly #options: Options
  readonly #pending = new Set<string>()
  readonly #checked = new Set<string>()
  readonly #retries = new Map<string, ReturnType<typeof setTimeout>>()
  readonly #queue: string[] = []
  readonly #waiters: (() => void)[] = []
  #scheduled = false
  #active = 0
  #closed = false

  constructor(index: RepoCache, options: Options = {}) {
    this.#index = index
    this.#options = options
  }

  read(cwd: string, refresh = false): RepoInfo | null {
    const cached = this.#index.repo(cwd)
    if (!this.#closed && (refresh || !this.#checked.has(cwd)) && !this.#pending.has(cwd)) {
      this.#checked.add(cwd)
      const retry = this.#retries.get(cwd)
      if (retry) clearTimeout(retry)
      this.#retries.delete(cwd)
      this.#pending.add(cwd)
      this.#queue.push(cwd)
      if (!this.#scheduled) {
        this.#scheduled = true
        setImmediate(() => { this.#scheduled = false; this.#pump() })
      }
    }
    return cached?.repo ?? null
  }

  flush(): Promise<void> {
    return this.#pending.size === 0 ? Promise.resolve() : new Promise((resolve) => this.#waiters.push(resolve))
  }

  /** Call before closing the index, so no late background write reaches it. */
  async close(): Promise<void> {
    this.#closed = true
    for (const timer of this.#retries.values()) clearTimeout(timer)
    this.#retries.clear()
    await this.flush()
  }

  #pump(): void {
    while (this.#active < 4 && this.#queue.length > 0) {
      const cwd = this.#queue.shift()!
      this.#active++
      void this.#check(cwd).finally(() => {
        this.#active--
        this.#pending.delete(cwd)
        this.#pump()
        if (this.#pending.size === 0) this.#waiters.splice(0).forEach((resolve) => resolve())
      })
    }
  }

  async #check(cwd: string): Promise<void> {
    const cached = this.#index.repo(cwd)
    try {
      let exists = true
      let repo: RepoInfo | null = null
      let identity: string | undefined
      if (this.#options.resolve) repo = await this.#options.resolve(cwd)
      else {
        if (cached?.identity) {
          const prior = JSON.parse(cached.identity) as Fingerprint
          if (await fingerprint(cwd, prior.paths.map(one => one.path)) === cached.identity) return
        }
        const watched = new Set<string>()
        // A negative answer must notice a repository added to any ancestor.
        for (let folder = resolve(cwd); ; folder = dirname(folder)) {
          watched.add(join(folder, '.git'))
          if (dirname(folder) === folder) break
        }
        const folder = await optionalStat(cwd)
        exists = folder?.isDirectory() ?? false
        if (exists) repo = await repository(cwd, this.#options, watched)
        identity = await fingerprint(cwd, [...watched])
      }
      this.#index.putRepo(cwd, { repo, exists, checkedAt: (this.#options.now ?? Date.now)(), ...(identity ? { identity } : {}) })
      this.#options.onResolved?.(cwd, repo)
    } catch {
      // A failed read says nothing about existence or the cached mapping.
      // Retain that answer and retry after the queue settles, or on a refresh.
      if (!this.#closed && !this.#retries.has(cwd)) {
        const timer = setTimeout(() => { this.#retries.delete(cwd); this.read(cwd, true) }, 5_000)
        timer.unref()
        this.#retries.set(cwd, timer)
      }
    }
  }

}

const absent = (error: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')
const optionalStat = async (path: string) => stat(path).catch((error: unknown) => { if (absent(error)) return null; throw error })
interface Fingerprint { cwd: string | null; paths: { path: string; real: string | null; stamp: readonly (number | string)[] | null }[] }
const fingerprint = async (cwd: string, paths: readonly string[]): Promise<string> => {
  const folder = await optionalStat(cwd)
  const entries: Fingerprint['paths'] = []
  for (const path of new Set([cwd, ...paths])) {
    const info = await optionalStat(path)
    entries.push({ path, real: info ? await canonical(path) : null,
      stamp: info ? [info.dev, info.ino, info.mode, info.size, path === cwd ? 0 : info.mtimeMs] : null })
  }
  return JSON.stringify({ cwd: folder ? await canonical(cwd) : null, paths: entries } satisfies Fingerprint)
}

const finalNewline = (text: string): string => text.replace(/\n$/, '')
const canonical = async (path: string): Promise<string | null> => realpath(path).catch((error: unknown) => { if (absent(error)) return null; throw error })
const same = (a: string | null, b: string): boolean => a !== null &&
  (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)

/** Verify the working folder's own pointer rather than trusting core.worktree. */
const checkoutGitDir = async (folder: string): Promise<string | null> => {
  try {
    const dot = join(folder, '.git')
    if ((await stat(dot)).isDirectory()) return canonical(dot)
    const pointer = finalNewline(await readFile(dot, 'utf8'))
    return pointer.startsWith('gitdir: ') ? canonical(resolve(folder, pointer.slice('gitdir: '.length))) : null
  } catch (error) { if (absent(error)) return null; throw error }
}

type ConfigEntry = { section: string; subsection: string; name: string; value: string }

/** The read-only subset of Git config used by repository identity. */
const configValue = (raw: string): string => {
  const escaped: Record<string, string> = { n: '\n', t: '\t', b: '\b' }
  let quoted = false
  let result = ''
  let trailing = ''
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!
    if (ch === '"') { quoted = !quoted; continue }
    if (!quoted && (ch === '#' || ch === ';')) break
    if (ch === '\\') {
      const next = raw[++i]
      if (next === undefined) break
      result += trailing + (escaped[next] ?? next)
      trailing = ''
    } else if (!quoted && /\s/.test(ch)) trailing += ch
    else { result += trailing + ch; trailing = '' }
  }
  return result
}

const configEntries = (text: string): ConfigEntry[] => {
  const entries: ConfigEntry[] = []
  let section = ''
  let subsection = ''
  for (const line of text.replace(/\\\r?\n/g, '').split(/\r?\n/)) {
    const header = /^\s*\[([\w-]+)(?:\s+"((?:\\.|[^"\\])*)"|\.([^\]]+))?\]\s*(?:[#;].*)?$/.exec(line)
    if (header) { section = header[1]!.toLowerCase(); subsection = header[2] === undefined ? header[3] ?? '' : configValue(`"${header[2]}"`); continue }
    const item = /^\s*([\w-]+)\s*(?:=\s*(.*))?$/.exec(line)
    if (item && section) entries.push({ section, subsection, name: item[1]!.toLowerCase(), value: item[2] === undefined ? 'true' : configValue(item[2]) })
  }
  return entries
}

/** Git's directory globs match dot directories too, unlike ordinary filesystem globs. */
const gitDirectoryMatches = (condition: string, config: string, home: string, directories: readonly string[]): boolean => {
  const match = /^gitdir(\/i)?:(.*)$/.exec(condition)
  if (!match) return false
  let pattern = match[2]!
  if (pattern.startsWith('~/')) pattern = `${home}/${pattern.slice(2)}`
  else if (pattern.startsWith('./')) pattern = `${dirname(config)}/${pattern.slice(2)}`
  else if (!pattern.startsWith('/') && !/^[a-z]:[\\/]/i.test(pattern)) pattern = `**/${pattern}`
  if (process.platform === 'win32') pattern = pattern.replace(/\\/g, '/')
  if (pattern.endsWith('/')) pattern += '**'
  const literal = (char: string) => char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
  let expression = ''
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!
    if (char === '*') {
      const start = i
      while (pattern[i + 1] === '*') i++
      const recursive = i > start && (start === 0 || pattern[start - 1] === '/') && (i + 1 === pattern.length || pattern[i + 1] === '/')
      if (recursive && pattern[i + 1] === '/') { expression += '(?:.*/)?'; i++ }
      else expression += recursive ? '.*' : '[^/]*'
    } else if (char === '?') expression += '[^/]'
    else if (char === '[' && pattern.indexOf(']', i + 1) !== -1) {
      const end = pattern.indexOf(']', i + 1)
      const contents = pattern.slice(i + 1, end).replace(/^!/, '^')
      expression += `(?!/)[${contents}]`
      i = end
    } else if (char === '\\' && i + 1 < pattern.length) expression += literal(pattern[++i]!)
    else expression += literal(char)
  }
  try {
    const glob = new RegExp(`^${expression}$`, match[1] ? 'i' : '')
    return directories.some((directory) => glob.test(process.platform === 'win32' ? directory.replace(/\\/g, '/') : directory))
  } catch { return false }
}

const readConfig = async (path: string, home: string, gitDirs: readonly string[], watched: Set<string>, seen = new Set<string>()): Promise<ConfigEntry[]> => {
  watched.add(path)
  if (seen.has(path) || seen.size >= 10) return []
  seen.add(path)
  try {
    if ((await stat(path)).size > 1024 * 1024) throw new Error('Repository configuration is too large to read')
    const result: ConfigEntry[] = []
    for (const entry of configEntries(await readFile(path, 'utf8'))) {
      if (entry.name === 'path' && (entry.section === 'include' ||
        (entry.section === 'includeif' && gitDirectoryMatches(entry.subsection, path, home, gitDirs)))) {
        const included = entry.value.startsWith('~/') ? join(home, entry.value.slice(2)) : resolve(dirname(path), entry.value)
        result.push(...await readConfig(included, home, gitDirs, watched, seen))
      } else result.push(entry)
    }
    return result
  } catch (error) { if (absent(error)) return []; throw error }
}

const valueOf = (entries: ConfigEntry[], section: string, name: string): string | undefined =>
  entries.findLast((entry) => entry.section === section && entry.subsection === '' && entry.name === name)?.value

const repository = async (cwd: string, options: Options, watched: Set<string>): Promise<RepoInfo | null> => {
  const sourceEnv = options.env ?? process.env
  const env = { ...Object.fromEntries(Object.entries(sourceEnv).filter(([key]) => !key.startsWith('GIT_'))), GIT_OPTIONAL_LOCKS: '0' }
  const execute = options.execute ?? executeGit
  const query = (flags: readonly string[]) => execute(['-C', cwd, ...HARDENED_GIT_CONFIG, 'rev-parse', '--path-format=absolute', ...flags], env)
  const flags = ['--git-common-dir', '--git-dir', '--show-toplevel']
  let output: string
  try { output = await query(flags) } catch (error) {
    if (/not a git repository/i.test(String((error as { stderr?: string }).stderr))) return null
    throw error
  }
  let paths = finalNewline(output).split('\n')
  // rev-parse cannot NUL-delimit paths. Only newline-bearing payloads need more processes.
  if (paths.length !== 3) {
    paths = []
    for (const flag of flags) paths.push(finalNewline(await query([flag])))
  }
  if (paths.some((path) => path === '')) return null
  const [common, dir, here] = await Promise.all(paths.map(canonical))
  if (!common || !dir || !here || !same(await checkoutGitDir(here), dir)) return null
  for (const path of [...paths, join(here, '.git'), join(dir, 'commondir'), join(dir, 'gitdir')]) watched.add(path)
  const home = sourceEnv.HOME ?? sourceEnv.USERPROFILE ?? homedir()
  const gitDirs = [paths[1]!, dir]
  const local = await readConfig(join(common, 'config'), home, gitDirs, watched)
  let root = here
  const worktree = !same(dir, common)
  if (worktree) {
    const recorded = valueOf(local, 'core', 'worktree')
    const candidate = recorded === undefined ? (basename(common) === '.git' ? dirname(common) : common) : resolve(common, recorded)
    const main = await canonical(candidate)
    if (!main) return null
    if (recorded !== undefined || basename(common) === '.git') {
      if (!same(await checkoutGitDir(main), common)) return null
    }
    watched.add(join(main, '.git'))
    root = main
  }
  const user = [
    ...await readConfig(join(sourceEnv.XDG_CONFIG_HOME ?? join(home, '.config'), 'git', 'config'), home, gitDirs, watched),
    ...await readConfig(join(home, '.gitconfig'), home, gitDirs, watched),
  ]
  const entries = [...user, ...local]
  if (valueOf(local, 'extensions', 'worktreeconfig') === 'true') entries.push(...await readConfig(join(dir, 'config.worktree'), home, gitDirs, watched))
  let originUrl = entries.find((entry) => entry.section === 'remote' && entry.subsection === 'origin' && entry.name === 'url')?.value
  if (originUrl) {
    let rewrite: ConfigEntry | undefined
    for (const entry of entries) {
      if (entry.section === 'url' && entry.name === 'insteadof' && originUrl.startsWith(entry.value) &&
        (!rewrite || entry.value.length > rewrite.value.length)) rewrite = entry
    }
    if (rewrite) originUrl = rewrite.subsection + originUrl.slice(rewrite.value.length)
  }
  const origin = repoKey(originUrl)
  return { root, worktree, ...(origin === null ? {} : { origin }) }
}
