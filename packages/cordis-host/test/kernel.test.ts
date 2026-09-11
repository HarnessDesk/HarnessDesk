import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { runtimeId, sessionId, type ExtensionEvent } from '@harnessdesk/protocol'

import { ExtensionKernel, setBrowserEngine, type HarnessPlugin } from '../src/index.js'

/**
 * The extension kernel, exercised through the real Cordis runtime.
 *
 * These tests are the evidence for the kernel decision: they assert the lifecycle
 * properties that justify depending on Cordis rather than reimplementing it.
 */

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60))

const echoTool: HarnessPlugin = {
  manifest: { id: 'echo', name: 'Echo' },
  plugin: {
    name: 'echo',
    inject: ['tools'],
    apply(ctx: any) {
      ctx.tools.register({
        name: 'echo',
        description: 'Returns what it was given.',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
        execute: (args: { text: string }) => `echo: ${args.text}`,
      })
    },
  },
}

test('a plugin loads, registers a tool, and the registry exposes it', async (t) => {
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())

  await kernel.load(echoTool)
  await settle()

  const tools = kernel.list('tool')
  assert.equal(tools.length, 1)
  assert.equal(tools[0]?.name, 'echo')
  assert.equal(tools[0]?.namespace, 'echo#1', 'namespaced by owning plugin instance')

  const plugins = kernel.plugins()
  assert.equal(plugins[0]?.state.type, 'active')
  assert.deepEqual(plugins[0]?.injects, ['tools'])
})

test('disposing the kernel stops the host services too, so the browser is closed', async (t) => {
  /* The browser service's shutdown ends the CDP connection and removes a
     profile that was never meant to be kept. It is an effect on the service's
     own scope, and the kernel used to stop only the plugins. */
  let closed = 0
  setBrowserEngine({
    ensure: () => Promise.reject(new Error('nothing drives this engine')),
    close: async () => {
      closed += 1
    },
  })
  t.after(() => setBrowserEngine(null))
  const kernel = new ExtensionKernel()
  await kernel.load(echoTool)
  await settle()
  // The control: the engine is the one installed, and nothing has closed it.
  assert.equal(closed, 0)

  await kernel.dispose()
  assert.equal(closed, 1)
  // Once: a second dispose has nothing left to stop.
  await kernel.dispose()
  assert.equal(closed, 1)
})

test('invoking a plugin tool returns its result', async (t) => {
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  await kernel.load(echoTool)
  await settle()

  const tool = kernel.list('tool')[0]!
  const result = await kernel.invokeTool(tool.id, { text: 'hi' }, {})
  assert.equal(result.ok, true)
  assert.deepEqual(result.ok && result.content, [{ type: 'text', text: 'echo: hi' }])
})

test('unloading a plugin withdraws its contributions automatically', async (t) => {
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  await kernel.load(echoTool)
  await settle()
  assert.equal(kernel.list('tool').length, 1)

  // The plugin registers no teardown code; Cordis effect tracking does it.
  await kernel.unload('echo')
  await settle()
  assert.equal(kernel.list('tool').length, 0, 'no ghost tools survive the unload')
  assert.equal(kernel.plugins().length, 0)
})

test('a plugin waiting on a missing service stays pending, then starts when it appears', async (t) => {
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())

  let applied = 0
  await kernel.load({
    manifest: { id: 'needs-db', name: 'Needs DB' },
    plugin: {
      name: 'needs-db',
      inject: ['database'],
      apply() {
        applied += 1
      },
    },
  })
  await settle()

  assert.equal(applied, 0, 'did not run without its dependency')
  const pending = kernel.plugins()[0]
  assert.equal(pending?.state.type, 'pending')
  assert.deepEqual(
    pending?.state.type === 'pending' ? pending.state.waitingFor : [],
    ['database'],
    'the UI can say what it is waiting for',
  )

  // Provide the service from another plugin.
  const provider = await kernel.load({
    manifest: { id: 'db', name: 'Database' },
    plugin: {
      name: 'db',
      apply(ctx: any) {
        ctx.provide('database', { query: () => [] })
      },
    },
  })
  assert.ok(provider)
  await settle()
  assert.equal(applied, 1, 'started on its own once the dependency existed')

  // And unloads again when the dependency disappears.
  await kernel.unload('db')
  await settle()
  const after = kernel.plugins().find((entry) => entry.identity.id === 'needs-db')
  assert.equal(after?.state.type, 'pending', 'dependents unload when a service vanishes')
})

