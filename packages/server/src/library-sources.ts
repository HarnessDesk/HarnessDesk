import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readdir, realpath, rm, utimes } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

import { bundleDigest, isSafeSkillRelativePath, MAX_BUNDLE_BYTES, MAX_BUNDLE_FILES, parseGithubSource, validSkillName, internals } from '@harnessdesk/agent-inventory'
import type { LibrarySourceResult } from '@harnessdesk/protocol'

import { HARDENED_GIT_CONFIG } from './git-hardening.js'

export { parseGithubSource } from '@harnessdesk/agent-inventory'

export interface LibrarySourcesOptions {
  /** Tests map the public repository to a temporary bare repository. */
  readonly transport?: (url: string) => { readonly url: string; readonly protocol: 'https' | 'file' }
  readonly maxBundleFiles?: number
  readonly maxBundleBytes?: number
  readonly maxSkills?: number
  readonly maxRepositoryBytes?: number
  readonly timeoutMs?: number
}

interface Entry { readonly path: string; readonly mode: string; readonly oid: string; readonly size: number }
interface File { readonly path: string; readonly bytes: Buffer; readonly mode: number }
const within = (path: string, root: string): boolean => {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep))
}
const invalidPath = (path: string): boolean => !isSafeSkillRelativePath(path) || /[\x00-\x1f\x7f]/.test(path) || path.split(/[/\\]/).some(one => one.toLowerCase() === '.git')

/** Resolve once, read only objects, and keep the bytes the ordinary install previews. */
export class LibrarySources {
  #pending: Promise<unknown> = Promise.resolve()
  constructor(readonly libraryDir: string, readonly options: LibrarySourcesOptions = {}) {}

  fetch(input: { readonly url: string; readonly ref?: string; readonly path?: string }): Promise<LibrarySourceResult> {
    const next = this.#pending.then(() => this.#fetch(input))
    this.#pending = next.catch(() => {})
    return next
  }

