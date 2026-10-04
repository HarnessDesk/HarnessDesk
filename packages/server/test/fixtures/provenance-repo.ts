import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'

import { runChild, type ChildRunner } from '../../src/provenance/git.js'
import { tempDir } from '../scratch.js'

export interface Repo {
  readonly dir: string
  readonly stateDir: string
  git(...args: string[]): Promise<string>
  input(args: readonly string[], bytes: string | Buffer): Promise<string>
  commitTree(parent: string | null, files: Readonly<Record<string, string | Buffer | null>>, message: string): Promise<string>
}

/** Plumbing writes only this fixture's index and object store, never checkout files. */
export const makeRepo = async (format: 'sha1' | 'sha256' = 'sha1'): Promise<Repo> => {
  const home = await realpath(tempDir('hd-provenance-'))
  const dir = join(home, 'repo')
  const stateDir = join(home, 'state')
  await mkdir(dir)
  await mkdir(stateDir)
  const input = (args: readonly string[], bytes: string | Buffer = ''): Promise<string> =>
    new Promise((resolve, reject) => {
      const child = spawn('git', ['-C', dir, ...args], {
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_AUTHOR_NAME: 'Jane Doe',
          GIT_AUTHOR_EMAIL: 'dev@example.com',
          GIT_COMMITTER_NAME: 'Jane Doe',
          GIT_COMMITTER_EMAIL: 'dev@example.com',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const out: Buffer[] = []
      const err: Buffer[] = []
      child.stdout.on('data', (bytes: Buffer) => out.push(bytes))
      child.stderr.on('data', (bytes: Buffer) => err.push(bytes))
      child.on('error', reject)
      child.stdin.on('error', () => {})
      child.on('close', (code) => {
        if (code !== 0) reject(new Error(Buffer.concat(err).toString('utf8')))
        else resolve(Buffer.concat(out).toString('utf8').trim())
      })
      child.stdin.end(bytes)
    })
  const git = (...args: string[]) => input(args)
  await git('init', '-q', '-b', 'main', `--object-format=${format}`)
  const commitTree: Repo['commitTree'] = async (parent, files, message) => {
    await git('read-tree', ...(parent ? [parent] : ['--empty']))
    for (const [path, contents] of Object.entries(files)) {
      if (contents === null) {
        await git('update-index', '--force-remove', '--', path)
      } else {
        const blob = await input(['hash-object', '-w', '--stdin'], contents)
        await git('update-index', '--add', '--cacheinfo', '100644', blob, path)
      }
    }
    const tree = await git('write-tree')
    return git('commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message)
  }
  return { dir, stateDir, git, input, commitTree }
}

export interface Counting {
  /** Hand this to a reader or a plane; it starts the real Git, and counts. */
  readonly run: ChildRunner
  /** Every process asked for so far, as Git's own arguments with the reader's private-view flags dropped. */
  readonly commands: readonly (readonly string[])[]
  readonly started: number
  /** The subcommand of each process asked for, in order. */
  verbs(): string[]
}

/** The reader's fixed flags come first: bare words, `-C <dir>` and `-c <setting>` pairs. */
const subcommand = (args: readonly string[]): readonly string[] => {
  let at = 0
  while (at < args.length) {
    if (args[at] === '-C' || args[at] === '-c') at += 2
    else if (args[at]!.startsWith('--no-') || args[at] === '--literal-pathspecs') at += 1
    else break
  }
  return args.slice(at)
}

/**
 * A runner that counts the Git processes a reader starts and, past `budget`,
 * refuses to start another. Without the refusal a read that starts thousands
 * would fail by running for minutes; with it the same read fails at once, with
 * the number it reached.
 */
export const countingRunner = (budget = Number.POSITIVE_INFINITY): Counting => {
  const commands: (readonly string[])[] = []
  const run: ChildRunner = (executable, args, options) => {
    commands.push(subcommand(args))
    if (commands.length > budget) return Promise.reject(new Error('process-budget-exceeded'))
    return runChild(executable, args, options)
  }
  return {
    run,
    commands,
    get started() { return commands.length },
    verbs: () => commands.map((command) => command[0] ?? ''),
  }
}

/**
 * One base and `length` commits after it, each rewriting `files` files. Given
 * `from`, the commits are made on top of it instead of on a fresh base.
 */
export const history = async (repo: Repo, length: number, files = 1, from?: string) => {
  const base = from ?? await repo.commitTree(null, { 'file-0': 'base\n' }, 'base')
  const shas: string[] = []
  let parent = base
  while (shas.length < length) {
    const changes: Record<string, string> = {}
    for (let file = 0; file < files; file += 1) changes[`file-${file}`] = `commit ${shas.length + 1}, file ${file}\n`
    parent = await repo.commitTree(parent, changes, `commit ${shas.length + 1}`)
    shas.push(parent)
  }
  return { base, shas }
}

export interface Scripted extends Counting {
  /** From now on Git has no such object. */
  lose(sha: string): void
}

/**
 * A runner that answers Git's questions from memory, so a test can have a
 * reader do the work of thousands of processes in a moment and still count
 * every one it would have started. Every object is a commit unless it was
 * lost; the patch between two commits is a fixed function of the pair, and
 * `patch-id` hashes whatever it is given, as the real one does.
 */
export const scriptedGit = (budget = Number.POSITIVE_INFINITY): Scripted => {
  const lost = new Set<string>()
  const commands: (readonly string[])[] = []
  const run: ChildRunner = async (_executable, args, options) => {
    const command = subcommand(args)
    commands.push(command)
    if (commands.length > budget) throw new Error('process-budget-exceeded')
    const [verb, first] = command
    if (verb === 'cat-file' && first?.startsWith('--batch-check')) {
      const ids = (options.input ?? Buffer.alloc(0)).toString('utf8').split('\n').filter(Boolean)
      return Buffer.from(`${ids.map((id) => lost.has(id) ? `${id} missing` : 'commit').join('\n')}\n`)
    }
    if (verb === 'cat-file' && first === 'commit') return Buffer.from(`tree ${'0'.repeat(40)}\n\nmessage\n`)
    if (verb === 'diff-tree') {
      const ends = command.filter((arg) => /^[a-f0-9]{40}$/.test(arg))
      return command.includes('--name-only') ? Buffer.from('file\0') : Buffer.from(`diff ${ends.join(' ')}\n`)
    }
    if (verb === 'patch-id') {
      const id = createHash('sha1').update(first ?? '').update(options.input ?? '').digest('hex')
      return Buffer.from(`${id} ${'0'.repeat(40)}\n`)
    }
    throw new Error(`the script has no answer for git ${verb}`)
  }
  return {
    run,
    commands,
    get started() { return commands.length },
    verbs: () => commands.map((command) => command[0] ?? ''),
    lose: (sha) => { lost.add(sha) },
  }
}
