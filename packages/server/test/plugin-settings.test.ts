import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { ExtensionKernel } from '@harnessdesk/cordis-host'
import { builtinPlugins } from '@harnessdesk/plugins'
import type { HostMethodName, HostToClient, PluginInstance } from '@harnessdesk/protocol'
import WebSocket from 'ws'

import { Host, Logger, StateStore, serve, type RunningServer } from '../src/index.js'

/**
 * A setting a person typed into Settings is still there tomorrow.
 *
 * The kernel keeps a plugin's configuration in memory only, so preferences
 * are the record. What made this worth a file of its own is *when* the record
 * is read back: `StateStore` holds `{}` until `load()` has resolved, so a
 * restore that ran in the host's constructor read an empty object and kept
 * the defaults — which is why the team engine's `hold` came back as `accept`
 * however carefully it had been stored (#258).
 *
 * So the restart here is a real one: a new kernel that knows nothing, a new
 * host, the same state directory, and the plugins loaded *before* `start()`,
 * which is the order both `bin.ts` and the desktop shell boot in.
 */

const silent = new Logger('test', { level: 'error', console: false })
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

/** A desk booted the way the app boots one: plugins first, then `start()`. */
const boot = async (stateDir: string, workspace: string) => {
  const extensions = new ExtensionKernel()
  const placements: unknown[] = []
  const setBrowserSettings = extensions.setBrowserSettings.bind(extensions)
  extensions.setBrowserSettings = (settings) => {
    placements.push(settings)
    setBrowserSettings(settings)
  }
  const host = new Host({
    logger: silent,
    state: new StateStore(join(stateDir, 'state.json')),
    extensions,
    catalogRefreshMs: 0,
  })
  for (const plugin of builtinPlugins) await extensions.load(plugin)
  await host.start()
  extensions.setWorkspace({ root: workspace, branch: null })
  await settle()
  const server = await serve({ host, logger: silent, port: 0 })
  return {
    extensions,
    host,
    server,
    placements,
    close: async () => {
      await server.close()
      await host.dispose()
      await extensions.dispose()
    },
  }
}

const configOf = (listed: unknown, id: string): Record<string, unknown> =>
  ((listed as PluginInstance[]).find((plugin) => plugin.identity.id === id)?.config ??
    {}) as Record<string, unknown>

const dirs = async (t: { after: (fn: () => unknown) => void }) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'hd-plugin-settings-'))
  const workspace = await mkdtemp(join(tmpdir(), 'hd-plugin-ws-'))
  t.after(() => rm(stateDir, { recursive: true, force: true }))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  await writeFile(join(workspace, 'big.txt'), 'a'.repeat(5_000))
  return { stateDir, workspace }
}

test('a plugin keeps the settings it was given, across a restart and in force', async (t) => {
  const { stateDir, workspace } = await dirs(t)

  const first = await boot(stateDir, workspace)
  const client = await Client.connect(first.server)
  await client.call('plugin/configure', { pluginId: 'files', config: { maxBytes: 2_000 } })
  await client.call('plugin/configure', { pluginId: 'search', config: { maxResults: 7 } })
  await settle()

  // The control. This holds whether or not anything is ever persisted, so a
  // failure below is about the restart and not about `plugin/configure`
  // having quietly stopped working.
  assert.equal(configOf(await client.call('plugin/list', {}), 'files')['maxBytes'], 2_000)
  client.close()
  await first.close()

  const second = await boot(stateDir, workspace)
  t.after(() => second.close())
  const again = await Client.connect(second.server)
  t.after(() => again.close())

  const listed = await again.call('plugin/list', {})
  assert.equal(configOf(listed, 'files')['maxBytes'], 2_000, 'the read limit came back')
  assert.equal(configOf(listed, 'search')['maxResults'], 7, 'and it is not only the files plugin')

  // Listed is not the same as enforced: the settings page could show 2,000
  // over a plugin still truncating at 64,000. Read a 5,000-byte file and see.
  const tool = second.extensions.list('tool').find((entry) => entry.name === 'read_file')
  assert.ok(tool, 'the files plugin registered its tool')
  const result = await second.extensions.invokeTool(tool.id, { path: 'big.txt' }, {})
  const text = result.ok && result.content[0]?.type === 'text' ? result.content[0].text : ''
  assert.match(text, /\[truncated at 2000 bytes\]/, 'the stored limit is the one in force')
})

test('a board left holding inbound messages is still holding after a restart', async (t) => {
  const { stateDir, workspace } = await dirs(t)

  const first = await boot(stateDir, workspace)
  const client = await Client.connect(first.server)
  await client.call('plugin/configure', {
    pluginId: 'team',
    config: { rateLimit: 42, inboundDefault: 'hold' },
  })
  await settle()
  // The control: the engine took the change while the process was up.
  assert.equal(first.host.teamPlane.settings().inboundDefault, 'hold')
  client.close()
  await first.close()

  const second = await boot(stateDir, workspace)
  t.after(() => second.close())
  // The one that matters. A restart that downgrades this to `accept` lets
  // through exactly what the person set it to stop.
  assert.equal(second.host.teamPlane.settings().inboundDefault, 'hold', 'still holding')
  assert.equal(second.host.teamPlane.settings().rateLimit, 42)
})

test('where an agent opens a page is restored from the file, not from an empty object', async (t) => {
  const { stateDir, workspace } = await dirs(t)

  const first = await boot(stateDir, workspace)
  const client = await Client.connect(first.server)
  await client.call('app/state/set', { patch: { browserPrefs: { placement: 'window' } } })
  await settle()
  // The control: the kernel is told at least once while the process is up.
  assert.ok(first.placements.length > 0, 'the kernel was told where pages open')
  client.close()
  await first.close()

  const second = await boot(stateDir, workspace)
  t.after(() => second.close())
  const last = second.placements.at(-1) as { placement?: string } | undefined
  assert.equal(last?.placement, 'window', 'the stored placement, not the default')
})
