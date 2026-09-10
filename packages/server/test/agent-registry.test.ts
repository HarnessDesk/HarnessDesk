import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { RuntimeId, WireNotification } from '@harnessdesk/protocol'

import { AgentDirectory, AgentRegistryStore, slugOf } from '../src/agent-registry.js'
import { currentNameOf, knownAgent } from '../src/installs/known-agents.js'
import { Host, Logger, StateStore } from '../src/index.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'

/**
 * The writable agent registry: the same `agents.json` the app has always
 * read, now written on behalf of the interface. What these tests hold to:
 * the file survives entries it does not understand, a hand-edit gone wrong
 * is never silently overwritten, and the host's wire methods register and
 * remove real runtimes — not merely rows.
 */

const silent = new Logger('test', { level: 'error', console: false })

const tempDir = () => mkdtemp(join(tmpdir(), 'hd-agents-'))

test('a custom entry round-trips through the store', async (t) => {
  const dir = await tempDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new AgentRegistryStore(join(dir, 'agents.json'))

  store.add({ id: 'my-agent', name: 'My Agent', command: 'my-agent', args: ['--acp'] })
  const configs = store.configs()
  assert.equal(configs.length, 1)
  assert.equal(configs[0]?.id, 'my-agent')
  assert.equal(configs[0]?.command, 'my-agent')
  assert.deepEqual(configs[0]?.args, ['--acp'])
})

test('a template entry expands to the bridge this build carries', async (t) => {
  const dir = await tempDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new AgentRegistryStore(join(dir, 'agents.json'))

  store.add({ id: 'claude-code', template: 'claude-code' })
  const [config] = store.configs()
  assert.ok(config, 'the template expanded to a runnable config')
  assert.equal(config.id, 'claude-code')
  assert.equal(config.name, 'Claude')
  // The bridge runs under this process's own executable, which is what still
  // exists in a packaged app where `node` may not be on PATH.
  assert.equal(config.command, process.execPath)
  assert.match(config.args?.[0] ?? '', /claude-acp[/\\]dist[/\\]src[/\\]main\.js$/)
  assert.equal(config.executable?.env, 'CLAUDE_CODE_EXECUTABLE')
  // What is stored is the pointer, not the expansion: the path is resolved on
  // every load, so moving the app cannot strand the registry.
  const raw = JSON.parse(await readFile(join(dir, 'agents.json'), 'utf8')) as {
    agents: Record<string, unknown>[]
  }
  assert.deepEqual(raw.agents, [{ id: 'claude-code', template: 'claude-code' }])
})

test('entries the store did not write survive an add and a remove untouched', async (t) => {
  const dir = await tempDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'agents.json')
  const handWritten = {
    id: 'dsh',
    name: 'DeepSeek Harness',
    command: 'node',
    args: ['/somewhere/bin.js', '--config', '/etc/dsh.yml'],
    cwd: '/somewhere',
    secrets: [{ env: 'DEEPSEEK_API_KEY', label: 'DeepSeek API key' }],
    somethingFutureVersionsUse: { nested: true },
  }
  await writeFile(path, JSON.stringify({ agents: [handWritten] }))
  const store = new AgentRegistryStore(path)

  store.add({ id: 'extra', name: 'Extra', command: 'extra' })
  store.remove('extra')
  const raw = JSON.parse(await readFile(path, 'utf8')) as { agents: unknown[] }
  assert.deepEqual(raw.agents, [handWritten], 'the hand-written entry came through byte-for-byte')
})

test('a duplicate id and a malformed id are refused', async (t) => {
  const dir = await tempDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new AgentRegistryStore(join(dir, 'agents.json'))
  store.add({ id: 'one', name: 'One', command: 'one' })
  assert.throws(() => store.add({ id: 'one', name: 'Two', command: 'two' }), /already registered/)
  assert.throws(() => store.add({ id: 'Bad Id!', name: 'Bad', command: 'bad' }), /lowercase/)
})

