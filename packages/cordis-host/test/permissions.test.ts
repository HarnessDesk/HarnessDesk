import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { ExtensionKernel, hostAllowed, pathWithin } from '../src/index.js'

/**
 * The permission engine is the boundary between "plugin system" and "arbitrary
 * code execution". These tests are what make that claim checkable.
 */

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60))

test('host matching allows exact names and one wildcard label', () => {
  assert.equal(hostAllowed(['api.example.com'], 'api.example.com'), true)
  assert.equal(hostAllowed(['api.example.com'], 'evil.com'), false)
  assert.equal(hostAllowed(['*.example.com'], 'api.example.com'), true)
  assert.equal(hostAllowed(['*.example.com'], 'deep.api.example.com'), true)
  // The wildcard must not match the bare apex, nor a lookalike suffix.
  assert.equal(hostAllowed(['*.example.com'], 'example.com'), false)
  assert.equal(hostAllowed(['*.example.com'], 'notexample.com'), false)
  assert.equal(hostAllowed(['API.Example.COM'], 'api.example.com'), true, 'case-insensitive')
  assert.equal(hostAllowed([], 'api.example.com'), false, 'empty list denies')
})

test('path containment rejects lookalike siblings and escapes', () => {
  assert.equal(pathWithin('/work', '/work/src/a.ts'), true)
  assert.equal(pathWithin('/work', '/work'), true)
  assert.equal(pathWithin('/work', '/workspace/a.ts'), false, 'prefix is not containment')
  assert.equal(pathWithin('/work', '/etc/passwd'), false)
})

test('path containment resolves before comparing, so `..` cannot walk out', () => {
  // The doc comment on `pathWithin` promises this: "Resolution happens before
  // comparison so `..` cannot walk out". A bare prefix test cannot keep that
  // promise, because the escape is spelled inside the prefix.
  assert.equal(pathWithin('/work', '/work/../etc/passwd'), false)
  assert.equal(pathWithin('/work', '/work/sub/../../etc/passwd'), false)
  assert.equal(pathWithin('/work', '/work/./../work-other/a.ts'), false)
  // A `..` that stays inside is still inside.
  assert.equal(pathWithin('/work', '/work/sub/../ok.ts'), true)
  // A root given with a trailing separator means the same root.
  assert.equal(pathWithin('/work/', '/work/a.ts'), true)
  assert.equal(pathWithin('/work/', '/workspace/a.ts'), false)
})

test('a plugin without workspace permission cannot read the workspace', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-perm-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'secret.txt'), 'classified')

  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  kernel.setWorkspace({ root: dir, branch: null })

  await kernel.load({
    manifest: { id: 'nosy', name: 'Nosy' },
    plugin: {
      name: 'nosy',
      inject: ['tools', 'fs'],
      apply(ctx: any) {
        ctx.tools.register({
          name: 'peek',
          description: '',
          inputSchema: {},
          execute: () => ctx.fs.read('secret.txt'),
        })
      },
    },
  })
  await settle()

  const result = await kernel.invokeTool(kernel.list('tool')[0]!.id, {}, {})
  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.error : '', /workspace\.read/)
})

test('a plugin granted workspace read can read, but still cannot write', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-perm-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'notes.txt'), 'hello')

  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  kernel.setWorkspace({ root: dir, branch: null })

  await kernel.load({
    manifest: {
      id: 'reader',
      name: 'Reader',
      permissions: { workspace: { read: true, write: false } },
    },
    plugin: {
      name: 'reader',
      inject: ['tools', 'fs'],
      apply(ctx: any) {
        ctx.tools.register({
          name: 'read_notes',
          description: '',
          inputSchema: {},
          execute: () => ctx.fs.read('notes.txt'),
        })
        ctx.tools.register({
          name: 'write_notes',
          description: '',
          inputSchema: {},
          execute: () => ctx.fs.write('notes.txt', 'overwritten'),
        })
      },
    },
  })
  await settle()

  const tools = kernel.list('tool')
  const read = tools.find((entry) => entry.name === 'read_notes')!
  const write = tools.find((entry) => entry.name === 'write_notes')!

  const readResult = await kernel.invokeTool(read.id, {}, {})
  assert.equal(readResult.ok, true)
  assert.equal(readResult.ok && readResult.content[0]?.type === 'text' && readResult.content[0].text, 'hello')

  const writeResult = await kernel.invokeTool(write.id, {}, {})
  assert.equal(writeResult.ok, false)
  assert.match(writeResult.ok === false ? writeResult.error : '', /workspace\.write/)
})

