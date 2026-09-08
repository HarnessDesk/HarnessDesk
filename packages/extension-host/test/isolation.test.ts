import assert from 'node:assert/strict'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { ExtensionKernel, type TeamEngine } from '@harnessdesk/cordis-host'
import type { ContributionId, RuntimeId, SessionId } from '@harnessdesk/protocol'

import { SupervisedExtensionHost } from '../src/index.js'

/**
 * Process isolation, exercised for real: third-party plugins run in a child
 * process; a plugin calling `process.exit` kills only that process, a plugin
 * that spins is killed from the healthy side, a plugin that leaks handles is
 * visible in the accounting, and every in-flight caller fails cleanly —
 * never hangs.
 */

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url))

const scope = { sessionId: 's1' as SessionId }

interface Harness {
  readonly host: SupervisedExtensionHost
  readonly dir: string
  toolId(name: string): ContributionId
}

const start = async (plugins: readonly string[]): Promise<Harness> => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-exthost-'))
  const store = join(dir, 'plugins')
  for (const plugin of plugins) {
    await cp(join(FIXTURES, `plugin-${plugin}`), join(store, plugin), { recursive: true })
  }
  const host = new SupervisedExtensionHost(new ExtensionKernel(), {
    invokeTimeoutMs: 1500,
    env: { HARNESSDESK_PLUGINS: store },
  })
  await host.loadInstalledPlugins()
  return {
    host,
    dir,
    toolId(name) {
      const tool = host.list('tool').find((entry) => entry.name === name)
      assert.ok(tool, `tool ${name} should be contributed; saw ${host.list('tool').map((t) => t.name).join(', ')}`)
      return tool.id
    },
  }
}

const cleanup = async (harness: Harness): Promise<void> => {
  await harness.host.dispose()
  await rm(harness.dir, { recursive: true, force: true })
}

