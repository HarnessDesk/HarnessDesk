import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { ExtensionKernel } from '@harnessdesk/cordis-host'
import { SupervisedExtensionHost } from '../src/index.js'

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