test('contributions are grouped by owner and revised as a set', async (t) => {
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())

  const events: ExtensionEvent[] = []
  kernel.subscribe((event) => events.push(event))

  await kernel.load({
    manifest: { id: 'multi', name: 'Multi' },
    plugin: {
      name: 'multi',
      inject: ['tools'],
      apply(ctx: any, config: { count?: number }) {
        for (let index = 0; index < (config?.count ?? 2); index += 1) {
          ctx.tools.register({
            name: `tool_${index}`,
            description: 'x',
            inputSchema: { type: 'object' },
            execute: () => 'ok',
          })
        }
      },
    },
    config: { count: 2 },
  })
  await settle()
  assert.equal(kernel.list('tool').length, 2)

  const before = kernel.plugins()[0]!.revision
  await kernel.reconfigure('multi', { count: 3 })
  await settle()

  assert.equal(kernel.list('tool').length, 3)
  assert.ok(kernel.plugins()[0]!.revision > before, 'revision advanced')

  const swaps = events.filter((event) => event.type === 'contributions/changed')
  const last = swaps[swaps.length - 1]
  assert.equal(
    last?.type === 'contributions/changed' && last.contributions.length,
    3,
    'the whole set is announced at once, never half a plugin',
  )
})

test('scope narrows which contributions are in force', async (t) => {
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())

  const session = sessionId('s1')
  await kernel.load({
    manifest: { id: 'scoped', name: 'Scoped' },
    plugin: {
      name: 'scoped',
      inject: ['tools'],
      apply(ctx: any) {
        ctx.tools.register({
          name: 'everywhere',
          description: '',
          inputSchema: {},
          execute: () => 'ok',
        })
        ctx.tools.register({
          name: 'only_here',
          description: '',
          inputSchema: {},
          scope: { kind: 'session', sessionId: session },
          execute: () => 'ok',
        })
        ctx.tools.register({
          name: 'only_codex',
          description: '',
          inputSchema: {},
          scope: { kind: 'agent', runtime: runtimeId('codex') },
          execute: () => 'ok',
        })
      },
    },
  })
  await settle()

  assert.deepEqual(kernel.list('tool', {}).map((t) => t.name), ['everywhere'])
  assert.deepEqual(
    kernel.list('tool', { sessionId: session }).map((t) => t.name).sort(),
    ['everywhere', 'only_here'],
  )
  assert.deepEqual(
    kernel.list('tool', { runtime: runtimeId('codex') }).map((t) => t.name).sort(),
    ['everywhere', 'only_codex'],
  )
})

test('a throwing tool fails the call without taking the kernel down', async (t) => {
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  await kernel.load({
    manifest: { id: 'bad', name: 'Bad' },
    plugin: {
      name: 'bad',
      inject: ['tools'],
      apply(ctx: any) {
        ctx.tools.register({
          name: 'explode',
          description: '',
          inputSchema: {},
          execute: () => {
            throw new Error('boom')
          },
        })
      },
    },
  })
  await settle()

  const result = await kernel.invokeTool(kernel.list('tool')[0]!.id, {}, {})
  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.error : '', /boom/)
  assert.equal(kernel.plugins()[0]?.state.type, 'active', 'the plugin is still running')
})

test('disabling keeps the plugin listed but stops its contributions', async (t) => {
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  await kernel.load(echoTool)
  await settle()

  await kernel.setEnabled('echo', false)
  await settle()
  assert.equal(kernel.list('tool').length, 0)
  assert.equal(kernel.plugins().length, 1, 'still listed, so it can be switched back on')
  assert.equal(kernel.plugins()[0]?.enabled, false)

  await kernel.setEnabled('echo', true)
  await settle()
  assert.equal(kernel.list('tool').length, 1)
})

test('a chip provider can resolve to an image beside its text; auto context never rides it', async (t) => {
  const screenshotChip: HarnessPlugin = {
    manifest: { id: 'shot', name: 'Shot' },
    plugin: {
      name: 'shot',
      inject: ['context'],
      apply(ctx: any) {
        ctx.context.register({
          label: 'Current page screenshot',
          form: 'resource',
          chip: { description: 'A picture.' },
          resolve: () => ({
            text: 'The browser is on Example.',
            image: { dataUrl: 'data:image/png;base64,AAAA', name: 'Example' },
          }),
        })
      },
    },
  }
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  await kernel.load(screenshotChip)
  await settle()

  const contribution = kernel.list('context')[0]!
  const resolved = await kernel.resolveOne(contribution.id, undefined, {})
  assert.equal(resolved?.text, 'The browser is on Example.')
  assert.equal(resolved?.image?.dataUrl, 'data:image/png;base64,AAAA')
  assert.equal(resolved?.image?.name, 'Example')

  // A chip is attached on purpose; the every-turn collection skips it, so
  // an image can never ride a turn uninvited.
  assert.deepEqual(await kernel.resolveContext({}), [])
})