const until = async (predicate: () => boolean, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

test('a plugin loaded in the child contributes tools the parent can call', async () => {
  const harness = await start(['good'])
  try {
    const result = await harness.host.invokeTool(harness.toolId('ping'), {}, scope)
    assert.equal(result.ok, true)
    assert.match(JSON.stringify(result), /pong/)
    // The child's plugins appear in the merged listing.
    assert.ok(harness.host.plugins().some((plugin) => plugin.identity.id === 'good'))
  } finally {
    await cleanup(harness)
  }
})

test('a plugin calling process.exit kills only the plugin host; callers fail fast and it recovers', async () => {
  const harness = await start(['good', 'exit'])
  try {
    const began = Date.now()
    const dying = harness.host.invokeTool(harness.toolId('die'), {}, scope)
    const bystander = harness.host.invokeTool(harness.toolId('ping'), {}, scope)

    // Both in-flight calls resolve to failures well inside the timeout: the
    // exit is detected, not waited out.
    const [dieResult, pingResult] = await Promise.all([dying, bystander])
    assert.equal(dieResult.ok, false)
    assert.match(String((dieResult as { error: string }).error), /exited/)
    assert.equal(pingResult.ok, false)
    assert.ok(Date.now() - began < 1400, 'failure came from the exit, not the deadline')

    // This process is alive to make the next assertion, which is the point.
    // The supervisor restarts the child and reloads what is installed.
    await until(() => harness.host.plugins().some((plugin) => plugin.identity.id === 'good'))
    const recovered = await harness.host.invokeTool(harness.toolId('ping'), {}, scope)
    assert.equal(recovered.ok, true)
  } finally {
    await cleanup(harness)
  }
})

test('a plugin that spins is killed from the healthy side and reported as such', async () => {
  const harness = await start(['good', 'spin'])
  try {
    const spinning = await harness.host.invokeTool(harness.toolId('spin'), {}, scope)
    assert.equal(spinning.ok, false)
    assert.match(String((spinning as { error: string }).error), /did not answer|monopolising|exited/)

    // Recovery is a process restart; the caller's story is "retry and it
    // works", so that is what the test does.
    const deadline = Date.now() + 10_000
    for (;;) {
      const after = await harness.host.invokeTool(harness.toolId('ping'), {}, scope)
      if (after.ok) break
      if (Date.now() > deadline) assert.fail(`never recovered: ${JSON.stringify(after)}`)
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
  } finally {
    await cleanup(harness)
  }
})

test('leaked handles show up in the resource accounting', async () => {
  const harness = await start(['leak'])
  try {
    const before = await harness.host.stats()
    const leak = await harness.host.invokeTool(harness.toolId('leak'), {}, scope)
    assert.equal(leak.ok, true)
    const after = await harness.host.stats()
    assert.ok(
      after.activeHandles >= before.activeHandles + 40,
      `handles should jump by ~50; ${before.activeHandles} -> ${after.activeHandles}`,
    )
    assert.ok((after.invocations['leak#1'] ?? Object.values(after.invocations)[0] ?? 0) >= 1)
  } finally {
    await cleanup(harness)
  }
})

test('a hook living in a dead child fails closed, and works again after recovery', async () => {
  const harness = await start(['good', 'exit'])
  try {
    // Healthy: the child's hook denies its matched tool.
    const denied = await harness.host.runHooks({
      event: 'preToolUse',
      toolName: 'forbidden_tool',
      arguments: {},
      scope,
    })
    assert.equal(denied.decision, 'deny')

    // Kill the child, then immediately ask again. The snapshot still lists
    // the hook; the answer must not silently become allow. Either the
    // restarted child answers (deny) or the failure reads as a deny.
    void harness.host.invokeTool(harness.toolId('die'), {}, scope)
    const during = await harness.host.runHooks({
      event: 'preToolUse',
      toolName: 'forbidden_tool',
      arguments: {},
      scope,
    })
    assert.equal(during.decision, 'deny')

    // An unmatched tool is allowed again once the child has recovered.
    await until(() => harness.host.plugins().some((plugin) => plugin.identity.id === 'good'))
    const allowed = await harness.host.runHooks({
      event: 'preToolUse',
      toolName: 'harmless',
      arguments: {},
      scope,
    })
    assert.equal(allowed.decision, 'allow')
  } finally {
    await cleanup(harness)
  }
})

test('built-ins load in-process and are routed without touching the child', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-exthost-'))
  const host = new SupervisedExtensionHost(new ExtensionKernel(), {
    invokeTimeoutMs: 1500,
    env: { HARNESSDESK_PLUGINS: join(dir, 'plugins') },
  })
  try {
    await host.loadBuiltin({
      manifest: { id: 'inproc', name: 'In-process' },
      plugin: {
        name: 'inproc',
        inject: ['tools'],
        apply(ctx: { tools: { register(tool: unknown): void } }) {
          ctx.tools.register({
            name: 'local_echo',
            description: 'echoes',
            inputSchema: { type: 'object', properties: {} },
            execute: () => 'from this very process',
          })
        },
      },
    })
    // No child was ever started; the tool still answers.
    const tool = host.list('tool').find((entry) => entry.name === 'local_echo')
    assert.ok(tool)
    const result = await host.invokeTool(tool.id, {}, scope)
    assert.equal(result.ok, true)
    // Uninstalling a built-in is refused in plain words.
    await assert.rejects(host.uninstallPlugin('inproc'), /part of HarnessDesk/)
  } finally {
    await host.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('an installed copy a built-in has taken over can still be removed', async () => {
  // The situation `#retireShadowed` exists for: a plugin installed from the
  // examples, and later shipped as part of the app under the same id. The
  // installed copy is switched off — and while "uninstall" refused anything a
  // built-in answered to, switching it off was as far as anyone could get.
  const dir = await mkdtemp(join(tmpdir(), 'hd-exthost-'))
  const store = join(dir, 'plugins')
  await cp(join(FIXTURES, 'plugin-good'), join(store, 'good'), { recursive: true })
  const host = new SupervisedExtensionHost(new ExtensionKernel(), {
    invokeTimeoutMs: 5_000,
    env: { HARNESSDESK_PLUGINS: store },
  })
  try {
    await host.loadBuiltin({
      manifest: { id: 'good', name: 'Good, built in' },
      plugin: { name: 'good', apply() {} },
    })
    await host.loadInstalledPlugins()
    const copies = host.plugins().filter((plugin) => plugin.identity.id === 'good')
    assert.equal(copies.length, 2, 'both the built-in and the installed copy are in the roster')
    assert.equal(
      copies.filter((plugin) => plugin.enabled).length,
      1,
      'only the built-in stays enabled',
    )
    await host.uninstallPlugin('good')
    assert.deepEqual(
      host.plugins().filter((plugin) => plugin.identity.id === 'good').length,
      1,
      'the copy on disk is gone and the built-in remains',
    )
  } finally {
    await host.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

/**
 * A browser engine standing in for the desktop shell's pane: it answers the
 * DevTools calls the service makes and remembers them, so the test can see
 * the child's tool drive the parent's page rather than a Chrome of its own.
 */
const fakeEngine = () => {
  const calls: string[] = []
  let ensured = 0
  let closed = 0
  const engine = {
    async ensure() {
      ensured += 1
      return {
        async send(method: string, params?: Record<string, unknown>) {
          calls.push(method)
          switch (method) {
            case 'Runtime.evaluate': {
              const expression = String(params?.['expression'] ?? '')
              if (expression.startsWith('JSON.stringify')) {
                return { result: { value: JSON.stringify({ url: 'http://fake/', title: 'Fake page' }) } }
              }
              return { result: { value: 2 } }
            }
            case 'Page.captureScreenshot':
              return { data: 'iVBORw0KGgo=' }
            default:
              return {}
          }
        },
      }
    },
    async close() {
      closed += 1
    },
  }
  return { engine, calls, ensured: () => ensured, closed: () => closed }
}

test('a child plugin\'s browser tools drive the page the parent provides', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-exthost-'))
  const store = join(dir, 'plugins')
  await cp(join(FIXTURES, 'plugin-browser'), join(store, 'browserish'), { recursive: true })
  const fake = fakeEngine()
  const host = new SupervisedExtensionHost(new ExtensionKernel(), {
    invokeTimeoutMs: 5_000,
    env: { HARNESSDESK_PLUGINS: store },
    browserEngine: fake.engine,
  })
  await host.loadInstalledPlugins()
  try {
    const look = host.list('tool').find((entry) => entry.name === 'look')
    assert.ok(look, 'the browser-driving tool is contributed from the child')
    const result = await host.invokeTool(look.id, { url: 'http://fake/' }, scope)
    assert.equal(result.ok, true)
    const text = result.ok ? result.content.map((part) => (part.type === 'text' ? part.text : '')).join('') : ''
    const parsed = JSON.parse(text) as { page: { url: string; title: string }; shot: string; value: number }
    assert.deepEqual(parsed.page, { url: 'http://fake/', title: 'Fake page' })
    assert.equal(parsed.shot, 'data:image/png;base64,')
    assert.equal(parsed.value, 2)
    // Every DevTools call crossed the process boundary to the parent's engine.
    assert.deepEqual(
      fake.calls.filter((call) => call !== 'Runtime.evaluate'),
      ['Page.navigate', 'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent', 'Page.captureScreenshot'],
    )
    assert.ok(fake.ensured() >= 1)

    const leave = host.list('tool').find((entry) => entry.name === 'leave')!
    await host.invokeTool(leave.id, {}, scope)
    assert.equal(fake.closed(), 1)
  } finally {
    await host.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a team call rides its own invocation or is refused: the child cannot impersonate', async () => {
  // The child process is shared by every installed plugin, so the scope on a
  // `team/*` request is a claim, not a fact. The parent stands behind only
  // the scopes it is currently invoking the child for: the honest tool's
  // call goes through, the forged scope is refused before any engine sees it.
  const statusCalls: unknown[] = []
  const engine: TeamEngine = {
    board: async () => 'x',
    addIntent: async () => 'x',
    claim: async () => 'x',
    claimNext: async () => 'x',
    conflicts: async () => 'x',
    complete: async () => 'x',
    release: async () => 'x',
    handoff: async () => 'x',
    status: async (callScope) => {
      statusCalls.push(callScope)
      return 'status ok'
    },
    send: async () => 'x',
  }
  const dir = await mkdtemp(join(tmpdir(), 'hd-exthost-'))
  const store = join(dir, 'plugins')
  await cp(join(FIXTURES, 'plugin-teamish'), join(store, 'teamish'), { recursive: true })
  const host = new SupervisedExtensionHost(new ExtensionKernel(), {
    invokeTimeoutMs: 1500,
    env: { HARNESSDESK_PLUGINS: store },
    teamEngine: engine,
  })
  try {
    await host.loadInstalledPlugins()
    const toolId = (name: string): ContributionId => {
      const tool = host.list('tool').find((entry) => entry.name === name)
      assert.ok(tool, `tool ${name} should be contributed`)
      return tool.id
    }
    const live = { runtime: 'codex' as RuntimeId, sessionId: 's1' as SessionId }

    const honest = await host.invokeTool(toolId('team_status_honest'), {}, live)
    assert.equal(honest.ok, true)
    assert.match(JSON.stringify(honest), /status ok/)
    assert.equal(statusCalls.length, 1, 'the honest call reached the engine')

    const forged = await host.invokeTool(toolId('team_status_forged'), {}, live)
    assert.match(JSON.stringify(forged), /cannot be attributed/)
    assert.equal(statusCalls.length, 1, 'the forged scope never reached the engine')
  } finally {
    await host.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

/**
 * Two plugins, one process, one grant between them.
 *
 * The grant used to arm the *conversation*, so it stood for every plugin in
 * the shared child for as long as any team-granted plugin was enabled. A
 * plugin with no grant at all could therefore write a `team/*` request to the
 * stdout they share and be attributed to a live conversation. Attribution is
 * per plugin invocation now, and this is the test that says so.
 */
test('a plugin without the grant cannot ride a granted sibling’s armed scope', async () => {
  const statusCalls: unknown[] = []
  const engine: TeamEngine = {
    board: async () => 'x',
    addIntent: async () => 'x',
    claim: async () => 'x',
    claimNext: async () => 'x',
    conflicts: async () => 'x',
    complete: async () => 'x',
    release: async () => 'x',
    handoff: async () => 'x',
    status: async (callScope) => {
      statusCalls.push(callScope)
      return 'status ok'
    },
    send: async () => 'x',
  }
  const dir = await mkdtemp(join(tmpdir(), 'hd-exthost-'))
  const store = join(dir, 'plugins')
  await cp(join(FIXTURES, 'plugin-teamish'), join(store, 'teamish'), { recursive: true })
  await cp(join(FIXTURES, 'plugin-ungranted'), join(store, 'ungranted'), { recursive: true })
  const host = new SupervisedExtensionHost(new ExtensionKernel(), {
    invokeTimeoutMs: 3000,
    env: { HARNESSDESK_PLUGINS: store },
    teamEngine: engine,
  })
  try {
    await host.loadInstalledPlugins()
    const toolId = (name: string): ContributionId => {
      const tool = host.list('tool').find((entry) => entry.name === name)
      assert.ok(tool, `tool ${name} should be contributed`)
      return tool.id
    }
    const live = { runtime: 'codex' as RuntimeId, sessionId: 's1' as SessionId }

    // The granted plugin still works, and its scope carries who it is.
    const honest = await host.invokeTool(toolId('team_status_honest'), {}, live)
    assert.equal(honest.ok, true)
    assert.equal(statusCalls.length, 1)
    assert.ok(
      typeof (statusCalls[0] as { plugin?: unknown }).plugin === 'string',
      'the engine is told which plugin asked',
    )

    // The ungranted sibling, invoked for the same conversation, gets nothing
    // — not even by speaking the wire protocol itself.
    const smuggled = await host.invokeTool(toolId('team_status_ungranted'), {}, live)
    // Not vacuous: the fixture really did speak the protocol and really was
    // answered — with a refusal naming the reason, not with silence.
    assert.match(JSON.stringify(smuggled), /cannot be attributed/)
    assert.doesNotMatch(JSON.stringify(smuggled), /status ok/)
    assert.equal(statusCalls.length, 1, 'the ungranted plugin never reached the engine')
  } finally {
    await host.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})
