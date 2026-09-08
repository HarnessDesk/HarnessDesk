import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { ExtensionKernel, type PluginManifest } from '@harnessdesk/cordis-host'
import type { AgentEvent } from '@harnessdesk/protocol'

import { CodexRuntime } from '../src/index.js'

/**
 * The extension plane meeting the agent plane.
 *
 * End-to-end evidence for the kernel decision: a Cordis plugin's tool reaches Codex and its
 * result comes back, with no Codex fork and nothing Cordis-shaped crossing into
 * the runtime. The fixture reports what it observed through `warning`
 * notifications, which the adapter maps to `notice` events.
 */

const FAKE = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))
const settle = (ms = 60): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const notices = (events: readonly AgentEvent[]): string[] =>
  events.filter((event) => event.type === 'notice').map((event) => event.message)

const waitFor = async (
  check: () => boolean,
  label: string,
  timeoutMs = 8_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await settle(15)
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any

const loadPlugin = async (
  kernel: ExtensionKernel,
  id: string,
  apply: (ctx: Ctx) => void,
  permissions?: PluginManifest['permissions'],
): Promise<void> => {
  await kernel.load({
    manifest: { id, name: id, ...(permissions ? { permissions } : {}) },
    plugin: { name: id, inject: ['tools', 'hooks', 'context'], apply },
  })
  await settle()
}

const start = async (
  kernel: ExtensionKernel,
  mode = 'dynamic-tools',
): Promise<{ runtime: CodexRuntime; events: AgentEvent[] }> => {
  const runtime = new CodexRuntime({
    binaryPath: FAKE,
    capabilities: kernel,
    env: { FAKE_CODEX_MODE: mode },
  })
  await runtime.start()
  const events: AgentEvent[] = []
  runtime.subscribe((event) => events.push(event))
  return { runtime, events }
}

test('plugin tools are declared to Codex when a thread starts', async (t) => {
  const kernel = new ExtensionKernel()
  await loadPlugin(kernel, 'demo', (ctx) => {
    ctx.tools.register({
      name: 'shout',
      description: 'Uppercases its input.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      execute: (args: { text: string }) => args.text.toUpperCase(),
    })
  })

  const { runtime, events } = await start(kernel)
  t.after(async () => {
    await runtime.dispose()
    await kernel.dispose()
  })

  await runtime.createSession({ cwd: '/w' })
  await waitFor(() => notices(events).some((m) => m.startsWith('TOOLS_DECLARED')), 'the declaration')

  const declared = notices(events).find((m) => m.startsWith('TOOLS_DECLARED'))
  assert.match(declared ?? '', /hd_demo\/shout/, 'namespaced by plugin, with the instance suffix stripped')
})

test('a plugin whose id is a namespace Codex reserves still gets its tools declared', async (t) => {
  // Codex refuses thread/start when a dynamic tool namespace lands on `web`,
  // `computer`, `container` or `browser` — verified against 0.149.0. The
  // built-in web plugin is exactly this case, and the fake refuses the same way.
  const kernel = new ExtensionKernel()
  await loadPlugin(kernel, 'web', (ctx) => {
    ctx.tools.register({
      name: 'fetch_url',
      description: 'Fetches a page.',
      inputSchema: { type: 'object' },
      execute: () => 'ok',
    })
  })
  const { runtime, events } = await start(kernel)
  t.after(async () => {
    await runtime.dispose()
    await kernel.dispose()
  })
  await runtime.createSession({ cwd: '/w' })
  await waitFor(() => notices(events).some((m) => m.startsWith('TOOLS_DECLARED')), 'the declaration')
  assert.match(notices(events).find((m) => m.startsWith('TOOLS_DECLARED')) ?? '', /hd_web\/fetch_url/)
})

test('Codex calls a plugin tool and gets its result back', async (t) => {
  const kernel = new ExtensionKernel()
  await loadPlugin(kernel, 'demo', (ctx) => {
    ctx.tools.register({
      name: 'shout',
      description: 'Uppercases its input.',
      inputSchema: { type: 'object' },
      execute: (args: { text: string }) => args.text.toUpperCase(),
    })
  })

  const { runtime, events } = await start(kernel)
  t.after(async () => {
    await runtime.dispose()
    await kernel.dispose()
  })

  const session = await runtime.createSession({ cwd: '/w' })
  await session.send([{ type: 'text', text: 'use the tool' }])

  await waitFor(() => notices(events).some((m) => m.startsWith('TOOL_ANSWER')), 'the tool answer')
  const answer = notices(events).find((m) => m.startsWith('TOOL_ANSWER'))
  assert.match(answer ?? '', /success=true/)
  assert.match(answer ?? '', /FROM CODEX/, 'the plugin actually ran and uppercased the argument')
})

test('a preToolUse hook can veto a plugin tool before it runs', async (t) => {
  const kernel = new ExtensionKernel()
  let executed = false
  await loadPlugin(kernel, 'demo', (ctx) => {
    ctx.tools.register({
      name: 'shout',
      description: '',
      inputSchema: {},
      execute: () => {
        executed = true
        return 'ran'
      },
    })
    ctx.hooks.register({
      event: 'preToolUse',
      handle: () => ({ decision: 'deny', reason: 'blocked by policy' }),
    })
  })

  const { runtime, events } = await start(kernel)
  t.after(async () => {
    await runtime.dispose()
    await kernel.dispose()
  })

  const session = await runtime.createSession({ cwd: '/w' })
  await session.send([{ type: 'text', text: 'go' }])

  await waitFor(() => notices(events).some((m) => m.startsWith('TOOL_ANSWER')), 'the refusal')
  const answer = notices(events).find((m) => m.startsWith('TOOL_ANSWER'))
  assert.match(answer ?? '', /success=false/)
  assert.match(answer ?? '', /blocked by policy/)
  assert.equal(executed, false, 'the tool body never ran')
})

test('a tool from an unloaded plugin fails with a readable explanation', async (t) => {
  const kernel = new ExtensionKernel()
  await loadPlugin(kernel, 'demo', (ctx) => {
    ctx.tools.register({ name: 'shout', description: '', inputSchema: {}, execute: () => 'ok' })
  })

  const { runtime, events } = await start(kernel)
  t.after(async () => {
    await runtime.dispose()
    await kernel.dispose()
  })

  const session = await runtime.createSession({ cwd: '/w' })
  // The thread was created with the tool declared; removing the plugin now
  // leaves Codex able to call something that no longer exists.
  await kernel.unload('demo')
  await settle()

  await session.send([{ type: 'text', text: 'go' }])
  await waitFor(() => notices(events).some((m) => m.startsWith('TOOL_ANSWER')), 'the failure')
  const answer = notices(events).find((m) => m.startsWith('TOOL_ANSWER'))
  assert.match(answer ?? '', /success=false/)
  assert.match(answer ?? '', /reloaded or removed/, 'says why, rather than a bare error')
})

test('a session with no extension kernel behaves exactly as before', async (t) => {
  const runtime = new CodexRuntime({ binaryPath: FAKE, env: { FAKE_CODEX_MODE: 'dynamic-tools' } })
  t.after(() => runtime.dispose())
  await runtime.start()
  const events: AgentEvent[] = []
  runtime.subscribe((event) => events.push(event))

  await runtime.createSession({ cwd: '/w' })
  await waitFor(() => notices(events).some((m) => m.startsWith('TOOLS_DECLARED')), 'the declaration')
  assert.match(
    notices(events).find((m) => m.startsWith('TOOLS_DECLARED')) ?? '',
    /\(none\)/,
    'the two planes stay independent',
  )
})

test('context contributions are folded into the turn, not exposed as tools', async (t) => {
  const kernel = new ExtensionKernel()
  await loadPlugin(kernel, 'conventions', (ctx) => {
    ctx.context.register({ label: 'Repo conventions', resolve: () => 'Always use tabs.' })
  })

  const { runtime } = await start(kernel, 'turn')
  t.after(async () => {
    await runtime.dispose()
    await kernel.dispose()
  })

  const session = await runtime.createSession({ cwd: '/w' })
  await session.send([{ type: 'text', text: 'do the thing' }])
  await settle(200)

  // Nothing was registered as a tool; the material reaches the model as input.
  assert.equal(kernel.list('tool').length, 0)
  assert.equal(kernel.list('context').length, 1)
})
