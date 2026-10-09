import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import type { RepoInfo } from '@harnessdesk/protocol'
import { SessionIndexRepos } from '../src/session-index-repos.js'
import { SessionIndex } from '../src/session-index.js'
import { HARDENED_GIT_CONFIG } from '../src/git-hardening.js'

const run = promisify(execFile)
type CachedRepo = { repo: RepoInfo | null; exists: boolean; checkedAt: number }
const memoryIndex = () => {
  const values = new Map<string, CachedRepo>()
  return { repo: (cwd: string) => values.get(cwd) ?? null, putRepo: (cwd: string, value: CachedRepo) => { values.set(cwd, value) } }
}

// Fixtures stay in a throwaway folder. No account configuration is read by Git.
const fixture = async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'harnessdesk-index-repos-')))
  const home = join(base, 'home')
  await mkdir(home)
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), HOME: home,
    XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Jane Doe',
    GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'Jane Doe', GIT_COMMITTER_EMAIL: 'dev@example.com' }
  const git = async (cwd: string, ...args: string[]) => (await run('git', ['-C', cwd, ...args], { env })).stdout
  const repo = join(base, 'repo')
  await mkdir(repo)
  await git(repo, 'init', '-q', '-b', 'main')
  await git(repo, 'commit', '--allow-empty', '-q', '-m', 'fixture')
  const calls: string[][] = []
  const execute = async (args: readonly string[], supplied: NodeJS.ProcessEnv) => {
    calls.push([...args])
    return (await run('git', [...args], { env: { ...supplied, HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, '.gitconfig') } })).stdout
  }
  return { base, repo, git, calls, execute, env: { HOME: home, XDG_CONFIG_HOME: home } }
}

test('cache misses return before any resolver starts and duplicate reads resolve once', async () => {
  const index = memoryIndex()
  let calls = 0
  const observed: string[] = []
  const repos = new SessionIndexRepos(index, { resolve: async (cwd) => { calls++; return { root: cwd, worktree: false } }, now: () => 42,
    onResolved: (cwd) => { observed.push(cwd) } })
  assert.equal(repos.read('/synthetic/project'), null)
  assert.equal(repos.read('/synthetic/project'), null)
  assert.equal(calls, 0)
  await repos.flush()
  assert.equal(calls, 1)
  assert.deepEqual(repos.read('/synthetic/project'), { root: '/synthetic/project', worktree: false })
  assert.deepEqual(index.repo('/synthetic/project'), { repo: { root: '/synthetic/project', worktree: false }, exists: true, checkedAt: 42 })
  assert.deepEqual(observed, ['/synthetic/project'])
})

