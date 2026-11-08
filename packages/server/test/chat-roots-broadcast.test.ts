import assert from 'node:assert/strict'
import { realpath } from 'node:fs/promises'
import test from 'node:test'
import { Client, silent, start, stop } from './fixtures/harness.js'

test('two connected clients receive newly allocated chat roots', async () => {
  const rig = await start()
  const a = await Client.connect(rig.server), b = await Client.connect(rig.server)
  try {
    await Promise.all([a.call('app/state/get', {}), b.call('app/state/get', {})])
    const session = await a.call('session/create', { runtime: 'fake', options: {} }) as { cwd: string }
    // A request on B drains messages sent before its response, without a timer.
    await b.call('app/state/get', {})
    const roots = [...new Set([session.cwd, await realpath(session.cwd)])]
    for (const client of [a, b]) {
      const event = client.notifications.find(message => 'method' in message && message.method === ('chats/rootsChanged' as string)) as { params?: { roots?: string[] } } | undefined
      assert.deepEqual(event?.params?.roots, roots)
    }
  } finally { a.close(); b.close(); await stop(rig) }
})

test('concurrent allocations publish union and backup import replaces it', async () => {
  const rig = await start()
  const a = await Client.connect(rig.server), b = await Client.connect(rig.server)
  try {
    const sessions = await Promise.all([a, b].map(client => client.call('session/create', { runtime: 'fake', options: {} }))) as { cwd: string }[]
    const roots = [...new Set((await Promise.all(sessions.map(async session => [session.cwd, await realpath(session.cwd)]))).flat())]
    const preferences = await a.call('app/state/get', {}) as { chatsFolderRootsSnapshot: { roots: string[]; revision: number } }
    assert.deepEqual(new Set(preferences.chatsFolderRootsSnapshot.roots), new Set(roots))
    const backup = await a.call('backup/export', {}) as { preferences: Record<string, unknown> }
    await a.call('backup/import', { backup: { ...backup, preferences: { managedChatFolders: ['/restored', '/restored'] } } })
    const replaced = await b.call('app/state/get', {}) as { chatsFolderRootsSnapshot: { roots: string[]; revision: number } }
    assert.deepEqual(replaced.chatsFolderRootsSnapshot.roots, ['/restored'])
    assert.ok(replaced.chatsFolderRootsSnapshot.revision > preferences.chatsFolderRootsSnapshot.revision)
    const events = b.notifications.filter(message => 'method' in message && message.method === 'chats/rootsChanged')
    assert.deepEqual((events.at(-1) as { params: { roots: readonly string[] } }).params.roots, ['/restored'])
  } finally { a.close(); b.close(); await stop(rig) }
})

test('failed persistence still broadcasts in-memory ownership and observer failure is isolated', async () => {
  const { mkdir, rename, rm } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { StateStore } = await import('../src/state.js')
  const { tempDir } = await import('./scratch.js')
  const root = tempDir('hd-roots-failure-'), file = join(root, 'state.json')
  const state = new StateStore(file)
  const rig = await start({ state }, root)
  const a = await Client.connect(rig.server), b = await Client.connect(rig.server)
  const off = state.onChatRootsChanged(() => { throw new Error('observer failed') })
  try {
    await rename(file, `${file}.saved`)
    await mkdir(file)
    await assert.rejects(a.call('session/create', { runtime: 'fake', options: {} }))
    const preferences = await b.call('app/state/get', {}) as { chatsFolderRootsSnapshot: { roots: string[] } }
    assert.equal(preferences.chatsFolderRootsSnapshot.roots.length > 0, true)
    const events = b.notifications.filter(message => 'method' in message && message.method === 'chats/rootsChanged')
    assert.deepEqual((events.at(-1) as { params: { roots: readonly string[] } }).params.roots, preferences.chatsFolderRootsSnapshot.roots)
  } finally {
    off(); a.close(); b.close()
    await rm(file, { recursive: true, force: true })
    await rename(`${file}.saved`, file)
    await stop(rig)
  }
})

test('host unsubscribes from root changes when disposed', async () => {
  const { StateStore } = await import('../src/state.js')
  const { Host } = await import('../src/host.js')
  const { tempDir } = await import('./scratch.js')
  const { join } = await import('node:path')
  const state = new StateStore(join(tempDir('hd-roots-dispose-'), 'state.json'))
  const host = new Host({ state, logger: silent })
  let events = 0
  host.addBroadcaster(event => { if (event.method === 'chats/rootsChanged') events++ })
  await state.load()
  await state.setPreferences({ managedChatFolders: ['/first'] })
  assert.equal(events, 1)
  await state.setPreferences({ managedChatFolders: ['/first', '/first'] })
  assert.equal(events, 1, 'duplicate aliases do not publish a change')
  await host.dispose()
  await state.setPreferences({ managedChatFolders: ['/second'] })
  assert.equal(events, 1)
})
