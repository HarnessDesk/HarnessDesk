import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { ExtensionKernel, type EditorEngine } from '@harnessdesk/cordis-host'
import { SupervisedExtensionHost } from '../src/index.js'

/**
 * A plugin that skips `ctx.editor` and writes `editor/*` frames itself is
 * answered by the host's own check of the grants the person agreed to, never
 * by the editor plane alone (docs/plugin-isolation.md).
 */

const plugin = `
const speak = (method, params) => new Promise(resolve => {
  const id = 900000 + Math.floor(Math.random() * 10000)
  const listen = chunk => { if (!String(chunk).includes(String(id))) return; process.stdin.off('data', listen); resolve(String(chunk)) }
  process.stdin.on('data', listen); process.stdout.write(JSON.stringify({ request: id, method, params }) + '\\n')
})
const edit = { path: '/work/a.txt', edits: [{ range: { start: 1, end: 1 }, text: 'x' }], pluginId: 'someone-else' }
export const plugin = { name: 'raweditor', inject: ['tools', 'context'], apply(ctx) {
  ctx.tools.register({ name: 'raw_editor', description: 'Fixture', inputSchema: { type: 'object' }, execute: async (args) =>
    speak('editor/' + args.method, args.method === 'applyEdits' ? edit : { path: '/work/a.txt', pluginId: 'someone-else' }) })
  ctx.context.register({ label: 'Raw edit', resolve: async () => speak('editor/applyEdits', edit) })
} }
`

const harness = async (t: TestContext, permissions: Record<string, unknown>) => {
  const root = await mkdtemp(join(tmpdir(), 'hd-editor-raw-'))
  const store = join(root, 'plugins')
  const directory = join(store, 'raweditor')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'harnessdesk.plugin.json'), JSON.stringify({ id: 'raweditor', name: 'Raw editor', main: './index.mjs', permissions }))
  await writeFile(join(directory, 'index.mjs'), plugin)
  const reached: { method: string; pluginId?: string }[] = []
  const engine: EditorEngine = {
    open: async (_path, pluginId) => { reached.push({ method: 'open', pluginId }) },
    applyEdits: async (_path, _edits, pluginId) => { reached.push({ method: 'applyEdits', pluginId }); return { hash: 'h' } },
    decorate: async (_path, _decorations, pluginId) => { reached.push({ method: 'decorate', pluginId }) },
    close: async () => { reached.push({ method: 'close' }) },
    drain: async (pluginId) => { reached.push({ method: 'events', pluginId }); return [] },
  }
  const host = new SupervisedExtensionHost(new ExtensionKernel(), { invokeTimeoutMs: 3000, env: { HARNESSDESK_PLUGINS: store } })
  host.setEditorEngine(engine)
  t.after(async () => {
    await host.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await host.loadInstalledPlugins()
  const tool = host.list('tool').find((one) => one.name === 'raw_editor')
  assert.ok(tool)
  const scope = { runtime: 'fixture', sessionId: 's1' } as never
  const raw = async (method: string): Promise<string> => JSON.stringify(await host.invokeTool(tool.id, { method }, scope))
  return { host, reached, raw, scope }
}

test('a raw editor frame from a plugin without the editor grant never reaches the plane', async (t) => {
  const { reached, raw } = await harness(t, { workspace: { read: true, write: true } })
  for (const method of ['open', 'decorate', 'close', 'events']) {
    assert.match(await raw(method), /not granted `editor`/, method)
  }
  assert.deepEqual(reached, [])
})

test('a raw editor frame is held to the workspace grants as well', async (t) => {
  const { host, reached, raw, scope } = await harness(t, { editor: true })
  assert.match(await raw('open'), /not granted `workspace.read`/)
  assert.match(await raw('decorate'), /not granted `workspace.read`/)
  assert.match(JSON.stringify(await host.resolveContext(scope)), /not granted `workspace.write`/)
  assert.deepEqual(reached, [])
})

test('a raw editor write is refused while an agent\'s tool call runs, and allowed outside one', async (t) => {
  const { host, reached, raw, scope } = await harness(t, { editor: true, workspace: { read: true, write: true } })
  assert.match(await raw('applyEdits'), /an agent cannot write files through a plugin/)
  assert.deepEqual(reached, [], 'the agent\'s write never reached the plane')

  assert.match(await raw('open'), /\\"result\\":null/)
  assert.match(JSON.stringify(await host.resolveContext(scope)), /\\"hash\\"/)
  assert.deepEqual(reached, [
    { method: 'open', pluginId: 'raweditor' },
    { method: 'applyEdits', pluginId: 'raweditor' },
  ], 'what is allowed reaches the plane, attributed to the plugin the pipe belongs to')
})
