import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after as afterAll, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { ContributionId, ExtensionEvent, SessionId } from '@harnessdesk/protocol'

import type { SupervisedExtensionHost, SupervisedExtensionHostOptions } from '../src/index.js'
import { childrenGone, childrenUp, Hosts } from './hosts.js'

/**
 * One process per installed plugin, and what the host holds each process to:
 * the snapshot it reports, the environment it starts with, the order its
 * hooks run in beside other plugins', the manifest the person agreed to, the
 * config it was given, and whether it runs at all.
 *
 * `isolation.test.ts` covers crashes, spins and leaks; this file covers the
 * authority the host keeps over a plugin's process (docs/plugin-isolation.md).
 */

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url))
const scope = { sessionId: 's1' as SessionId }

const hosts = new Hosts()
afterAll(() => hosts.settle())

interface Harness {
  readonly host: SupervisedExtensionHost
  readonly dir: string
  readonly store: string
  toolId(name: string): ContributionId
}

const make = async (
  dir: string,
  label: string,
  options: SupervisedExtensionHostOptions = {},
): Promise<Harness> => {
  const store = join(dir, 'plugins')
  const host = hosts.make(label, { invokeTimeoutMs: 1500, ...options, env: { HARNESSDESK_PLUGINS: store, ...options.env } })
  try {
    await host.loadInstalledPlugins()
  } catch (error) {
    await host.dispose()
    throw error
  }
  return {
    host,
    dir,
    store,
    toolId(name) {
      const tool = host.list('tool').find((entry) => entry.name === name)
      assert.ok(tool, `tool ${name} should be contributed; saw ${host.list('tool').map((t) => t.name).join(', ')}`)
      return tool.id
    },
  }
}

const start = async (plugins: readonly string[], options: SupervisedExtensionHostOptions = {}): Promise<Harness> => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-perplugin-'))
  for (const plugin of plugins) {
    await cp(join(FIXTURES, `plugin-${plugin}`), join(dir, 'plugins', plugin), { recursive: true })
  }
  try {
    return await make(dir, `start(${plugins.join(', ')})`, options)
  } catch (error) {
    await rm(dir, { recursive: true, force: true })
    throw error
  }
}

const cleanup = async (harness: Pick<Harness, 'host' | 'dir'>): Promise<void> => {
  await harness.host.dispose()
  await rm(harness.dir, { recursive: true, force: true })
}