test('a corrupt registry is never overwritten by a write', async (t) => {
  const dir = await tempDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'agents.json')
  await writeFile(path, '{ agents: [ this was hand-edited') // not JSON
  const store = new AgentRegistryStore(path)

  assert.deepEqual(store.configs(), [], 'reading a corrupt file yields nothing, not a crash')
  assert.throws(() => store.add({ id: 'new', name: 'New', command: 'new' }), /not valid JSON/)
  assert.equal(
    await readFile(path, 'utf8'),
    '{ agents: [ this was hand-edited',
    'the broken file is left for the user to fix, not clobbered',
  )
})

test('slugOf turns a display name into a usable id', () => {
  assert.equal(slugOf('My Great Agent'), 'my-great-agent')
  assert.equal(slugOf('  DSH (local) '), 'dsh-local')
  assert.equal(slugOf('!!!'), '')
})

// ---------------------------------------------------------------- templates

const directoryWith = (
  store: AgentRegistryStore,
  which: (command: string) => Promise<string | null> = async () => null,
) =>
  new AgentDirectory({
    store,
    build: (config) => new FakeRuntime({ id: config.id as RuntimeId, name: config.name }),
    usageFor: () => null,
    which,
  })

test('the catalogue reports availability from this machine, not from hope', async (t) => {
  const dir = await tempDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new AgentRegistryStore(join(dir, 'agents.json'))
  // No CLI is installed anywhere in this test.
  const templates = await directoryWith(store).templates(new Set())

  const claude = templates.find((entry) => entry.key === 'claude-code')
  assert.ok(claude)
  // The bridge embeds its own copy, so a machine without the CLI still works.
  assert.equal(claude.available, true)
  assert.equal(claude.requires?.found, false)

  const cursor = templates.find((entry) => entry.key === 'cursor')
  assert.ok(cursor)
  assert.equal(cursor.available, false, 'the cursor bridge cannot run without cursor-agent')
  assert.match(cursor.reason ?? '', /cursor-agent is not installed/)
  assert.ok(cursor.requires?.installCommand)
})

test('the template set is a decision, and DSH is deliberately not in it', async (t) => {
  const dir = await tempDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new AgentRegistryStore(join(dir, 'agents.json'))
  const templates = await directoryWith(store).templates(new Set())

  // Pinned so a row appearing or vanishing is a conscious test change. The
  // bar is "runs without the user editing anything" — which is why DeepSeek
  // Harness is absent even on a machine with `dsh` installed: our dsh-acp
  // server needs a machine-specific --config, so it registers through the
  // custom-command form instead. See the TEMPLATES doc in agent-registry.ts.
  //
  // The display name is pinned beside the key: it is what every meter, menu
  // and hand-off in the interface goes on to say, so shortening one is a
  // choice made here rather than a spelling that drifts.
  assert.deepEqual(
    templates.map((entry) => [entry.key, entry.name]).sort(),
    [
      ['claude-code', 'Claude'],
      ['cursor', 'Cursor'],
      ['gemini', 'Gemini CLI'],
      // Neither is in the public ACP registry, and both speak ACP from
      // their own CLI: OpenClaw through `openclaw acp`, which needs the
      // person's Gateway running; Hermes through `hermes acp`.
      ['hermes', 'Hermes Agent'],
      ['openclaw', 'OpenClaw'],
    ],
  )
})

test('the catalogue marks registered templates, from the file and from live runtimes', async (t) => {
  const dir = await tempDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new AgentRegistryStore(join(dir, 'agents.json'))
  store.add({ id: 'claude-code', template: 'claude-code' })
  const directory = directoryWith(store)

  const templates = await directory.templates(new Set(['gemini']))
  assert.equal(templates.find((entry) => entry.key === 'claude-code')?.registered, true)
  assert.equal(templates.find((entry) => entry.key === 'gemini')?.registered, true)
  assert.equal(templates.find((entry) => entry.key === 'cursor')?.registered, false)
})

