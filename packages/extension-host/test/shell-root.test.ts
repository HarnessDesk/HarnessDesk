import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { ExtensionKernel } from '@harnessdesk/cordis-host'
import { SupervisedExtensionHost } from '../src/index.js'

for (const entry of ['tool', 'chip', 'automatic'] as const) {
  test(`installed workspace-scoped ${entry} matches an opened alias after parent admission`, async (t) => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'hd-child-alias-')))
    const project = join(base, 'project')
    const alias = join(base, 'alias')
    const other = join(base, 'other')
    const store = join(base, 'plugins')
    const plugin = join(store, 'aliased')
    await Promise.all([mkdir(project), mkdir(other), mkdir(plugin, { recursive: true })])
    await symlink(project, alias)
    await writeFile(join(plugin, 'harnessdesk.plugin.json'), JSON.stringify({
      id: 'aliased', name: 'Aliased', version: '1.0.0', main: './index.js', permissions: { shell: true, workspace: { read: true } },
    }))
    await writeFile(join(plugin, 'index.js'), `export const plugin = {
      name: 'aliased', inject: ['tools', 'context', 'workspace', 'shell'], apply(ctx) {
        const scope = { kind: 'workspace', root: ${JSON.stringify(alias)} }
        const where = async (query) => query.workspaceRoot + '\\n' +
          (await ctx.shell.run(${JSON.stringify(process.execPath)}, ['-e', 'process.stdout.write(process.cwd())'])).stdout
        ctx.tools.register({ name: 'where', description: '', inputSchema: {}, scope, execute: (_, query) => where(query) })
        ctx.context.register({ label: 'Chip', chip: { description: 'Fixture context' }, scope, resolve: where })
        ctx.context.register({ label: 'Automatic', scope, resolve: where })
      }
    }`)
    const host = new SupervisedExtensionHost(new ExtensionKernel(), { env: { HARNESSDESK_PLUGINS: store } })
    t.after(async () => { await host.dispose(); await rm(base, { recursive: true, force: true }) })
    host.setWorkspace({ root: alias, branch: null })
    let admitted = project
    host.setShellWorkspaceResolver(async () => admitted)
    await host.loadInstalledPlugins()
    const query = { workspaceRoot: alias }
    const tool = host.list('tool', query)[0]!
    const chip = host.list('context', query).find((one) => one.chip)!
    assert.ok(tool, 'listed for the opened spelling')
    assert.ok(chip, 'the chip is listed for the opened spelling')
    const expected = project + '\n' + project
    const resolve = async (scope = query) => {
      if (entry === 'tool') return host.invokeTool(tool.id, {}, scope)
      if (entry === 'chip') return host.resolveOne(chip.id, undefined, scope)
      return host.resolveContext(scope)
    }
    const answer = entry === 'tool' ? { ok: true, content: [{ type: 'text', text: expected }] }
      : entry === 'chip' ? { label: 'Chip', text: expected } : [{ label: 'Automatic', text: expected }]
    assert.deepEqual(await resolve(), answer)
    assert.deepEqual(await resolve({ workspaceRoot: other }), answer, 'parent admission ignores caller hints')
    assert.deepEqual(tool.scope, { kind: 'workspace', root: project })
    assert.deepEqual(host.list('tool', { workspaceRoot: project }), [tool])
    assert.deepEqual(host.list('tool', { workspaceRoot: other }), [])
    admitted = other
    await rm(alias)
    await symlink(other, alias)
    const refused = entry === 'tool' ? { ok: false, error: 'That tool is not available in this scope.' } : entry === 'chip' ? null : []
    assert.deepEqual(await resolve(), refused)
    assert.deepEqual(host.list('tool', query), [], 'retargeting an alias cannot move a registered scope')
  })
}

for (const entry of ['tool', 'chip', 'automatic'] as const) {
  test(`an installed plugin's ${entry} shell root is resolved by the parent host`, async (t) => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'hd-child-shell-')))
    const project = join(base, 'project')
    const other = join(base, 'other')
    const store = join(base, 'plugins')
    const plugin = join(store, 'where')
    await Promise.all([mkdir(project), mkdir(other), mkdir(plugin, { recursive: true })])
    await writeFile(join(plugin, 'harnessdesk.plugin.json'), JSON.stringify({
      id: 'where', name: 'Where', version: '1.0.0', main: './index.js', permissions: { shell: true, workspace: { read: true } },
    }))
    await writeFile(join(plugin, 'index.js'), `export const plugin = {
      name: 'where', inject: ['tools', 'shell', 'context'],
      apply(ctx) {
        const where = async () => (await ctx.shell.run(${JSON.stringify(process.execPath)}, ['-e', 'process.stdout.write(process.cwd())'])).stdout
        ctx.tools.register({ name: 'where', description: '', inputSchema: { type: 'object' }, execute: where })
        ctx.context.register({ label: 'Where', chip: { description: 'Fixture context' }, resolve: where })
        ctx.context.register({ label: 'Automatic location', resolve: where })
      },
    }`)
    const host = new SupervisedExtensionHost(new ExtensionKernel(), { env: { HARNESSDESK_PLUGINS: store } })
    t.after(async () => { await host.dispose(); await rm(base, { recursive: true, force: true }) })
    host.setWorkspace({ root: project, branch: null })
    host.setShellWorkspaceResolver(async () => project)
    await host.loadInstalledPlugins()
    const scope = { workspaceRoot: other }
    if (entry === 'tool') {
      const tool = host.list('tool')[0]!
      assert.deepEqual(await host.invokeTool(tool.id, {}, scope), { ok: true, content: [{ type: 'text', text: project }] })
    } else if (entry === 'chip') {
      const chip = host.list('context').find((one) => one.chip)!
      assert.equal((await host.resolveOne(chip.id, undefined, scope))?.text, project)
    } else {
      assert.deepEqual(await host.resolveContext(scope), [{ label: 'Automatic location', text: project }])
    }
  })
}

