import assert from 'node:assert/strict'
import { mkdir, readdir, realpath, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { parseClientMessage, runtimeId, sessionId, type AgentRuntime } from '@harnessdesk/protocol'
import { dispatch, type HostContext } from '../src/methods/index.js'
import { StateStore } from '../src/state.js'
import { tempDir } from './scratch.js'

const setup = async () => {
  const root = tempDir('hd-chats-')
  const state = new StateStore(join(root, 'state.json'))
  await state.load()
  const created: string[] = []
  const runtime = {
    info: { id: runtimeId('fake'), capabilities: {} },
    createSession: async (options: { cwd: string }) => {
      created.push(options.cwd)
      return { id: sessionId(String(created.length)) }
    },
  } as unknown as AgentRuntime
  const ctx = {
    state,
    runtimes: { resolve: () => runtime, ensureStarted: async () => {} },
    laneEnvironment: { forCheckout: () => undefined },
    sessions: { attach: async (_runtime: unknown, id: string) => ({ id, runtime: runtime.info.id, cwd: created[Number(id) - 1] }) },
  } as unknown as HostContext
  Object.assign(ctx, { workspaces: {
    open: async (path: string) => { await state.touchWorkspace({ path, name: path, lastOpenedAt: Date.now() }); return { path } },
    gitStatus: async () => null, repoOf: async () => null, topLevel: async () => null, realPath: async (path: string) => path,
  } as unknown as HostContext['workspaces'] })
  return { root, state, ctx, created, runtime }
}

test('folderless creation allocates distinct dated directories inside the default chats folder', async () => {
  const { root, ctx, created } = await setup()
  assert.doesNotThrow(() => parseClientMessage({ id: 1, method: 'session/create', params: { runtime: 'fake', options: {} } }))
  await dispatch(ctx, 'session/create', { runtime: runtimeId('fake'), options: {} } as never)
  await dispatch(ctx, 'session/create', { runtime: runtimeId('fake'), options: {} } as never)
  assert.equal(created.length, 2)
  assert.notEqual(created[0], created[1])
  for (const cwd of created) {
    assert.equal(dirname(cwd), join(root, 'chats'))
    assert.match(cwd, /\d{4}-\d{2}-\d{2}-[a-zA-Z0-9]+$/)
    assert.equal((await stat(cwd)).isDirectory(), true)
  }
})

test('changing and resetting chats folder persists across restart and leaves existing folders alone', async () => {
  const { root, state, ctx, created } = await setup()
  const custom = join(root, 'custom')
  await dispatch(ctx, 'app/state/set', { patch: { chatsFolder: custom } })
  await dispatch(ctx, 'session/create', { runtime: runtimeId('fake'), options: {} } as never)
  const existing = created[0]!
  const restarted = new StateStore(join(root, 'state.json'))
  await restarted.load()
  assert.equal(restarted.state.preferences['chatsFolder'], custom)
  const nextCtx = { ...ctx, state: restarted }
  await dispatch(nextCtx, 'app/state/set', { patch: { chatsFolder: null } })
  await dispatch(nextCtx, 'session/create', { runtime: runtimeId('fake'), options: {} } as never)
  const reset = new StateStore(join(root, 'state.json'))
  await reset.load()
  assert.equal(reset.state.preferences['chatsFolder'], null)
  assert.equal(dirname(created[1]!), join(root, 'chats'))
  assert.equal(dirname(existing), custom)
  assert.equal((await stat(existing)).isDirectory(), true)
  const preferences = await dispatch(nextCtx, 'app/state/get', {})
  assert.ok((preferences['chatsFolderRoots'] as string[]).includes(existing))
  assert.ok(!(preferences['chatsFolderRoots'] as string[]).includes(custom))
  assert.equal(state.state.workspaces.length, 0)
})

test('51 folderless chats retain the project and only the latest managed workspace in recents', async () => {
  const { root, ctx, created } = await setup()
  const project = join(root, 'project')
  await dispatch(ctx, 'workspace/open', { path: project })
  for (let i = 0; i < 51; i++) {
    await dispatch(ctx, 'session/create', { runtime: runtimeId('fake'), options: {} } as never)
    await dispatch(ctx, 'workspace/open', { path: created.at(-1)! })
  }
  const recent = await dispatch(ctx, 'workspace/recent', {})
  assert.deepEqual(recent.map(one => one.path), [created.at(-1), project])
})

test('only folders allocated by the host become chat roots, including after a restart', async () => {
  const { root, ctx, created } = await setup()
  const folder = join(root, 'chosen')
  await mkdir(join(folder, '2026-10-16-ABC123'), { recursive: true })
  await dispatch(ctx, 'app/state/set', { patch: { chatsFolder: folder } })
  assert.deepEqual((await dispatch(ctx, 'app/state/get', {}))['chatsFolderRoots'], [])
  await dispatch(ctx, 'session/create', { runtime: runtimeId('fake'), options: {} } as never)
  const restarted = new StateStore(join(root, 'state.json'))
  await restarted.load()
  assert.deepEqual((await dispatch({ ...ctx, state: restarted }, 'app/state/get', {}))['chatsFolderRoots'], [...new Set([created[0]!, await realpath(created[0]!)])])
  await assert.rejects(dispatch(ctx, 'app/state/set', { patch: { managedChatFolders: [folder] } }), /maintained by the host/)
})

test('refuses chats locations containing known projects, including aliases, without changing the setting', async () => {
  const { root, state, ctx } = await setup()
  const project = join(root, 'code', 'project')
  await mkdir(project, { recursive: true })
  await state.touchWorkspace({ path: project, realPath: project, name: 'project', lastOpenedAt: 1 })
  const alias = join(root, 'alias')
  await symlink(join(root, 'code'), alias)
  for (const path of [project, join(root, 'code'), alias]) {
    await assert.rejects(dispatch(ctx, 'app/state/set', { patch: { chatsFolder: path } }), /opened project/)
    assert.equal(state.state.preferences['chatsFolder'], undefined)
  }
})

for (const stage of ['start', 'create'] as const) test(`removes its empty allocation when ${stage} fails, retaining explicit folders and written files`, async () => {
  const { root, ctx, runtime } = await setup()
  const fail = async () => { throw new Error('Start refused') }
  if (stage === 'start') ctx.runtimes.ensureStarted = fail
  else runtime.createSession = fail
  await assert.rejects(dispatch(ctx, 'session/create', { runtime: runtimeId('fake'), options: {} } as never), /Start refused/)
  assert.deepEqual(await readdir(join(root, 'chats')), [])
  const explicit = join(root, 'project')
  await mkdir(explicit)
  await assert.rejects(dispatch(ctx, 'session/create', { runtime: runtimeId('fake'), options: { cwd: explicit } } as never), /Start refused/)
  assert.equal((await stat(explicit)).isDirectory(), true)
  ctx.runtimes.ensureStarted = async () => {}
  runtime.createSession = async options => { await writeFile(join(options.cwd, 'keep.txt'), 'Keep this work'); throw new Error('Start refused') }
  await assert.rejects(dispatch(ctx, 'session/create', { runtime: runtimeId('fake'), options: {} } as never), /Start refused/)
  const [kept] = await readdir(join(root, 'chats'))
  assert.equal((await stat(join(root, 'chats', kept!, 'keep.txt'))).isFile(), true)
})

test('host refuses relative chats roots and relative conversation paths before creating anything', async () => {
  const { ctx, created } = await setup()
  await assert.rejects(dispatch(ctx, 'app/state/set', { patch: { chatsFolder: '../outside' } }), /absolute/)
  await assert.rejects(dispatch(ctx, 'session/create', { runtime: runtimeId('fake'), options: { cwd: '../outside' } }), /absolute/)
  assert.deepEqual(created, [])
})

test('validating chat preferences preserves concurrent inbox additions', async () => {
  const { ctx, state } = await setup()
  const first = { id: 'first', title: 'First task', tone: 'info', at: 1, read: false }
  const second = { ...first, id: 'second', title: 'Second task' }
  await Promise.all([first, second].map(entry => dispatch(ctx, 'app/state/set', {
    patch: { inbox: [entry] }, noticeBase: { inbox: [] },
  })))
  assert.deepEqual(new Set((state.state.preferences['inbox'] as { id: string }[]).map(one => one.id)), new Set(['first', 'second']))
})
