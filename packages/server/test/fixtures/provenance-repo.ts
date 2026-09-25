import { spawn } from 'node:child_process'
import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'

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