  async #fetch(input: { readonly url: string; readonly ref?: string; readonly path?: string }): Promise<LibrarySourceResult> {
    const source = parseGithubSource(input.url, input.ref, input.path)
    const transport = this.options.transport?.(source.url) ?? { url: `${source.url}.git`, protocol: 'https' as const }
    if (!transport.url.startsWith(`${transport.protocol}://`) || (!this.options.transport && transport.url !== `${source.url}.git`)) throw new Error('The source transport must use the repository URL over https.')
    const root = resolve(this.libraryDir, 'sources')
    await mkdir(this.libraryDir, { recursive: true, mode: 0o700 })
    await this.#directory(root, resolve(this.libraryDir))
    await this.#expire(root)
    const tmp = join(root, `.tmp-${randomUUID()}`)
    await this.#directory(tmp, root)
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(new Error('The repository fetch exceeded 60 seconds.')), this.options.timeoutMs ?? 60_000)
    const limit = this.options.maxRepositoryBytes ?? 64 * 1024 * 1024
    let measurement: Promise<void> | undefined
    const measure = (): Promise<void> => measurement ??= (async () => {
      try { if (await this.#size(tmp) > limit) controller.abort(new Error('The repository exceeds the 64 MB repository size limit.')) }
      catch (error) { controller.abort(error) }
      finally { measurement = undefined }
    })()
    const monitor = setInterval(() => { void measure() }, 25)
    // Do not inherit repository settings or home-based credentials such as .netrc.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && key !== 'NETRC'))
    Object.assign(env, { HOME: tmp, USERPROFILE: tmp, CURL_HOME: tmp, XDG_CONFIG_HOME: tmp, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' })
    const git = (args: string[], input?: Buffer, maxOutput = 8 * 1024 * 1024): Promise<Buffer> => new Promise((done, fail) => {
      if (controller.signal.aborted) { fail(controller.signal.reason); return }
      const child = spawn('git', [
        ...HARDENED_GIT_CONFIG, '--literal-pathspecs', '-c', 'credential.helper=', '-c', 'protocol.allow=never', '-c', `protocol.${transport.protocol}.allow=always`,
        '-c', 'transfer.fsckObjects=true', '-c', 'http.followRedirects=false', '-c', 'core.quotePath=false', '--git-dir', tmp, ...args,
      ], { env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
      const stop = () => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL')
          else child.kill('SIGKILL')
        } catch { child.kill('SIGKILL') }
      }
      controller.signal.addEventListener('abort', stop, { once: true })
      if (controller.signal.aborted) stop()
      const chunks: Buffer[] = []
      let length = 0
      child.stdout.on('data', (chunk: Buffer) => {
        length += chunk.length
        if (length > maxOutput) { controller.abort(new Error('The repository object listing exceeds its read limit.')); return }
        chunks.push(chunk)
      })
      child.stderr.resume()
      child.stdin.on('error', () => {})
      let spawnError: Error | undefined
      child.on('error', error => { spawnError = error })
      child.on('close', code => {
        controller.signal.removeEventListener('abort', stop)
        if (controller.signal.aborted) fail(controller.signal.reason)
        else if (spawnError) fail(spawnError)
        else if (code !== 0) fail(new Error('The public repository or requested commit could not be read.'))
        else done(Buffer.concat(chunks))
      })
      child.stdin.end(input)
    })
    try {
      await git(['init', '--bare', '--template=', '--', tmp])
      await measure()
      controller.signal.throwIfAborted()
      let commit: string
      if (/^[a-f0-9]{40}$/i.test(source.ref)) commit = source.ref.toLowerCase()
      else {
        const refs = (await git(['ls-remote', '--', transport.url])).toString('utf8').trim().split('\n').map(line => line.split('\t'))
        const named = (name: string) => refs.find(([, ref]) => ref === name)?.[0]
        commit = (/^[a-f0-9]{4,39}$/i.test(source.ref) ? undefined : source.ref === 'HEAD' ? named('HEAD') :
          named(`refs/heads/${source.ref}`) ?? named(`refs/tags/${source.ref}^{}`) ?? named(`refs/tags/${source.ref}`) ??
          (source.ref.startsWith('refs/') ? named(`${source.ref}^{}`) ?? named(source.ref) : undefined)) ?? ''
        if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Use a branch, a tag or the full commit hash.')
      }
      await git(['fetch', '--depth', '1', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--', transport.url, commit])
      await measurement
      await measure()
      controller.signal.throwIfAborted()
      // Verify that a full object id denotes a commit rather than a tag, tree or blob.
      if ((await git(['cat-file', '-t', '--', commit])).toString().trim() !== 'commit') throw new Error('Use a branch, a tag or the full commit hash.')
      const listing = await git(['ls-tree', '-r', '-z', '-l', commit, '--', ...(source.path ? [source.path] : [])], undefined, limit)
      const entries: Entry[] = listing.toString('utf8').split('\0').filter(Boolean).map(line => {
        const match = /^(\d{6}) (?:blob|commit) ([a-f0-9]{40}) +([0-9]+|-)\t(.*)$/s.exec(line)
        if (!match) throw new Error('The repository tree could not be read.')
        return { mode: match[1]!, oid: match[2]!, size: match[3] === '-' ? 0 : Number(match[3]), path: match[4]! }
      })
      // Include directory prefixes: A/first and a/second share a directory
      // on a case-folding filesystem even though the full filenames differ.
      const spellings = new Map<string, string>()
      const collisions = new Set<string>()
      for (const entry of entries) {
        const segments = entry.path.split('/')
        for (let count = 1; count <= segments.length; count++) {
          const path = segments.slice(0, count).join('/')
          const key = path.normalize('NFC').toLowerCase()
          const previous = spellings.get(key)
          if (previous !== undefined && previous !== path) { collisions.add(previous); collisions.add(path) }
          else spellings.set(key, path)
        }
      }
      const base = source.path.replace(/\\/g, '/')
      const directories = new Set<string>()
      for (const entry of entries) {
        const dir = dirname(entry.path) === '.' ? '' : dirname(entry.path)
        const rel = base ? relative(base, dir) : dir
        if (!within(dir || '.', base || '.') || (rel ? rel.split('/').length : 0) > 4) continue
        if (basename(entry.path).toLowerCase() === 'skill.md') directories.add(dir)
      }
      const skills: LibrarySourceResult['skills'][number][] = []
      const refused: { dir: string; reason: string }[] = directories.size ? [] : [{ dir: base, reason: 'No SKILL.md at the directory root or within four levels.' }]
      let discovered = 0
      for (const dir of [...directories].sort()) {
        if (++discovered > (this.options.maxSkills ?? 50)) {
          refused.push({ dir, reason: 'The fetch exceeds the 50 skills limit.' })
          continue
        }
        const files = entries.filter(entry => dir === '' || entry.path.startsWith(`${dir}/`)).map(entry => ({ ...entry, path: dir ? entry.path.slice(dir.length + 1) : entry.path }))
        let reason: string | undefined
        const linked = files.find(entry => entry.mode === '120000' || entry.mode === '160000')
        if (linked) reason = `contains a link at ${linked.path}; links are not carried`
        for (const entry of files) {
          if (invalidPath(entry.path) || (dir && invalidPath(dir))) reason ??= `The path ${entry.path} is not a skill relative path.`
        }
        const collision = [...collisions].find(path => !dir || path === dir || path.startsWith(`${dir}/`) || dir.startsWith(`${path}/`))
        if (collision !== undefined) reason ??= `The path ${collision} repeats after case folding and Unicode normalisation.`
        if (!files.some(entry => entry.path === 'SKILL.md')) reason ??= 'No SKILL.md at the directory root.'
        if (files.length > (this.options.maxBundleFiles ?? MAX_BUNDLE_FILES)) reason ??= `The skill exceeds the ${this.options.maxBundleFiles ?? MAX_BUNDLE_FILES} files limit.`
        const bytes = files.reduce((sum, entry) => sum + entry.size, 0)
        if (bytes > (this.options.maxBundleBytes ?? MAX_BUNDLE_BYTES)) reason ??= `The skill exceeds the ${this.options.maxBundleBytes ?? MAX_BUNDLE_BYTES} bytes limit (20 MB by default).`
        if (reason) { refused.push({ dir, reason }); continue }
        // One batch per accepted skill, with lengths from ls-tree checked again.
        const blobs = await git(['cat-file', '--batch'], Buffer.from(files.map(file => file.oid).join('\n') + '\n'), bytes + files.length * 128)
        let offset = 0
        const written: File[] = files.map(entry => {
          const end = blobs.indexOf(10, offset)
          const header = blobs.subarray(offset, end).toString()
          if (end === -1 || header !== `${entry.oid} blob ${entry.size}` || blobs[end + 1 + entry.size] !== 10) throw new Error('The repository blob did not match its listing.')
          const bytes = blobs.subarray(end + 1, end + 1 + entry.size)
          offset = end + 2 + entry.size
          return { path: entry.path, bytes, mode: entry.mode === '100755' ? 0o755 : 0o644 }
        })
        const destination = join(root, source.repo.replace('/', '__'), commit, dir)
        await this.#write(destination, root, written)
        const definition = written.find(file => file.path === 'SKILL.md')!.bytes.toString('utf8')
        const name = internals.frontmatter(definition).name
        skills.push({ name: name && validSkillName(name) ? name : basename(dir || source.repo), dir, sourcePath: destination, files: files.length, bytes, bundle: bundleDigest(written) })
      }
      const repoCache = join(root, source.repo.replace('/', '__'))
      const now = new Date()
      if (skills.length) {
        await utimes(join(repoCache, commit), now, now)
        await utimes(repoCache, now, now)
      }
      return { ...source, commit, skills, refused }
    } finally {
      clearTimeout(deadline)
      clearInterval(monitor)
      await measurement
      await rm(tmp, { recursive: true, force: true })
    }
  }

  async #directory(path: string, root: string): Promise<void> {
    if (!within(path, root)) throw new Error('The fetched destination is outside sources.')
    if (path !== root) await this.#directory(dirname(path), root)
    try { await mkdir(path, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    const stats = await lstat(path)
    if (!stats.isDirectory() || stats.isSymbolicLink() || !within(await realpath(path), await realpath(root))) throw new Error('The fetched destination is a link or outside sources.')
  }

  async #write(destination: string, root: string, files: readonly File[]): Promise<void> {
    await this.#directory(destination, root)
    // Verify all existing bytes and modes before completing a partially cached
    // parent whose nested skill was fetched earlier. Extra paths are refused.
    const existing = new Set<string>()
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (!files.some(file => file.path.startsWith(`${relative(destination, path)}/`))) throw new Error('The fetched copy changed — fetch again.')
          await walk(path)
        }
        else if (entry.isFile()) {
          const name = relative(destination, path)
          const expected = files.find(file => file.path === name)
          if (!expected) throw new Error('The fetched copy changed — fetch again.')
          const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
          try {
            const stats = await handle.stat()
            if (!stats.isFile() || stats.size !== expected.bytes.length) throw new Error('The fetched copy changed — fetch again.')
            const bytes = Buffer.alloc(expected.bytes.length + 1)
            let read = 0
            while (read < bytes.length) {
              const chunk = await handle.read(bytes, read, bytes.length - read, null)
              if (!chunk.bytesRead) break
              read += chunk.bytesRead
            }
            if (read !== expected.bytes.length || !bytes.subarray(0, read).equals(expected.bytes) || (stats.mode & 0o777) !== expected.mode) throw new Error('The fetched copy changed — fetch again.')
            existing.add(name)
          } finally { await handle.close() }
        }
        else throw new Error('The fetched copy changed — fetch again.')
      }
    }
    await walk(destination)
    for (const file of files) {
      if (existing.has(file.path)) continue
      const path = join(destination, file.path)
      await this.#directory(dirname(path), root)
      if (!within(await realpath(dirname(path)), await realpath(root))) throw new Error('The fetched destination is outside sources.')
      const handle = await open(path, 'wx', file.mode)
      try { await handle.writeFile(file.bytes); await handle.chmod(file.mode) } finally { await handle.close() }
    }
  }

  async #size(dir: string): Promise<number> {
    let bytes = 0
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      try { bytes += entry.isDirectory() ? await this.#size(path) : (await lstat(path)).size }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    return bytes
  }

  async #expire(root: string): Promise<void> {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = join(root, entry.name)
      const stats = await lstat(path)
      if (stats.mtimeMs < cutoff) await rm(path, { recursive: true, force: true })
      else if (entry.isDirectory() && !entry.name.startsWith('.tmp-')) {
        for (const commit of await readdir(path)) {
          const at = join(path, commit)
          if ((await lstat(at)).mtimeMs < cutoff) await rm(at, { recursive: true, force: true })
        }
      }
    }
  }
}