test('at most four background resolutions run at once, and flush drains the whole queue', async () => {
  let active = 0
  let maximum = 0
  let calls = 0
  const releases: (() => void)[] = []
  const repos = new SessionIndexRepos(memoryIndex(), { resolve: async () => {
    active++; maximum = Math.max(maximum, active); calls++
    await new Promise<void>((resolve) => releases.push(resolve))
    active--; return null
  } })
  for (let i = 0; i < 11; i++) repos.read(`/synthetic/project-${i}`)
  const flushed = repos.flush()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(calls, 4)
  while (calls < 11 || active > 0) {
    releases.splice(0).forEach((release) => release())
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  await flushed
  assert.equal(maximum, 4)
  assert.equal(calls, 11)
})

test('resolver failures are cached negatives and do not reject flush', async () => {
  let calls = 0
  const repos = new SessionIndexRepos(memoryIndex(), { resolve: async () => { calls++; throw new Error('unreadable fixture') } })
  repos.read('/synthetic/unreadable')
  await repos.flush()
  assert.equal(repos.read('/synthetic/unreadable'), null)
  await repos.flush()
  assert.equal(calls, 1)
})

test('closing drains pending writes and prevents later misses from starting work', async () => {
  const resolved: string[] = []
  const repos = new SessionIndexRepos(memoryIndex(), { resolve: async (cwd) => { resolved.push(cwd); return null } })
  repos.read('/synthetic/pending')
  await repos.close()
  repos.read('/synthetic/later')
  await repos.flush()
  assert.deepEqual(resolved, ['/synthetic/pending'])
})

test('main checkout, subfolders and linked worktrees share a root with one Git process per folder', async () => {
  const f = await fixture()
  const linked = join(f.base, 'linked')
  await f.git(f.repo, 'worktree', 'add', '-q', '-b', 'side', linked)
  const nested = join(f.repo, 'packages')
  const linkedNested = join(linked, 'packages')
  await mkdir(nested); await mkdir(linkedNested)
  const index = memoryIndex()
  const repos = new SessionIndexRepos(index, { execute: f.execute, env: f.env })
  for (const cwd of [f.repo, nested, linked, linkedNested]) assert.equal(repos.read(cwd), null)
  assert.equal(f.calls.length, 0)
  await repos.flush()
  assert.equal(f.calls.length, 4)
  for (const cwd of [f.repo, nested]) assert.deepEqual(repos.read(cwd), { root: f.repo, worktree: false })
  for (const cwd of [linked, linkedNested]) assert.deepEqual(repos.read(cwd), { root: f.repo, worktree: true })
  const second = new SessionIndexRepos(index, { execute: f.execute, env: f.env })
  for (const cwd of [f.repo, nested, linked, linkedNested]) second.read(cwd)
  await second.flush()
  assert.equal(f.calls.length, 4, 'second launch reads stored answers without Git')
})

test('origin identity reads repository config, removes credentials and applies the longest URL rewrite', async () => {
  const f = await fixture()
  await f.git(f.repo, 'remote', 'add', 'origin', 'gh:Acme/Widgets.git')
  await f.git(f.repo, 'config', 'url.https://wrong.acme.dev/.insteadOf', 'gh:')
  await f.git(f.repo, 'config', 'url.https://jane:placeholder@github.com/Acme/.insteadOf', 'gh:Acme/')
  const repos = new SessionIndexRepos(memoryIndex(), { execute: f.execute, env: f.env })
  repos.read(f.repo)
  await repos.flush()
  assert.deepEqual(repos.read(f.repo), { root: f.repo, worktree: false, origin: 'github.com/acme/widgets' })
  assert.equal(f.calls.length, 1)
})

test('origin chooses the first fetch URL when a remote has several URLs', async () => {
  const f = await fixture()
  await f.git(f.repo, 'remote', 'add', 'origin', 'https://github.com/Acme/First.git')
  await f.git(f.repo, 'config', '--add', 'remote.origin.url', 'https://github.com/Acme/Second.git')
  const repos = new SessionIndexRepos(memoryIndex(), { execute: f.execute, env: f.env })
  repos.read(f.repo); await repos.flush()
  assert.equal(repos.read(f.repo)?.origin, 'github.com/acme/first')
})

test('Git-directory conditional includes preserve origin grouping for main and linked checkouts', async () => {
  const f = await fixture()
  const linked = join(f.base, 'linked')
  await f.git(f.repo, 'worktree', 'add', '-q', '-b', 'side', linked)
  await f.git(f.repo, 'remote', 'add', 'origin', 'gh:Acme/Widgets.git')
  const included = join(f.base, 'identity.config')
  const ignored = join(f.base, 'ignored.config')
  await writeFile(included, '[url "https://github.com/"]\n  insteadOf = gh:\n')
  await writeFile(ignored, '[url "https://wrong.acme.dev/"]\n  insteadOf = gh:Acme/\n')
  await writeFile(join(f.env.HOME, '.gitconfig'),
    `[includeIf "gitdir:${f.repo}/"]\n  path = ${included}\n[includeIf "gitdir:${f.base}/other/"]\n  path = ${ignored}\n`)
  for (const cwd of [f.repo, linked]) {
    assert.equal((await f.execute(['-C', cwd, ...HARDENED_GIT_CONFIG, 'remote', 'get-url', 'origin'], f.env)).trim(), 'https://github.com/Acme/Widgets.git')
  }
  f.calls.length = 0
  const repos = new SessionIndexRepos(memoryIndex(), { execute: f.execute, env: f.env })
  repos.read(f.repo); repos.read(linked)
  await repos.flush()
  assert.deepEqual(repos.read(f.repo), { root: f.repo, worktree: false, origin: 'github.com/acme/widgets' })
  assert.deepEqual(repos.read(linked), { root: f.repo, worktree: true, origin: 'github.com/acme/widgets' })
  assert.equal(f.calls.length, 2)
})

test('Git-directory include patterns support relative paths and case-insensitive glob matching', async () => {
  const f = await fixture()
  const configs = join(f.base, 'configs')
  await mkdir(configs)
  const parent = join(f.base, 'conditional.config')
  const origin = join(configs, 'origin.config')
  const rewrite = join(configs, 'rewrite.config')
  await writeFile(origin, '[remote "origin"]\n  url = gh:Acme/Widgets.git\n')
  await writeFile(rewrite, '[url "https://github.com/"]\n  insteadOf = gh:\n')
  await writeFile(parent, '[includeIf "gitdir:./repo/.git"]\n  path = configs/origin.config\n[includeIf "gitdir/i:**/RE?O/.git"]\n  path = configs/rewrite.config\n')
  await f.git(f.repo, 'config', 'include.path', parent)
  assert.equal((await f.execute(['-C', f.repo, ...HARDENED_GIT_CONFIG, 'remote', 'get-url', 'origin'], f.env)).trim(), 'https://github.com/Acme/Widgets.git')
  f.calls.length = 0
  const repos = new SessionIndexRepos(memoryIndex(), { execute: f.execute, env: f.env })
  repos.read(f.repo); await repos.flush()
  assert.equal(repos.read(f.repo)?.origin, 'github.com/acme/widgets')
  assert.equal(f.calls.length, 1)
})

test('repository answers survive closing and reopening SQLite with zero processes on the second launch', async () => {
  const f = await fixture()
  const linked = join(f.base, 'linked')
  const nested = join(f.repo, 'packages')
  await f.git(f.repo, 'worktree', 'add', '-q', '-b', 'side', linked)
  await f.git(f.repo, 'remote', 'add', 'origin', 'https://github.com/Acme/Widgets.git')
  await mkdir(nested)
  const folders = [f.repo, nested, linked, f.base, join(f.base, 'missing')]
  const database = join(f.base, 'state', 'sessions.sqlite')
  let index = new SessionIndex(database)
  let repos = new SessionIndexRepos(index, { execute: f.execute, env: f.env, now: () => 101 })
  for (const cwd of folders) assert.equal(repos.read(cwd), null)
  assert.equal(f.calls.length, 0)
  await repos.close()
  assert.equal(f.calls.length, 4)
  const stored = folders.map((cwd) => index.repo(cwd))
  index.close()
  index = new SessionIndex(database)
  repos = new SessionIndexRepos(index, { execute: f.execute, env: f.env })
  assert.deepEqual(folders.map((cwd) => index.repo(cwd)), stored)
  for (const cwd of folders) repos.read(cwd)
  await repos.close()
  assert.equal(f.calls.length, 4, 'durable positive and negative answers spawn zero on restart')
  index.close()
})

test('missing folders never spawn Git, and non-repositories persist negative answers', async () => {
  const f = await fixture()
  const index = memoryIndex()
  const repos = new SessionIndexRepos(index, { execute: f.execute, env: f.env, now: () => 73 })
  const missing = join(f.base, 'missing')
  repos.read(missing); repos.read(f.base)
  await repos.flush()
  assert.equal(f.calls.length, 1)
  assert.deepEqual(index.repo(missing), { repo: null, exists: false, checkedAt: 73 })
  assert.deepEqual(index.repo(f.base), { repo: null, exists: true, checkedAt: 73 })
  const second = new SessionIndexRepos(index, { execute: f.execute, env: f.env })
  second.read(missing); second.read(f.base)
  await second.flush()
  assert.equal(f.calls.length, 1)
})

test('a cwd replaced by a file is a missing folder and never spawns Git', async () => {
  const f = await fixture()
  const cwd = join(f.base, 'replaced-folder')
  await writeFile(cwd, 'synthetic file\n')
  const index = memoryIndex()
  const repos = new SessionIndexRepos(index, { execute: f.execute, env: f.env, now: () => 79 })
  repos.read(cwd); await repos.flush()
  assert.deepEqual(index.repo(cwd), { repo: null, exists: false, checkedAt: 79 })
  assert.equal(f.calls.length, 0)
})

test('newline paths use separate identity payloads without trimming path whitespace', async () => {
  const f = await fixture()
  const newlineRepo = join(f.base, 'repo\nwith space ')
  await rename(f.repo, newlineRepo)
  const repos = new SessionIndexRepos(memoryIndex(), { execute: f.execute, env: f.env })
  repos.read(newlineRepo)
  await repos.flush()
  assert.deepEqual(repos.read(newlineRepo), { root: newlineRepo, worktree: false })
  assert.equal(f.calls.length, 4, 'one combined query then three unambiguous payloads')
})

test('identity probes carry the hardened config, strip inherited Git authority and disable optional locks', async () => {
  const f = await fixture()
  const hook = join(f.base, 'hook')
  const marker = join(f.base, 'ran')
  await writeFile(hook, `#!/bin/sh\necho ran > '${marker}'\n`, { mode: 0o755 })
  await f.git(f.repo, 'config', 'core.fsmonitor', hook)
  await f.git(f.repo, 'config', 'core.hooksPath', f.base)
  const repos = new SessionIndexRepos(memoryIndex(), { env: { ...f.env, GIT_DIR: join(f.base, 'wrong'), GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.worktree', GIT_CONFIG_VALUE_0: join(f.base, 'wrong') }, execute: async (args, env) => {
    assert.equal(env.GIT_DIR, undefined)
    assert.equal(env.GIT_OPTIONAL_LOCKS, '0')
    assert.deepEqual(Object.keys(env).filter((key) => key.startsWith('GIT_')), ['GIT_OPTIONAL_LOCKS'])
    assert.deepEqual(args.slice(2, 2 + HARDENED_GIT_CONFIG.length), HARDENED_GIT_CONFIG)
    return f.execute(args, env)
  } })
  repos.read(f.repo)
  await repos.flush()
  assert.deepEqual(repos.read(f.repo), { root: f.repo, worktree: false })
  await assert.rejects(readFile(marker), { code: 'ENOENT' })
})

test('submodules and their linked checkouts use the recorded working folder, not .git/modules', async () => {
  const f = await fixture()
  const superRepo = join(f.base, 'super')
  await mkdir(superRepo)
  await f.git(superRepo, 'init', '-q', '-b', 'main')
  await f.git(superRepo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', f.repo, 'vendor/child')
  const inside = join(superRepo, 'vendor', 'child')
  const linked = join(f.base, 'child-linked')
  await f.git(inside, 'worktree', 'add', '-q', '-b', 'side', linked)
  const repos = new SessionIndexRepos(memoryIndex(), { execute: f.execute, env: f.env })
  repos.read(inside); repos.read(linked)
  await repos.flush()
  assert.deepEqual(repos.read(inside), { root: inside, worktree: false })
  assert.deepEqual(repos.read(linked), { root: inside, worktree: true })
  assert.equal(f.calls.length, 2)
})

test('a linked checkout refuses a missing or replaced recorded main folder', async () => {
  const f = await fixture()
  const separate = join(f.base, 'metadata')
  const main = join(f.base, 'main')
  await mkdir(main)
  await f.git(main, 'init', '-q', '-b', 'main', `--separate-git-dir=${separate}`)
  await f.git(main, 'config', 'core.worktree', main)
  await f.git(main, 'commit', '--allow-empty', '-q', '-m', 'fixture')
  const linked = join(f.base, 'linked')
  await f.git(main, 'worktree', 'add', '-q', '-b', 'side', linked)
  await rename(main, join(f.base, 'main-moved'))
  let repos = new SessionIndexRepos(memoryIndex(), { execute: f.execute, env: f.env })
  repos.read(linked); await repos.flush()
  assert.equal(repos.read(linked), null)
  await mkdir(main)
  await f.git(main, 'init', '-q', '-b', 'main')
  repos = new SessionIndexRepos(memoryIndex(), { execute: f.execute, env: f.env })
  repos.read(linked); await repos.flush()
  assert.equal(repos.read(linked), null)
})
