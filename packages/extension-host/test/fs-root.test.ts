import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { ExtensionKernel, type HarnessContext, type HarnessPlugin } from '@harnessdesk/cordis-host'
import type { WorkspaceAdmission } from '@harnessdesk/protocol'
import { SupervisedExtensionHost } from '../src/index.js'

for (const timing of ['live', 'replay'] as const) {
  test(`built-in and installed file tools and context receive admitted checkouts through ${timing} workspace delivery`, async (t) => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'hd-child-files-')))
    const repo = join(base, 'repo')
    const app = join(repo, 'app')
    const other = join(base, 'other')
    const store = join(base, 'plugins')
    const installed = join(store, 'file-probe')
    await Promise.all([mkdir(app, { recursive: true }), mkdir(other), mkdir(installed, { recursive: true })])
    await Promise.all([writeFile(join(repo, 'file.txt'), 'repo'), writeFile(join(app, 'file.txt'), 'app'), writeFile(join(other, 'file.txt'), 'other')])
    const manifest = { id: 'file-probe', name: 'File probe', version: '1.0.0', main: './index.js', permissions: { workspace: { read: true } } }
    await writeFile(join(installed, 'harnessdesk.plugin.json'), JSON.stringify(manifest))
    await writeFile(join(installed, 'index.js'), `export const plugin = {
      name: 'file-probe', inject: ['tools', 'context', 'workspace', 'fs'], apply(ctx) {
        const where = async () => JSON.stringify({ root: ctx.workspace.root, branch: ctx.workspace.branch, read: await ctx.fs.read('file.txt') })
        ctx.tools.register({ name: 'where', description: '', inputSchema: {}, execute: where })
        ctx.context.register({ label: 'Installed', resolve: where })
        ctx.context.register({ label: 'Installed chip', chip: { description: 'Fixture location' }, resolve: where })
      }
    }`)
    const host = new SupervisedExtensionHost(new ExtensionKernel(), { env: { HARNESSDESK_PLUGINS: store } })
    t.after(async () => { await host.dispose(); await rm(base, { recursive: true, force: true }) })
    await host.loadBuiltin({
      manifest: { ...manifest, id: 'builtin-file-probe' },
      plugin: {
        name: 'builtin-file-probe', inject: ['tools', 'context', 'workspace', 'fs'], apply(ctx: HarnessContext) {
          const where = async () => JSON.stringify({ root: ctx.workspace.root, branch: ctx.workspace.branch, read: await ctx.fs.read('file.txt') })
          ctx.tools.register({ name: 'where', description: '', inputSchema: {}, execute: where })
          ctx.context.register({ label: 'Builtin', resolve: where })
          ctx.context.register({ label: 'Builtin chip', chip: { description: 'Fixture location' }, resolve: where })
        },
      },
    } as unknown as HarnessPlugin)
    let admitted: WorkspaceAdmission = repo
    host.setShellWorkspaceResolver(async () => admitted)
    if (timing === 'live') await host.loadInstalledPlugins()
    host.setWorkspace({ root: app, branch: 'main', admitted: [repo] })
    if (timing === 'replay') await host.loadInstalledPlugins()
    const tools = host.list('tool')
    assert.equal(tools.length, 2, 'both plugin paths are loaded')
    const scope = { workspaceRoot: other, enterCheckout: true }
    const check = async (expected: { root: string; branch: string | null; read: string }) => {
      for (const tool of tools) {
        const result = await host.invokeTool(tool.id, {}, scope)
        if (!result.ok) assert.fail(result.error)
        const part = result.content[0]
        assert.equal(part?.type, 'text')
        if (part?.type !== 'text') assert.fail('the probe returns text')
        assert.deepEqual(JSON.parse(part.text), expected, String(tool.id))
      }
      const chips = host.list('context').filter((one) => one.chip)
      assert.equal(chips.length, 2)
      for (const chip of chips) {
        const result = await host.resolveOne(chip.id, undefined, scope)
        assert.ok(result)
        assert.deepEqual(JSON.parse(result.text), expected, chip.label)
      }
      const context = await host.resolveContext(scope)
      assert.equal(context.length, 2)
      for (const result of context) assert.deepEqual(JSON.parse(result.text), expected, result.label)
    }
    await check({ root: app, branch: 'main', read: 'app' })
    admitted = other
    await check({ root: other, branch: null, read: 'other' })
    // A Seat owns this checkout even though the project's fallback is listed as admitted.
    admitted = { root: repo, enterCheckout: true }
    await check({ root: repo, branch: null, read: 'repo' })
  })
}