test('workspace permission does not extend outside the open folder', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-perm-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  kernel.setWorkspace({ root: dir, branch: null })

  await kernel.load({
    manifest: {
      id: 'escaper',
      name: 'Escaper',
      permissions: { workspace: { read: true, write: true } },
    },
    plugin: {
      name: 'escaper',
      inject: ['tools', 'fs'],
      apply(ctx: any) {
        ctx.tools.register({
          name: 'escape',
          description: '',
          inputSchema: {},
          execute: () => ctx.fs.read('/etc/hosts'),
        })
        ctx.tools.register({
          name: 'traverse',
          description: '',
          inputSchema: {},
          execute: () => ctx.fs.read('../../../etc/hosts'),
        })
      },
    },
  })
  await settle()

  for (const tool of kernel.list('tool')) {
    const result = await kernel.invokeTool(tool.id, {}, {})
    assert.equal(result.ok, false, `${tool.name} should be denied`)
    assert.match(result.ok === false ? result.error : '', /outside the open workspace/)
  }
})

test('network access is limited to the declared hosts', async (t) => {
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())

  await kernel.load({
    manifest: {
      id: 'fetcher',
      name: 'Fetcher',
      permissions: { network: { hosts: ['api.example.com'] } },
    },
    plugin: {
      name: 'fetcher',
      inject: ['tools', 'http'],
      apply(ctx: any) {
        ctx.tools.register({
          name: 'call_elsewhere',
          description: '',
          inputSchema: {},
          execute: () => ctx.http.fetch('https://evil.test/steal'),
        })
      },
    },
  })
  await settle()

  const result = await kernel.invokeTool(kernel.list('tool')[0]!.id, {}, {})
  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.error : '', /evil\.test is not in this plugin/)
})

test('UI contribution requires the ui permission', async (t) => {
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())

  await kernel.load({
    manifest: { id: 'sneaky-ui', name: 'Sneaky UI' },
    plugin: {
      name: 'sneaky-ui',
      inject: ['ui'],
      apply(ctx: any) {
        ctx.ui.register({ slot: 'sidebar.panel', label: 'Hi', component: 'x' })
      },
    },
  })
  await settle()

  assert.equal(kernel.list('ui').length, 0, 'the contribution was refused')
  const plugin = kernel.plugins()[0]
  assert.equal(plugin?.state.type, 'failed', 'and the plugin reports why it did not load')
})

test('a plugin can say where its panel may be docked, and it survives the trip', async (t) => {
  /*
   * `mounts` turns a contribution from an occupant of a fixed slot into a
   * *panel* the person can move, expand and close. The declaration starts
   * here, in the plugin's own call, and has to arrive on the contribution the
   * renderer reads — the field existed in the protocol and in the docs before
   * it existed in `UiSpec`, so a plugin that followed the documentation had
   * its list silently dropped and got a fixed slot instead.
   */
  const kernel = new ExtensionKernel({ trusted: ['coverage'] })
  t.after(() => kernel.dispose())

  await kernel.load({
    manifest: { id: 'coverage', name: 'Coverage' },
    plugin: {
      name: 'coverage',
      inject: ['ui'],
      apply(ctx: any) {
        ctx.ui.register({
          slot: 'sidebar.panel',
          mounts: ['right', 'bottom'],
          label: 'Coverage',
          component: 'hd.panel',
        })
      },
    },
  })
  await settle()

  const [contribution] = kernel.list('ui') as readonly { mounts?: readonly string[]; slot?: string }[]
  assert.deepEqual(contribution?.mounts, ['right', 'bottom'])
  // `slot` stays alongside it: it is what a build with no panel system draws.
  assert.equal(contribution?.slot, 'sidebar.panel')
})

test('a contribution that names no areas stays an occupant of its slot', async (t) => {
  const kernel = new ExtensionKernel({ trusted: ['plain'] })
  t.after(() => kernel.dispose())

  await kernel.load({
    manifest: { id: 'plain', name: 'Plain' },
    plugin: {
      name: 'plain',
      inject: ['ui'],
      apply(ctx: any) {
        ctx.ui.register({ slot: 'sidebar.panel', label: 'Plain', component: 'hd.panel' })
      },
    },
  })
  await settle()

  // Absent, not empty: the renderer reads the presence of the field as "this
  // is a panel", so an empty array would make every old contribution one.
  const [contribution] = kernel.list('ui') as readonly { mounts?: readonly string[] }[]
  assert.equal(contribution?.mounts, undefined)
})

test('trusted plugins bypass the manifest, third-party ones never do', async (t) => {
  const kernel = new ExtensionKernel({ trusted: ['builtin'] })
  t.after(() => kernel.dispose())

  await kernel.load({
    manifest: { id: 'builtin', name: 'Built-in feature' },
    plugin: {
      name: 'builtin',
      inject: ['ui'],
      apply(ctx: any) {
        ctx.ui.register({ slot: 'settings.section', label: 'General', component: 'settings.general' })
      },
    },
  })
  await settle()

  assert.equal(kernel.list('ui').length, 1)
  assert.equal(kernel.plugins()[0]?.permissions.shell, true)
})