// ------------------------------------------------------------- host methods

const hostWith = async (t: { after(fn: () => unknown): void }) => {
  const stateDir = await tempDir()
  const store = new AgentRegistryStore(join(stateDir, 'agents.json'))
  const directory = directoryWith(store, async (command) =>
    command === 'gemini' ? '/usr/local/bin/gemini' : null,
  )
  const host = new Host({
    logger: silent,
    state: new StateStore(join(stateDir, 'state.json')),
    agents: directory,
    catalogRefreshMs: 0,
  })
  const pushed: WireNotification[] = []
  host.addBroadcaster((notification) => pushed.push(notification))
  t.after(async () => {
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })
  return { host, store, pushed, stateDir }
}

test('agents/register brings the runtime up and tells every window', async (t) => {
  const { host, store, pushed } = await hostWith(t)

  const result = await host.call('agents/register', { template: 'gemini' })
  assert.equal(result.runtime, 'gemini')
  assert.equal(result.info.origin, 'registry', 'the row knows it is the registry’s to remove')
  assert.ok(store.has('gemini'), 'the entry was persisted before the runtime existed')

  const added = pushed.find((entry) => entry.method === 'runtime/added')
  assert.ok(added, 'every window heard about the new agent')

  const hello = await host.call('host/hello', { clientVersion: 'test' })
  assert.ok(hello.runtimes.some((entry) => entry.id === 'gemini'))
})

test('agents/register refuses an id that is already running', async (t) => {
  const { host } = await hostWith(t)
  host.register(new FakeRuntime({ id: 'gemini' as RuntimeId, name: 'Occupied' }))
  await assert.rejects(host.call('agents/register', { template: 'gemini' }), /already running/)
})

test('a custom agent registers under a slug of its name', async (t) => {
  const { host, store } = await hostWith(t)
  const result = await host.call('agents/register', {
    custom: { name: 'My Local Agent', command: 'my-agent', args: ['--acp'] },
  })
  assert.equal(result.runtime, 'my-local-agent')
  assert.ok(store.has('my-local-agent'))
})

test('agents/remove unregisters the runtime and the row, and refuses what it does not own', async (t) => {
  const { host, store, pushed } = await hostWith(t)
  await host.call('agents/register', { template: 'gemini' })

  await host.call('agents/remove', { runtime: 'gemini' as RuntimeId })
  assert.equal(store.has('gemini'), false, 'the entry left the file')
  assert.ok(
    pushed.some((entry) => entry.method === 'runtime/removed'),
    'every window heard the agent leave',
  )
  const hello = await host.call('host/hello', { clientVersion: 'test' })
  assert.ok(!hello.runtimes.some((entry) => entry.id === 'gemini'))

  // A runtime the registry does not own — Codex, an account slot — is refused.
  host.register(new FakeRuntime({ id: 'builtin' as RuntimeId, name: 'Built In' }))
  await assert.rejects(
    host.call('agents/remove', { runtime: 'builtin' as RuntimeId }),
    /nothing to unregister/,
  )
})

// ---------------------------------------------------------- the ACP registry

/** The registry as a stub: one addable entry, resolving to a plain command. */
const stubRegistry = () => {
  const calls: string[] = []
  const registry = {
    calls,
    async catalog(isRegistered: (id: string) => boolean) {
      return {
        fetchedAt: 1,
        agents: [
          {
            id: 'goose',
            name: 'goose',
            version: '1.0.0',
            run: 'binary' as const,
            available: true,
            registered: isRegistered('goose'),
          },
        ],
      }
    },
    /** What the document names now; a test moves it to stand for a new release. */
    version: '1.0.0',
    async resolve(id: string) {
      calls.push(id)
      if (id !== 'goose') throw new Error(`The ACP registry has no agent with the id "${id}".`)
      const entry = {
        id: 'goose',
        name: 'goose',
        command: `/state/acp-agents/goose/${registry.version}/goose`,
        args: ['acp'],
        registry: { id: 'goose', version: registry.version },
      }
      return { entry, config: entry as never }
    },
    uninstallVersion(id: string, version: string) {
      calls.push(`uninstallVersion:${id}@${version}`)
    },
    uninstall(id: string) {
      calls.push(`uninstall:${id}`)
    },
  }
  return registry
}