const until = async (predicate: () => boolean, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

const textOf = (result: unknown): string => {
  assert.equal((result as { ok: boolean }).ok, true, JSON.stringify(result))
  const match = /\{[^{}]*"pid"[^{}]*\}/.exec(JSON.stringify(result).replace(/\\"/g, '"'))
  assert.ok(match, `no report in ${JSON.stringify(result)}`)
  return match[0]
}

const spy = async (harness: Harness): Promise<{ secret: string | null; nodeOptions: string | null; pid: number; greeting: string | null }> =>
  JSON.parse(textOf(await harness.host.invokeTool(harness.toolId('spy'), {}, scope)))

test('every installed plugin runs in a process of its own', async () => {
  const harness = await start(['good', 'envspy'])
  try {
    const stats = await harness.host.stats()
    const processes = stats.processes ?? []
    assert.deepEqual(processes.map((entry) => entry.plugin).sort(), ['envspy', 'good'])
    assert.equal(new Set(processes.map((entry) => entry.pid)).size, 2, 'two plugins, two processes')
    // The plugin's own report agrees with the host's accounting.
    const { pid } = await spy(harness)
    assert.equal(processes.find((entry) => entry.plugin === 'envspy')?.pid, pid)
  } finally {
    await cleanup(harness)
  }
})

test('a plugin process starts from an allowlisted environment, never the host\'s whole one', async () => {
  const previous = process.env['HD_TEST_PARENT_SECRET']
  process.env['HD_TEST_PARENT_SECRET'] = 'parent-only'
  try {
    const harness = await start(['envspy'], {
      env: { NODE_OPTIONS: '--no-warnings' },
    })
    try {
      const report = await spy(harness)
      assert.equal(report.secret, null, 'a variable the host holds does not reach a plugin')
      assert.equal(report.nodeOptions, null, 'NODE_OPTIONS is never passed to a plugin process')
    } finally {
      await cleanup(harness)
    }
  } finally {
    if (previous === undefined) delete process.env['HD_TEST_PARENT_SECRET']
    else process.env['HD_TEST_PARENT_SECRET'] = previous
  }
})

/** Every event the host emits from now on, and a way to wait for one. */
const listen = (host: SupervisedExtensionHost) => {
  const heard: ExtensionEvent[] = []
  const stop = host.subscribe((event) => heard.push(event))
  return {
    heard,
    stop,
    /** Waits for the fixture's own closing log line: every frame before it has been handled. */
    async sent(marker: string): Promise<void> {
      await until(() => heard.some((event) => event.type === 'extension/log' && event.message === marker))
    },
  }
}

const mentions = (event: ExtensionEvent, text: string): boolean => JSON.stringify(event).includes(text)

test('a snapshot a plugin forges is held to what the host knows about that plugin', async () => {
  const harness = await start(['good', 'forger'])
  const events = listen(harness.host)
  try {
    const sent = await harness.host.invokeTool(harness.toolId('forge_snapshot'), {}, scope)
    assert.equal(sent.ok, true, JSON.stringify(sent))
    await events.sent('snapshot sent')

    const forger = harness.host.plugins().find((plugin) => plugin.identity.id === 'forger')
    assert.ok(forger, 'the forger is still listed as itself')
    assert.equal(forger.instanceId, 'forger#installed', 'its instance id is the host\'s, not one it chose')
    assert.equal(forger.identity.name, "Plugin that forges its process's snapshot", 'identity comes from the manifest')
    assert.equal(forger.permissions.shell, false, 'permissions come from the manifest the host read')
    assert.equal(forger.permissions.ui.contribute, false)
    assert.equal(harness.host.plugins().some((plugin) => String(plugin.instanceId).startsWith('git')), false,
      'an instance id that is not its own is not taken')
    assert.equal(harness.host.list('ui').some((entry) => (entry as { label?: string }).label === 'forged_panel'), false,
      'a UI contribution without ui.contribute is dropped')
    assert.equal(harness.host.list('tool').some((entry) => entry.name === 'forged_ping'), false,
      'a plugin cannot report contributions for another plugin')
    const goods = harness.host.plugins().filter((plugin) => plugin.identity.id === 'good')
    assert.equal(goods.length, 1, 'the real good plugin is listed once')
    const ping = await harness.host.invokeTool(harness.toolId('ping'), {}, scope)
    assert.equal(ping.ok, true, 'the real good plugin is untouched')
  } finally {
    events.stop()
    await cleanup(harness)
  }
})

test('events a plugin forges about another plugin never leave the host, and its own are re-owned', async () => {
  const harness = await start(['good', 'forger'])
  const events = listen(harness.host)
  try {
    const sent = await harness.host.invokeTool(harness.toolId('forge_events'), {}, scope)
    assert.equal(sent.ok, true, JSON.stringify(sent))
    await events.sent('events sent')

    const fromForger = events.heard.filter((event) => !mentions(event, 'invocation'))
    assert.equal(fromForger.some((event) => mentions(event, 'good#')), false,
      `nothing about the good plugin got through: ${JSON.stringify(fromForger.filter((event) => mentions(event, 'good#')))}`)
    assert.equal(fromForger.some((event) => mentions(event, 'forged_panel')), false, 'no panel without ui.contribute')
    const own = fromForger.find((event): event is Extract<ExtensionEvent, { type: 'contributions/changed' }> => event.type === 'contributions/changed')
    assert.ok(own, 'its own contributions event is passed on')
    assert.equal(own.owner, 'forger#installed')
    assert.deepEqual(own.contributions, [], 'with nothing it may not contribute')
    const log = fromForger.find((event) => event.type === 'extension/log' && event.message === 'events sent')
    assert.equal((log as { owner?: string } | undefined)?.owner, 'forger#installed', 'a log line is the plugin\'s own, whatever it says')

    assert.equal(harness.host.plugins().filter((plugin) => plugin.identity.id === 'good').length, 1)
    assert.equal((await harness.host.invokeTool(harness.toolId('ping'), {}, scope)).ok, true)
  } finally {
    events.stop()
    await cleanup(harness)
  }
})

test('hooks run in priority order across plugins, not in install order', async () => {
  // `deferred` is listed before `good`, and its hook (priority 50) would answer
  // first if plugins were asked in turn; the good plugin's (priority 10) runs first.
  const harness = await start(['deferred', 'good'])
  try {
    const verdict = await harness.host.runHooks({ event: 'preToolUse', toolName: 'forbidden_tool', scope })
    assert.equal(verdict.decision, 'deny')
    assert.match(String((verdict as { reason?: string }).reason), /good plugin says no/)
  } finally {
    await cleanup(harness)
  }
})

test('a plugin whose manifest changed after it was agreed to does not start', async () => {
  const first = await start(['good'])
  const { dir, store } = first
  await first.host.dispose()
  const manifest = join(store, 'good', 'harnessdesk.plugin.json')
  const widened = JSON.parse(await readFile(manifest, 'utf8')) as Record<string, unknown>
  widened['permissions'] = { shell: true }
  await writeFile(manifest, JSON.stringify(widened, null, 2))

  const second = await make(dir, 'restart after manifest change')
  try {
    const good = second.host.plugins().find((plugin) => plugin.identity.id === 'good')
    assert.ok(good, 'the plugin is still listed, so the person can see why it stopped')
    assert.equal(good.state.type, 'failed')
    assert.match(JSON.stringify(good.state), /changed/i)
    assert.equal(second.host.list('tool').some((entry) => entry.name === 'ping'), false, 'nothing it registers is reachable')
    const stats = await second.host.stats()
    assert.equal((stats.processes ?? []).some((entry) => entry.plugin === 'good'), false, 'no process was started for it')
  } finally {
    await cleanup(second)
  }
})

test('a disabled plugin has no process, and enabling it starts one', async () => {
  const harness = await start(['good', 'envspy'])
  try {
    await harness.host.setEnabled('envspy', false)
    let stats = await harness.host.stats()
    assert.deepEqual((stats.processes ?? []).map((entry) => entry.plugin), ['good'])
    assert.equal(harness.host.list('tool').some((entry) => entry.name === 'spy'), false)
    const listed = harness.host.plugins().find((plugin) => plugin.identity.id === 'envspy')
    assert.ok(listed, 'a disabled plugin is still listed')
    assert.equal(listed.enabled, false)

    await harness.host.setEnabled('envspy', true)
    stats = await harness.host.stats()
    assert.deepEqual((stats.processes ?? []).map((entry) => entry.plugin).sort(), ['envspy', 'good'])
    assert.equal((await spy(harness)).secret, null)
  } finally {
    await cleanup(harness)
  }
})

test('a plugin\'s config is given back to its process after a restart', async () => {
  const harness = await start(['envspy'])
  try {
    await harness.host.reconfigure('envspy', { greeting: 'hello' })
    const before = await spy(harness)
    assert.equal(before.greeting, 'hello')

    const died = await harness.host.invokeTool(harness.toolId('spy_exit'), {}, scope)
    assert.equal(died.ok, false)
    await until(() => harness.host.plugins().some((plugin) => plugin.identity.id === 'envspy' && plugin.state.type === 'active'))
    await until(() => harness.host.list('tool').some((entry) => entry.name === 'spy'))

    const after = await spy(harness)
    assert.notEqual(after.pid, before.pid, 'a new process')
    assert.equal(after.greeting, 'hello', 'with the config it had')
  } finally {
    await cleanup(harness)
  }
})

test('a plugin turned off while it is starting stays off, and two starts leave one process', async () => {
  const harness = await start(['envspy'])
  try {
    await harness.host.setEnabled('envspy', false)
    await childrenGone(5000)

    // Two starts at once: one process, not two.
    await Promise.all([harness.host.setEnabled('envspy', true), harness.host.setEnabled('envspy', true)])
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(childrenUp(), 1, 'two starts leave one process')
    assert.equal((await harness.host.stats()).processes?.length, 1)

    // Off while a start is under way: it stays off, and the start's process goes.
    await harness.host.setEnabled('envspy', false)
    const starting = harness.host.setEnabled('envspy', true)
    await harness.host.setEnabled('envspy', false)
    await starting
    await childrenGone(5000) // the overtaken start left nothing running
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(childrenUp(), 0, 'and nothing restarts it afterwards')
    const listed = harness.host.plugins().find((plugin) => plugin.identity.id === 'envspy')
    assert.equal(listed?.enabled, false)
    assert.equal(listed?.instanceId, 'envspy#installed', 'the same row as when it ran')
    assert.equal(harness.host.list('tool').some((entry) => entry.name === 'spy'), false)
  } finally {
    await cleanup(harness)
  }
})

test('turning a plugin off withdraws its contributions under the id it ran with', async () => {
  const harness = await start(['envspy'])
  const events = listen(harness.host)
  try {
    const running = harness.host.plugins().find((plugin) => plugin.identity.id === 'envspy')
    assert.equal(running?.instanceId, 'envspy#installed')
    await harness.host.setEnabled('envspy', false)
    const withdrawn = events.heard.find((event) => event.type === 'contributions/changed' && event.owner === 'envspy#installed')
    assert.ok(withdrawn, 'the renderer is told its contributions are gone')
    assert.deepEqual((withdrawn as unknown as { contributions: unknown[] }).contributions, [])
    const updated = events.heard.filter((event) => event.type === 'plugin/updated')
    assert.equal((updated.at(-1) as { plugin: { instanceId: string } }).plugin.instanceId, 'envspy#installed',
      'the row it is shown in keeps its key, so it is replaced rather than duplicated')
  } finally {
    events.stop()
    await cleanup(harness)
  }
})

test('installing a plugin that is running replaces its process', async () => {
  const harness = await start(['envspy'])
  try {
    const before = await spy(harness)
    const id = await harness.host.installPlugin(join(FIXTURES, 'plugin-envspy'))
    assert.equal(id, 'envspy')
    const processes = (await harness.host.stats()).processes ?? []
    assert.equal(processes.filter((entry) => entry.plugin === 'envspy').length, 1, 'one process for it, not two')
    const after = await spy(harness)
    assert.notEqual(after.pid, before.pid, 'the new version runs in a new process')
    assert.equal(harness.host.plugins().filter((plugin) => plugin.identity.id === 'envspy').length, 1)
  } finally {
    await cleanup(harness)
  }
})

test('a consent record that cannot be read stops plugins rather than trusting what is on disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-perplugin-'))
  await cp(join(FIXTURES, 'plugin-good'), join(dir, 'plugins', 'good'), { recursive: true })
  // A directory where the record should be: unreadable as a file.
  await mkdir(join(dir, 'plugin-consent.json'))
  const harness = await make(dir, 'unreadable consent record')
  try {
    const good = harness.host.plugins().find((plugin) => plugin.identity.id === 'good')
    assert.equal(good?.state.type, 'failed')
    assert.match(JSON.stringify(good?.state), /consent record/)
    assert.equal(harness.host.list('tool').some((entry) => entry.name === 'ping'), false)
  } finally {
    await cleanup(harness)
  }
})

test('a plugin that rewrites its manifest and restarts does not come back', async () => {
  const harness = await start(['envspy'])
  try {
    await spy(harness)
    const manifest = join(harness.store, 'envspy', 'harnessdesk.plugin.json')
    const widened = JSON.parse(await readFile(manifest, 'utf8')) as Record<string, unknown>
    widened['permissions'] = { shell: true }
    await writeFile(manifest, JSON.stringify(widened, null, 2))

    const died = await harness.host.invokeTool(harness.toolId('spy_exit'), {}, scope)
    assert.equal(died.ok, false)
    const again = await harness.host.invokeTool(harness.toolId('spy'), {}, scope)
    assert.equal(again.ok, false, 'its tools stay unavailable')
    assert.match(JSON.stringify(again), /manifest has changed/)
    const listed = harness.host.plugins().find((plugin) => plugin.identity.id === 'envspy')
    assert.equal(listed?.state.type, 'failed')
    assert.match(JSON.stringify(listed?.state), /manifest has changed/)
  } finally {
    await cleanup(harness)
  }
})
