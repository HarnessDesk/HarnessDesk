import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ExtensionKernel, setForgeEngine, type ForgeEngine } from '../src/index.js'
import { describePermissions, readPermissions } from '../src/manifest.js'

/**
 * `ctx.forge` behind its grant. A plugin without `forge` cannot read a seat
 * or write a record — signing as somebody's conversation is exactly the
 * thing the gate exists for — and a plugin with it reaches the engine with
 * its own identity stamped on the scope, so the host knows who asked.
 */

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60))

const engine = (): ForgeEngine & { readonly seats: unknown[]; readonly published: unknown[] } => {
  const seats: unknown[] = []
  const published: unknown[] = []
  return {
    seats,
    published,
    seat: async (scope) => {
      seats.push(scope)
      return { agent: 'Codex', version: null, model: 'GPT-5.4', effort: 'High', thinking: false, label: 'Codex GPT-5.4 · High' }
    },
    identity: async () => ({ via: 'gh', login: 'octocat', available: true, reason: null }),
    publish: async (reference, scope) => {
      published.push({ reference, scope })
    },
  }
}

test('the forge plane needs the grant; with it, the scope carries the plugin', async (t) => {
  const plane = engine()
  setForgeEngine(plane)
  t.after(() => setForgeEngine(null))
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())

  await kernel.load({
    manifest: { id: 'ungranted', name: 'Ungranted' },
    plugin: {
      name: 'ungranted',
      inject: ['tools', 'forge'],
      apply(ctx: any) {
        ctx.tools.register({
          name: 'ungranted_seat',
          description: 'x',
          inputSchema: { type: 'object', properties: {} },
          execute: async (_args: unknown, scope: unknown) => {
            try {
              return JSON.stringify(await ctx.forge.seat(scope))
            } catch (error) {
              return `refused: ${error instanceof Error ? error.message : String(error)}`
            }
          },
        })
      },
    },
  })
  await kernel.load({
    manifest: { id: 'granted', name: 'Granted', permissions: { forge: true } },
    plugin: {
      name: 'granted',
      inject: ['tools', 'forge'],
      apply(ctx: any) {
        ctx.tools.register({
          name: 'granted_seat',
          description: 'x',
          inputSchema: { type: 'object', properties: {} },
          execute: async (_args: unknown, scope: unknown) => JSON.stringify(await ctx.forge.seat(scope)),
        })
        ctx.tools.register({
          name: 'granted_publish',
          description: 'x',
          inputSchema: { type: 'object', properties: {} },
          execute: async (_args: unknown, scope: unknown) => {
            await ctx.forge.publish({ kind: 'pullRequest', number: 1, repo: 'a/b', url: 'https://x/pull/1' }, scope)
            return 'recorded'
          },
        })
      },
    },
  })
  await settle()

  const tool = (name: string) => {
    const found = kernel.list('tool').find((entry) => entry.name === name)
    assert.ok(found, `no tool ${name}`)
    return found.id
  }
  const scope = { runtime: 'codex', sessionId: 's1' } as any

  const refused = await kernel.invokeTool(tool('ungranted_seat'), {}, scope)
  assert.match(JSON.stringify(refused), /refused: .*forge/)
  assert.equal(plane.seats.length, 0, 'the engine never heard from the ungranted plugin')

  const seat = await kernel.invokeTool(tool('granted_seat'), {}, scope)
  assert.match(JSON.stringify(seat), /Codex GPT-5\.4 · High/)
  const asked = plane.seats[0] as { runtime: string; sessionId: string; plugin: string }
  assert.equal(asked.runtime, 'codex')
  assert.equal(asked.sessionId, 's1')
  assert.match(asked.plugin, /^granted#\d+$/, 'the engine is told which plugin instance asked, stamped by the service')

  await kernel.invokeTool(tool('granted_publish'), {}, scope)
  assert.equal(plane.published.length, 1)
  const recorded = (plane.published[0] as { scope: { plugin: string } }).scope
  assert.match(recorded.plugin, /^granted#\d+$/)
})

test('the grant is read from a manifest and described in a sentence', () => {
  const granted = readPermissions({ forge: true })
  assert.equal(granted.forge, true)
  assert.ok(describePermissions(granted).some((line) => /Sign pull requests/.test(line)))
  const plain = readPermissions({})
  assert.equal(plain.forge, false)
  assert.ok(!describePermissions(plain).some((line) => /Sign pull requests/.test(line)))
})
