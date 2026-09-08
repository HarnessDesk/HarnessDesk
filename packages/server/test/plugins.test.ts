import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { ExtensionKernel } from '@harnessdesk/cordis-host'
import type { HostMethodName, HostToClient, PluginInstance } from '@harnessdesk/protocol'
import WebSocket from 'ws'

import { Host, Logger, StateStore, serve, type RunningServer } from '../src/index.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'

/**
 * Installing a plugin over the wire, end to end.
 *
 * The fixture is a real plugin directory outside this package, so this exercises
 * the path a third-party plugin takes: inspect the manifest, see what it asks
 * for, install, load, call its tool, uninstall.
 */

const silent = new Logger('test', { level: 'error', console: false })
// Resolved from `packages/server/dist/test/` to the fixture's source directory:
// it is plain JavaScript, so the compiled copy would be identical.
const FIXTURE = fileURLToPath(
  new URL('../../../cordis-host/test/fixtures/sample-plugin', import.meta.url),
)

const settle = (ms = 80): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

class Client {
  #socket: WebSocket
  #nextId = 0
  #pending = new Map<number, (message: HostToClient) => void>()

  private constructor(socket: WebSocket) {
    this.#socket = socket
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as HostToClient
      if ('method' in message) return
      this.#pending.get(message.id)?.(message)
      this.#pending.delete(message.id)
    })
  }

  static async connect(server: RunningServer): Promise<Client> {
    const socket = new WebSocket(`${server.url.replace('http', 'ws')}/ws?token=${server.token}`)
    const client = new Client(socket)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })
    return client
  }

  call(method: HostMethodName, params: unknown): Promise<unknown> {
    const id = ++this.#nextId
    return new Promise((resolve, reject) => {
      this.#pending.set(id, (message) => {
        if ('ok' in message && message.ok) resolve(message.result)
        else if ('ok' in message) reject(new Error(message.error.message))
      })
      this.#socket.send(JSON.stringify({ id, method, params }))
    })
  }

  close(): void {
    this.#socket.close()
  }
}

const start = async (t: { after: (fn: () => unknown) => void }) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'harnessdesk-host-'))
  const pluginsDir = await mkdtemp(join(tmpdir(), 'harnessdesk-plugins-'))
  const previous = process.env['HARNESSDESK_PLUGINS']
  process.env['HARNESSDESK_PLUGINS'] = pluginsDir

  const extensions = new ExtensionKernel()
  const host = new Host({
    logger: silent,
    state: new StateStore(join(stateDir, 'state.json')),
    extensions,
  })
  host.register(new FakeRuntime())
  await host.start()
  const server = await serve({ host, logger: silent, port: 0 })

  t.after(async () => {
    await server.close()
    await host.dispose()
    await extensions.dispose()
    if (previous === undefined) delete process.env['HARNESSDESK_PLUGINS']
    else process.env['HARNESSDESK_PLUGINS'] = previous
    await rm(stateDir, { recursive: true, force: true })
    await rm(pluginsDir, { recursive: true, force: true })
  })

  return { server, extensions }
}

test('a plugin is inspected before it is installed', async (t) => {
  const { server } = await start(t)
  const client = await Client.connect(server)
  t.after(() => client.close())

  const inspected = (await client.call('plugin/inspect', { specifier: FIXTURE })) as {
    id: string
    name: string
    permissions: string[]
    alreadyInstalled: boolean
  }

  assert.equal(inspected.id, 'sample')
  assert.equal(inspected.name, 'Sample plugin')
  assert.equal(inspected.alreadyInstalled, false)
  // The consent dialog is built from this, so it has to be readable prose.
  assert.deepEqual(inspected.permissions, ['Read files in the open project'])

  // Nothing was installed by inspecting.
  assert.deepEqual(await client.call('plugin/list', {}), [])
})

test('installing loads the plugin and its tools become callable', async (t) => {
  const { server, extensions } = await start(t)
  const client = await Client.connect(server)
  t.after(() => client.close())

  const installed = (await client.call('plugin/install', { specifier: FIXTURE })) as {
    pluginId: string
  }
  assert.equal(installed.pluginId, 'sample')
  await settle()

  const plugins = (await client.call('plugin/list', {})) as PluginInstance[]
  assert.equal(plugins.length, 1)
  assert.equal(plugins[0]?.state.type, 'active')
  assert.equal(plugins[0]?.identity.source.kind, 'local')

  const tool = extensions.list('tool').find((entry) => entry.name === 'greet')
  assert.ok(tool, 'the installed plugin registered its tool')
  const result = await extensions.invokeTool(tool.id, { who: 'installer' }, {})
  assert.equal(
    result.ok && result.content[0]?.type === 'text' && result.content[0].text,
    'Hello, installer',
  )
})

