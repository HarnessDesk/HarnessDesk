import assert from 'node:assert/strict'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { ExtensionKernel, setForgeEngine, type ForgeEngine, type ForgeScope } from '@harnessdesk/cordis-host'
import type { ContributionId, RuntimeId, SessionId } from '@harnessdesk/protocol'

import { SupervisedExtensionHost } from '../src/index.js'

/**
 * The blind-round embargo, across the plugin child: a plugin asks it before
 * it posts, and the host answers for the conversation of the invocation the
 * parent dispatched — the same answer a built-in plugin gets in-process. A
 * plugin that names somebody else's conversation, through the service or by
 * writing the frame itself, is refused before the engine hears of it.
 */

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url))
const BLIND = 'Refused: this Seat is reviewing in a blind round that has not closed.'

const engine = (asked: ForgeScope[]): ForgeEngine => ({
  seat: async () => null,
  identity: async () => ({ via: 'gh', login: null, available: true, reason: null }),
  publish: async () => {},
  publicationAllowed: async (scope) => {
    asked.push(scope)
    return scope.sessionId === 's1' ? { ok: false, reason: BLIND } : { ok: true }
  },
})

test('the embargo crosses the child for its own invocation only, and answers as it does in-process', async () => {
  const asked: ForgeScope[] = []
  const dir = await mkdtemp(join(tmpdir(), 'hd-exthost-'))
  const store = join(dir, 'plugins')
  await cp(join(FIXTURES, 'plugin-forgeish'), join(store, 'forgeish'), { recursive: true })
  const host = new SupervisedExtensionHost(new ExtensionKernel(), { invokeTimeoutMs: 1500, env: { HARNESSDESK_PLUGINS: store }, forgeEngine: engine(asked) })
  try {
    await host.loadInstalledPlugins()
    const toolId = (name: string): ContributionId => {
      const tool = host.list('tool').find((entry) => entry.name === name)
      assert.ok(tool, `tool ${name} should be contributed`)
      return tool.id
    }
    const live = { runtime: 'alpha' as RuntimeId, sessionId: 's1' as SessionId }
    const honest = await host.invokeTool(toolId('forge_allowed_honest'), {}, live)
    assert.equal(honest.ok, true)
    assert.match(JSON.stringify(honest), /blind round that has not closed/)
    assert.equal(asked.length, 1)
    assert.equal(asked[0]!.runtime, 'alpha')
    assert.equal(asked[0]!.sessionId, 's1')
    assert.equal(typeof asked[0]!.plugin, 'string', 'the engine is told which plugin asked')

    const forged = await host.invokeTool(toolId('forge_allowed_forged'), {}, live)
    assert.match(JSON.stringify(forged), /cannot be attributed/)
    const spoken = await host.invokeTool(toolId('forge_allowed_spoken'), {}, live)
    assert.match(JSON.stringify(spoken), /cannot be attributed/)
    assert.equal(asked.length, 1, 'neither forged scope reached the engine: a blind reviewer cannot borrow a free conversation’s answer')
  } finally {
    await host.dispose()
    await rm(dir, { recursive: true, force: true })
  }

  // The same plugin in-process, against the same engine: the same answer for the same conversation.
  const inProcess: ForgeScope[] = []
  setForgeEngine(engine(inProcess))
  const kernel = new ExtensionKernel()
  try {
    await kernel.load({
      manifest: { id: 'forgeish', name: 'Forge-permitted plugin', permissions: { forge: true } },
      plugin: {
        name: 'forgeish', inject: ['tools', 'forge'],
        apply(ctx: any) {
          ctx.tools.register({
            name: 'forge_allowed_honest', description: 'x', inputSchema: { type: 'object', properties: {} },
            execute: async (_args: unknown, scope: unknown) => JSON.stringify(await ctx.forge.publicationAllowed(scope)),
          })
        },
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 60))
    const tool = kernel.list('tool').find((entry) => entry.name === 'forge_allowed_honest')!
    const result = await kernel.invokeTool(tool.id, {}, { runtime: 'alpha', sessionId: 's1' } as never)
    assert.match(JSON.stringify(result), /blind round that has not closed/)
    assert.equal(inProcess[0]!.sessionId, 's1')
  } finally {
    setForgeEngine(null)
    await kernel.dispose()
  }
})