const registryHostWith = async (t: { after(fn: () => unknown): void }) => {
  const stateDir = await tempDir()
  const store = new AgentRegistryStore(join(stateDir, 'agents.json'))
  const directory = new AgentDirectory({
    store,
    build: (config) => new FakeRuntime({ id: config.id as RuntimeId, name: config.name }),
    usageFor: () => null,
    which: async () => null,
    registry: stubRegistry(),
  })
  const host = new Host({
    logger: silent,
    state: new StateStore(join(stateDir, 'state.json')),
    agents: directory,
    catalogRefreshMs: 0,
  })
  t.after(async () => {
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })
  return { host, store }
}

test('agents/registry answers through the directory, marking what this desk holds', async (t) => {
  const { host, store } = await registryHostWith(t)
  const before = await host.call('agents/registry', {})
  assert.equal(before.agents[0]?.registered, false)

  // Registered in the file or running live both count as held.
  store.add({ id: 'goose', name: 'goose', command: 'goose' })
  const after = await host.call('agents/registry', {})
  assert.equal(after.agents[0]?.registered, true)
})

test('a host without a registry says so instead of erroring', async (t) => {
  const { host } = await hostWith(t)
  const result = await host.call('agents/registry', {})
  assert.equal(result.agents.length, 0)
  assert.match(result.unavailable ?? '', /reads no ACP registry/)
})

test('agents/register takes a registry entry, provenance and all', async (t) => {
  const { host, store } = await registryHostWith(t)
  const result = await host.call('agents/register', { registry: { id: 'goose' } })
  assert.equal(result.runtime, 'goose')
  assert.equal(result.info.origin, 'registry', 'a registry row is removable like any other')

  const raw = store.entries().find((entry) => entry['id'] === 'goose')
  assert.deepEqual(raw?.['registry'], { id: 'goose', version: '1.0.0' })

  // The stored row is a plain command entry: it survives with no registry.
  const [config] = store.configs()
  assert.equal(config?.command, '/state/acp-agents/goose/1.0.0/goose')
})

test('a registry id that resolves to nothing leaves no row behind', async (t) => {
  const { host, store } = await registryHostWith(t)
  await assert.rejects(
    host.call('agents/register', { registry: { id: 'nope' } }),
    /no agent with the id/,
  )
  assert.equal(store.ids().length, 0)
})

test('a registry name the desk has retired is not the one it lists, shows or writes', async (t) => {
  const stateDir = await tempDir()
  const store = new AgentRegistryStore(join(stateDir, 'agents.json'))
  // What the public registry calls Antigravity, which the desk no longer does.
  const listed = { id: 'antigravity-acp', name: 'Google Antigravity', version: '1.1.1' }
  const directory = new AgentDirectory({
    store,
    build: (config) => new FakeRuntime({ id: config.id as RuntimeId, name: config.name }),
    usageFor: () => null,
    which: async () => null,
    registry: {
      async catalog(isRegistered: (id: string) => boolean) {
        return {
          fetchedAt: 1,
          agents: [{ ...listed, run: 'binary' as const, available: true, registered: isRegistered(listed.id) }],
        }
      },
      async resolve() {
        const entry = {
          id: listed.id,
          name: listed.name,
          command: '/state/acp-agents/antigravity-acp/1.1.1/agy_acp_server.par',
          registry: { id: listed.id, version: listed.version },
        }
        return { entry, config: entry as never }
      },
      uninstall() {},
    },
  })
  const host = new Host({
    logger: silent,
    state: new StateStore(join(stateDir, 'state.json')),
    agents: directory,
    catalogRefreshMs: 0,
  })
  t.after(async () => {
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })

  assert.equal((await host.call('agents/registry', {})).agents[0]?.name, 'Antigravity')
  const result = await host.call('agents/register', { registry: { id: 'antigravity-acp' } })
  assert.equal(result.info.name, 'Antigravity')
  assert.equal(store.entry('antigravity-acp')?.['name'], 'Antigravity', 'the file says what the screen says')
})