test('an installed plugin is still held to its manifest', async (t) => {
  const { server, extensions } = await start(t)
  const client = await Client.connect(server)
  t.after(() => client.close())

  await client.call('plugin/install', { specifier: FIXTURE })
  await settle()
  extensions.setWorkspace({ root: '/tmp', branch: null })

  // The fixture declares workspace read, then reaches for /etc/hosts.
  const peek = extensions.list('tool').find((entry) => entry.name === 'peek_outside')
  const result = await extensions.invokeTool(peek!.id, {}, {})
  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.error : '', /outside the open workspace/)
})

test('uninstalling removes the plugin and its contributions', async (t) => {
  const { server, extensions } = await start(t)
  const client = await Client.connect(server)
  t.after(() => client.close())

  await client.call('plugin/install', { specifier: FIXTURE })
  await settle()
  assert.equal(extensions.list('tool').length > 0, true)

  await client.call('plugin/uninstall', { pluginId: 'sample' })
  await settle()

  assert.deepEqual(await client.call('plugin/list', {}), [])
  assert.equal(extensions.list('tool').length, 0, 'no ghost tools survive the uninstall')
})

test('installing the same plugin twice replaces it rather than duplicating', async (t) => {
  const { server } = await start(t)
  const client = await Client.connect(server)
  t.after(() => client.close())

  await client.call('plugin/install', { specifier: FIXTURE })
  await settle()
  await client.call('plugin/install', { specifier: FIXTURE })
  await settle()

  const plugins = (await client.call('plugin/list', {})) as PluginInstance[]
  assert.equal(plugins.length, 1, 'two live revisions of one id would be ambiguous')
})

test('a bad specifier fails with something a user can act on', async (t) => {
  const { server } = await start(t)
  const client = await Client.connect(server)
  t.after(() => client.close())

  await assert.rejects(
    () => client.call('plugin/inspect', { specifier: '/definitely/not/a/plugin' }),
    /needs one at its root/,
  )
})

/**
 * Where an agent's pages open is set in the window and obeyed in another
 * process. That crossing is the whole risk: a preference the plugin host
 * never hears is a setting that does nothing, which is worse than no
 * setting at all — so it is asserted at the boundary, in both directions.
 */
test('where pages open crosses from the window to the extension host', async (t) => {
  const seen: unknown[] = []
  const extensions = new ExtensionKernel()
  t.after(() => extensions.dispose())
  const original = extensions.setBrowserSettings.bind(extensions)
  extensions.setBrowserSettings = (settings) => {
    seen.push(settings)
    original(settings)
  }

  const stateDir = await mkdtemp(join(tmpdir(), 'harnessdesk-browser-prefs-'))
  const host = new Host({
    logger: silent,
    state: new StateStore(join(stateDir, 'state.json')),
    extensions,
  })
  host.register(new FakeRuntime())
  await host.start()
  const server = await serve({ host, logger: silent, port: 0 })
  const client = await Client.connect(server)
  t.after(async () => {
    client.close()
    await server.close()
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })

  // Once at startup, so the first tool call of the run already lands where
  // the user last said it should — not only after they touch the setting.
  // The kept profile is named by the host, inside its own state directory —
  // not `~/.harnessdesk`, whatever HARNESSDESK_HOME says.
  assert.deepEqual(seen.at(-1), { placement: 'pane', keepProfile: true, profileDir: join(stateDir, 'browser-profile') })

  await client.call('app/state/set', {
    patch: { browserPrefs: { placement: 'window', externalBinary: '/Applications/Brave', keepExternalProfile: false } },
  })
  assert.deepEqual(seen.at(-1), {
    placement: 'window',
    binary: '/Applications/Brave',
    keepProfile: false,
    profileDir: join(stateDir, 'browser-profile'),
  })

  // A preference that is not this one must not be mistaken for a change of
  // browser; it is read from the store, so nonsense reads as the default.
  await client.call('app/state/set', { patch: { browserPrefs: { placement: 'nowhere' } } })
  assert.deepEqual(seen.at(-1), { placement: 'pane', keepProfile: true, profileDir: join(stateDir, 'browser-profile') })
})

test('the browsers offered are ones that can actually be driven', async (t) => {
  const { server } = await start(t)
  const client = await Client.connect(server)
  t.after(() => client.close())

  const found = (await client.call('app/browsers', {})) as { name: string; path: string }[]
  assert.ok(Array.isArray(found))
  // Whatever this machine has, none of it may be a browser HarnessDesk
  // cannot speak DevTools Protocol to — an option that fails after you
  // choose it is worse than an option that is not there.
  for (const browser of found) {
    assert.match(browser.name, /Chrome|Chromium|Brave|Edge|Arc/)
    assert.ok(browser.path.length > 0)
  }
})