for (const entry of ['tool', 'chip', 'automatic'] as const) {
  test(`installed plugin ${entry} providers cannot mutate admitted scopes`, async (t) => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'hd-child-scope-')))
    const project = join(base, 'project')
    const other = join(base, 'other')
    const store = join(base, 'plugins')
    const plugin = join(store, 'mutator')
    await Promise.all([mkdir(project), mkdir(other), mkdir(plugin, { recursive: true })])
    await writeFile(join(plugin, 'harnessdesk.plugin.json'), JSON.stringify({ id: 'mutator', name: 'Mutator', version: '1.0.0', main: './index.js', permissions: { shell: true, workspace: { read: true } } }))
    await writeFile(join(plugin, 'index.js'), `export const plugin = {
      name: 'mutator', inject: ['tools', 'shell', 'context'], apply(ctx) {
        const mutate = (scope) => {
          try { scope.workspaceRoot = ${JSON.stringify(other)} } catch {}
          return Object.isFrozen(scope) ? 'frozen' : 'mutable'
        }
        const where = async () => (await ctx.shell.run(${JSON.stringify(process.execPath)}, ['-e', 'process.stdout.write(process.cwd())'])).stdout
        ctx.context.register({ label: 'Mutate', resolve: mutate })
        ctx.context.register({ label: 'Observe', resolve: async (scope) => scope.workspaceRoot + '\\n' + await where() })
        ctx.context.register({ label: 'Chip', chip: { description: 'Fixture context' }, resolve: async (scope) => mutate(scope) + '\\n' + await where() })
        ctx.tools.register({ name: 'mutate', description: '', inputSchema: { type: 'object' }, execute: async (_, scope) => mutate(scope) + '\\n' + await where() })
      }
    }`)
    const host = new SupervisedExtensionHost(new ExtensionKernel(), { env: { HARNESSDESK_PLUGINS: store } })
    t.after(async () => { await host.dispose(); await rm(base, { recursive: true, force: true }) })
    host.setWorkspace({ root: project, branch: null })
    host.setShellWorkspaceResolver(async () => project)
    await host.loadInstalledPlugins()
    if (entry === 'automatic') {
      assert.deepEqual(await host.resolveContext({ workspaceRoot: other }), [{ label: 'Mutate', text: 'frozen' }, { label: 'Observe', text: project + '\n' + project }])
    } else if (entry === 'chip') {
      assert.equal((await host.resolveOne(host.list('context').find((one) => one.chip)!.id, undefined, {}))?.text, 'frozen\n' + project)
    } else {
      assert.deepEqual(await host.invokeTool(host.list('tool')[0]!.id, {}, {}), { ok: true, content: [{ type: 'text', text: 'frozen\n' + project }] })
    }
  })
}


test('installed plugin shell refuses explicit cwd with a POSIX slash/backslash collision', { skip: process.platform === 'win32' }, async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'hd-child-shell-collision-')))
  const admitted = join(base, 'a', 'b')
  const foreign = join(base, 'a\\b')
  const store = join(base, 'plugins')
  const plugin = join(store, 'where')
  await Promise.all([mkdir(admitted, { recursive: true }), mkdir(foreign), mkdir(plugin, { recursive: true })])
  await writeFile(join(plugin, 'harnessdesk.plugin.json'), JSON.stringify({
    id: 'where', name: 'Where', version: '1.0.0', main: './index.js', permissions: { shell: true, workspace: { read: true } },
  }))
  await writeFile(join(plugin, 'index.js'), `export const plugin = {
    name: 'where', inject: ['tools', 'shell'], apply(ctx) {
      ctx.tools.register({ name: 'where', description: '', inputSchema: { type: 'object' },
        execute: async (args) => (await ctx.shell.run(${JSON.stringify(process.execPath)}, ['-e', 'process.stdout.write(process.cwd())'], args)).stdout })
    }
  }`)
  const host = new SupervisedExtensionHost(new ExtensionKernel(), { env: { HARNESSDESK_PLUGINS: store } })
  t.after(async () => { await host.dispose(); await rm(base, { recursive: true, force: true }) })
  host.setWorkspace({ root: admitted, branch: null })
  host.setShellWorkspaceResolver(async () => admitted)
  await host.loadInstalledPlugins()
  const id = host.list('tool')[0]!.id
  assert.deepEqual(await host.invokeTool(id, { cwd: admitted }, {}), { ok: true, content: [{ type: 'text', text: admitted }] })
  const refused = await host.invokeTool(id, { cwd: foreign }, {})
  assert.equal(refused.ok, false, JSON.stringify(refused))
  if (!refused.ok) assert.match(refused.error, /outside the open workspace/)
})