test('a retired name is replaced where it is read, and a name someone chose is left alone', () => {
  const antigravity = knownAgent('antigravity-acp')
  assert.equal(currentNameOf(antigravity, 'Google Antigravity'), 'Antigravity')
  assert.equal(currentNameOf(antigravity, 'Work Antigravity'), 'Work Antigravity')
  assert.equal(currentNameOf(knownAgent('gemini'), 'Gemini CLI'), 'Gemini CLI')
  assert.equal(currentNameOf(undefined, 'Google Antigravity'), 'Google Antigravity', 'a row the desk cannot place keeps its name')
})

test('removing a registry-installed agent deletes its download; removing anything else never does', async (t) => {
  const stateDir = await tempDir()
  const store = new AgentRegistryStore(join(stateDir, 'agents.json'))
  const registry = stubRegistry()
  const directory = new AgentDirectory({
    store,
    build: (config) => new FakeRuntime({ id: config.id as RuntimeId, name: config.name }),
    usageFor: () => null,
    which: async () => null,
    registry,
  })
  const host = new Host({
    logger: silent,
    state: new StateStore(join(stateDir, 'state.json')),
    agents: directory,
    catalogRefreshMs: 0,
  })
  t.after(async () => {
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })

  await host.call('agents/register', { registry: { id: 'goose' } })
  await host.call('agents/remove', { runtime: 'goose' as RuntimeId })
  assert.ok(
    registry.calls.includes('uninstall:goose'),
    'the provenance told removal which download to delete',
  )

  // A custom row has no provenance and owns no download: nothing to delete.
  registry.calls.length = 0
  await host.call('agents/register', { custom: { name: 'Plain', command: 'plain' } })
  await host.call('agents/remove', { runtime: 'plain' as RuntimeId })
  assert.ok(
    !registry.calls.some((entry) => entry.startsWith('uninstall:')),
    'removal of a plain entry never reaches the registry',
  )
})

test('an update replaces the download and collects the build it superseded', async (t) => {
  const stateDir = await tempDir()
  const store = new AgentRegistryStore(join(stateDir, 'agents.json'))
  const registry = stubRegistry()
  const directory = new AgentDirectory({
    store,
    build: (config) => new FakeRuntime({ id: config.id as RuntimeId, name: config.name }),
    usageFor: () => null,
    which: async () => null,
    registry,
  })
  const host = new Host({
    logger: silent,
    state: new StateStore(join(stateDir, 'state.json')),
    agents: directory,
    catalogRefreshMs: 0,
  })
  t.after(async () => {
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })

  await host.call('agents/register', { registry: { id: 'goose' } })
  registry.calls.length = 0
  registry.version = '1.1.0'
  await host.call('agents/update', { runtime: 'goose' as RuntimeId })

  // The row now runs the new build, and its provenance says which one.
  const entry = store.entry('goose')!
  assert.equal(entry['command'], '/state/acp-agents/goose/1.1.0/goose')
  assert.deepEqual(entry['registry'], { id: 'goose', version: '1.1.0' })
  // A runtime with no `checkInstallation` can never report a restart, and the
  // row already points elsewhere — so the superseded download is collected
  // rather than orphaned on disk forever.
  assert.ok(registry.calls.includes('uninstallVersion:goose@1.0.0'))

  // An agent the desk did not install is its package manager's to update.
  await host.call('agents/register', { custom: { name: 'Plain', command: 'plain' } })
  await assert.rejects(
    host.call('agents/update', { runtime: 'plain' as RuntimeId }),
    /package manager updates it/,
  )
})
