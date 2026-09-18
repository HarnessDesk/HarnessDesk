import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { AcpRuntime } from '@harnessdesk/adapter-acp'
import type { Session } from '@harnessdesk/protocol'

import { Client, start, stop, type Harness } from './fixtures/harness.js'

/**
 * Which folders a conversation reopened through the ACP adapter opens.
 *
 * A conversation's folder is an open root: `confine`, `#confineGitRoot` and
 * `openRepositoryRoot` all admit what is inside one. The ACP adapter learns
 * where a stored conversation worked from the agent's own `session/list`, and
 * where that had no row for it — an agent that keeps no listing, a listing
 * that failed, a row on a later page — it fell back to this process's working
 * directory and loaded the conversation there. That is the dev checkout under
 * `pnpm dev`, and `/` when the app is started from Finder, which holds every
 * repository on the machine.
 *
 * In a file of its own because it moves this process's working directory,
 * which is the host's: that is the folder under test.
 */

const FAKE = fileURLToPath(new URL('../../../adapter-acp/dist/test/fixtures/fake-acp-agent.mjs', import.meta.url))
const AGENT = 'fake-acp'

const gitIn = async (cwd: string, ...args: string[]): Promise<string> =>
  (
    await promisify(execFile)('git', ['-C', cwd, ...args], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@x',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@x',
      },
    })
  ).stdout

const repository = async (path: string): Promise<void> => {
  await mkdir(path, { recursive: true })
  await gitIn(path, 'init', '-q', '-b', 'main')
  await gitIn(path, 'commit', '-q', '--allow-empty', '-m', 'root commit')
}

interface Opened {
  readonly method: string
  readonly sessionId: string
  readonly cwd: string
}

interface Desk {
  readonly client: Client
  /** The host's working directory, with `unopened` inside it. */
  readonly hostCwd: string
  /** A repository nobody opened, inside the host's working directory. */
  readonly unopened: string
  /** Where the listed conversation ran: a repository of its own. */
  readonly listedAt: string
  /** `git/status` of a root: its branch, or the refusal. */
  branchOf(root: string): Promise<string | null | undefined>
  /** Every session the agent was asked to open, new or loaded, and where. */
  opened(): Promise<Opened[]>
}

/**
 * A host whose working directory holds a repository nobody opened — as the dev
 * checkout holds one, and `/` holds them all — in front of an agent that serves
 * two stored conversations and lists one. The other is the row Claude Code's
 * bridge leaves out when its own listing has no folder for it, or a Cursor chat
 * under a workspace nobody named here.
 */
const desk = async (t: TestContext): Promise<Desk> => {
  // Real paths throughout, so nothing but the rule under test stands between
  // two spellings of one folder: macOS keeps its temporary folders behind
  // /var -> /private/var, and `process.cwd()` answers with the real one.
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'hd-acp-roots-')))
  const hostCwd = join(scratch, 'host')
  const unopened = join(hostCwd, 'unopened')
  await repository(unopened)
  const listedAt = join(scratch, 'listed')
  await repository(listedAt)
  const hiddenAt = join(scratch, 'hidden')
  await mkdir(hiddenAt)
  const store = join(scratch, 'store.json')
  const opens = join(scratch, 'opens.jsonl')
  const at = new Date().toISOString()
  await writeFile(
    store,
    JSON.stringify({
      listed: { sessionId: 'listed', cwd: listedAt, title: 'Listed', updatedAt: at, turns: [['in the listing']] },
      hidden: { sessionId: 'hidden', cwd: hiddenAt, title: 'Hidden', updatedAt: at, turns: [['out of it']] },
    }),
  )

  // One teardown, in order, for whatever was set up: the socket, then the
  // host — which disposes every runtime registered with it — then this
  // process's working directory, and only then the folder it was in.
  const before = process.cwd()
  let harness: Harness | undefined
  let client: Client | undefined
  t.after(async () => {
    client?.close()
    if (harness) await stop(harness)
    process.chdir(before)
    await rm(scratch, { recursive: true, force: true })
  })
  process.chdir(hostCwd)
  harness = await start()
  const agent = new AcpRuntime({
    id: AGENT,
    name: 'Fake ACP Agent',
    command: process.execPath,
    args: [FAKE],
    env: { FAKE_ACP_STORE: store, FAKE_ACP_UNLISTED: 'hidden', FAKE_ACP_OPENS: opens },
  })
  harness.host.register(agent)
  await agent.start()
  client = await Client.connect(harness.server)
  const connected = client

  return {
    client: connected,
    hostCwd,
    unopened,
    listedAt,
    branchOf: (root) =>
      connected.call('git/status', { root }).then(
        (answer) => (answer as { branch?: string | null }).branch,
        (error: Error) => error.message,
      ),
    opened: async () =>
      (await readFile(opens, 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Opened),
  }
}

/** What `method` came to for a conversation: the folder it answered in, or the refusal. */
const outcome = (client: Client, method: 'session/read' | 'session/resume', id: string) =>
  client.call(method, { runtime: AGENT, sessionId: id }).then(
    (session) => ({ cwd: (session as Session).cwd }),
    (error: Error & { code?: string }) => ({ refused: error.message, code: error.code }),
  )

const outside = (path: string): string =>
  `${path} is outside every open workspace. Open its folder first to read from it.`

test('a conversation its agent does not list opens no folder, least of all the host\'s own', async (t) => {
  const { client, hostCwd, unopened, listedAt, branchOf, opened } = await desk(t)

  // The controls: the host's working directory is the folder the adapter used
  // to fall back to, and the repository inside it is refused. Reopened where
  // its agent lists it, a conversation opens that folder and nothing more.
  assert.equal(process.cwd(), hostCwd)
  assert.equal(await branchOf(unopened), outside(unopened))
  assert.deepEqual(await outcome(client, 'session/resume', 'listed'), { cwd: listedAt })
  assert.equal(await branchOf(listedAt), 'main')
  assert.equal(await branchOf(unopened), outside(unopened))

  // Served but not listed: refused by name, by a reopen and by a read alike
  // — the host has no transcript of its own to fall back to — and afterwards
  // the repository in the host's folder is still nobody's.
  const refusal = 'Fake ACP Agent does not list conversation hidden, so the folder it worked in is not known.'
  assert.deepEqual(
    {
      resumed: await outcome(client, 'session/resume', 'hidden'),
      read: await outcome(client, 'session/read', 'hidden'),
      unopened: await branchOf(unopened),
      loads: (await opened()).filter((open) => open.method === 'session/load'),
    },
    {
      resumed: { refused: `Fake ACP Agent could not reopen this conversation: ${refusal}`, code: 'sessionGone' },
      read: { refused: refusal, code: 'sessionGone' },
      unopened: outside(unopened),
      loads: [{ method: 'session/load', sessionId: 'listed', cwd: listedAt }],
    },
  )
})
