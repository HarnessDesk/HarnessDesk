import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ExtensionKernel } from '../src/index.js'

/**
 * Hooks let a plugin observe or veto the agent's loop. The properties that
 * matter: order is deterministic, the first refusal wins, and a hook can never
 * hang a turn.
 */

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60))

const hookPlugin = (id: string, register: (ctx: any) => void) => ({
  manifest: { id, name: id },
  plugin: { name: id, inject: ['hooks'], apply: register },
})

test('hooks run in priority order and allow by default', async (t) => {
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  const seen: string[] = []

  await kernel.load(
    hookPlugin('late', (ctx) =>
      ctx.hooks.register({
        event: 'preToolUse',
        priority: 200,
        handle: () => {
          seen.push('late')
        },
      }),
    ),
  )
  await kernel.load(
    hookPlugin('early', (ctx) =>
      ctx.hooks.register({
        event: 'preToolUse',
        priority: 10,
        handle: () => {
          seen.push('early')
        },
      }),
    ),
  )
  await settle()

  const verdict = await kernel.runHooks({ event: 'preToolUse', toolName: 'shell', scope: {} })
  assert.deepEqual(seen, ['early', 'late'])
  assert.equal(verdict.decision, 'allow')
})

test('the first non-allow verdict wins and stops the chain', async (t) => {
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  let laterRan = false

  await kernel.load(
    hookPlugin('guard', (ctx) =>
      ctx.hooks.register({
        event: 'preToolUse',
        priority: 10,
        handle: () => ({ decision: 'deny', reason: 'blocked by policy' }),
      }),
    ),
  )
  await kernel.load(
    hookPlugin('after', (ctx) =>
      ctx.hooks.register({
        event: 'preToolUse',
        priority: 20,
        handle: () => {
          laterRan = true
        },
      }),
    ),
  )
  await settle()

  const verdict = await kernel.runHooks({ event: 'preToolUse', toolName: 'shell', scope: {} })
  assert.equal(verdict.decision, 'deny')
  assert.equal(verdict.decision === 'deny' && verdict.reason, 'blocked by policy')
  assert.equal(laterRan, false, 'a refusal short-circuits')
})

test('a hook can escalate to asking the user', async (t) => {
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  await kernel.load(
    hookPlugin('escalate', (ctx) =>
      ctx.hooks.register({
        event: 'preToolUse',
        handle: () => ({ decision: 'ask', reason: 'this touches production' }),
      }),
    ),
  )
  await settle()

  const verdict = await kernel.runHooks({ event: 'preToolUse', toolName: 'deploy', scope: {} })
  assert.equal(verdict.decision, 'ask')
})

test('match narrows a hook to specific tools', async (t) => {
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  await kernel.load(
    hookPlugin('shell-only', (ctx) =>
      ctx.hooks.register({
        event: 'preToolUse',
        match: ['shell'],
        handle: () => ({ decision: 'deny', reason: 'no shell' }),
      }),
    ),
  )
  await settle()

  assert.equal((await kernel.runHooks({ event: 'preToolUse', toolName: 'shell', scope: {} })).decision, 'deny')
  assert.equal((await kernel.runHooks({ event: 'preToolUse', toolName: 'read', scope: {} })).decision, 'allow')
})

test('a hung hook is skipped rather than allowed to hang the turn', async (t) => {
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  await kernel.load(
    hookPlugin('slow', (ctx) =>
      ctx.hooks.register({
        event: 'preToolUse',
        timeoutMs: 40,
        handle: () => new Promise(() => {}),
      }),
    ),
  )
  await settle()

  const started = Date.now()
  const verdict = await kernel.runHooks({ event: 'preToolUse', toolName: 'x', scope: {} })
  assert.equal(verdict.decision, 'allow', 'skipping is fail-open; denying on a bug would be worse')
  assert.ok(Date.now() - started < 1_000, 'the turn was not held up')
})

test('a throwing hook does not block the turn either', async (t) => {
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  await kernel.load(
    hookPlugin('thrower', (ctx) =>
      ctx.hooks.register({
        event: 'preToolUse',
        handle: () => {
          throw new Error('hook bug')
        },
      }),
    ),
  )
  await settle()
  assert.equal((await kernel.runHooks({ event: 'preToolUse', scope: {} })).decision, 'allow')
})

test('context contributions resolve into labelled text', async (t) => {
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  await kernel.load({
    manifest: { id: 'ctx-plugin', name: 'Context' },
    plugin: {
      name: 'ctx-plugin',
      inject: ['context'],
      apply(ctx: any) {
        ctx.context.register({ label: 'Repo conventions', resolve: () => 'Use tabs.' })
        ctx.context.register({ label: 'Empty', resolve: () => '   ' })
      },
    },
  })
  await settle()

  const resolved = await kernel.resolveContext({})
  assert.deepEqual(resolved, [{ label: 'Repo conventions', text: 'Use tabs.' }])
})

test('commands dispatch by name', async (t) => {
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  let received: string | null = null
  await kernel.load({
    manifest: { id: 'cmd', name: 'Commands' },
    plugin: {
      name: 'cmd',
      inject: ['commands'],
      apply(ctx: any) {
        ctx.commands.register({
          name: 'deploy',
          description: 'Deploy the app',
          run: (argument: string) => {
            received = argument
          },
        })
      },
    },
  })
  await settle()

  assert.equal(await kernel.runCommand('deploy', 'staging', {}), true)
  assert.equal(received, 'staging')
  assert.equal(await kernel.runCommand('nope', '', {}), false)
})
