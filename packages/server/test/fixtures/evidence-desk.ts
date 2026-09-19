import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import { promisify } from 'node:util'

import { Host, StateStore, type HostOptions } from '../../src/index.js'
import { tempDir } from '../scratch.js'
import { FakeRuntime } from './fake-runtime.js'
import { silent } from './harness.js'

/**
 * What the evidence plane's tests stand on: a git repository made the way a
 * person would make one, as Jane Doe. Task 4 adds a desk beside it.
 */

const run = promisify(execFile)

export interface Repo {
  readonly dir: string
  /** git, in the repository, as Jane Doe. */
  git(...args: string[]): Promise<string>
}

/** A repository on `main` with one commit. */
export const makeRepo = async (prefix = 'hd-evidence-repo-'): Promise<Repo> => {
  const dir = tempDir(prefix)
  const git = async (...args: string[]): Promise<string> =>
    (await run('git', ['-C', dir, '-c', 'user.email=dev@example.com', '-c', 'user.name=Jane Doe', ...args])).stdout.trim()
  await git('init', '-q', '-b', 'main')
  await writeFile(join(dir, 'README.md'), 'hello\n')
  await git('add', '.')
  await git('commit', '-q', '-m', 'first')
  return { dir, git }
}

export interface EvidenceDesk {
  readonly host: Host
  readonly runtime: FakeRuntime
  readonly stateDir: string
  readonly repo: Repo
  /** Disposes the host, once — for a test that starts a second host on this one's state. */
  stop(): Promise<void>
}

/**
 * A started host reached through `host.call` — no socket, so nothing here needs
 * a loopback listener — with the fake runtime registered and a repository open
 * as its project. On its own state directory, or on `at`: a halted host's, for
 * what survives a restart. `host.call` is below the wire's validation; a test of
 * what the wire admits uses `parseClientMessage` beside it.
 */
export const evidenceDesk = async (
  t: TestContext,
  options: Partial<HostOptions> = {},
  at?: { readonly stateDir: string; readonly repo: Repo },
): Promise<EvidenceDesk> => {
  const stateDir = at?.stateDir ?? tempDir('hd-evidence-state-')
  const repo = at?.repo ?? (await makeRepo())
  const runtime = new FakeRuntime()
  const host = new Host({
    logger: silent,
    state: new StateStore(join(stateDir, 'state.json')),
    builtinAgents: tempDir('hd-evidence-builtins-'),
    catalogRefreshMs: 0,
    ...options,
  })
  host.register(runtime)
  await host.start()
  // Dispose is terminal and throws the second time, so a test that stops a host early is not stopped again.
  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    await host.dispose()
  }
  t.after(stop)
  await host.call('workspace/open', { path: repo.dir })
  return { host, runtime, stateDir, repo, stop }
}

/** One of this machine's Agents, seated on the fake runtime. Answers its file's text. */
export const writeAgent = async (stateDir: string, id = 'scout', name = 'Scout'): Promise<string> => {
  const source = `---\nname: ${name}\npermission: read\nprefer: [fake]\n---\nLook around, and say what you saw.\n`
  await mkdir(join(stateDir, 'agents', id), { recursive: true })
  await writeFile(join(stateDir, 'agents', id, 'AGENT.md'), source, 'utf8')
  return source
}

/** Waits for something the host does after it answers, and says what was awaited when it does not come. */
export const until = async <T>(read: () => Promise<T | null> | T | null, what: string, ms = 5_000): Promise<T> => {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await read()
    if (value !== null) return value
    if (Date.now() > deadline) throw new Error(`waited ${ms}ms for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
