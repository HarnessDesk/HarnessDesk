import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ExtensionKernel, setAgentsEngine, type AgentsEngine, type AgentsScope, type AskInput } from '../src/index.js'

/**
 * `ctx.agents` is the one door a plugin has to another agent. These tests hold
 * its two promises: no `agents.invoke`, no door; and the host is told who is
 * asking from the dispatch it made, never from what the plugin passes.
 */

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60))

const plugin = (id: string, granted: boolean) => ({
  manifest: { id, name: id, permissions: granted ? { agents: { invoke: true } } : {} },
  plugin: {
    name: id,
    inject: ['tools', 'agents'],
    apply(ctx: any) {
      ctx.tools.register({
        name: `ask_${id}`,
        description: '',
        inputSchema: { type: 'object', properties: {} },
        execute: async (_args: unknown, scope: unknown) => {
          // A plugin that tries to name another plugin, invocation or caller
          // in the input or the scope it passes must not be believed.
          const forged = { ...(scope as object), plugin: 'someone-else', invocation: 'forged' }
          const answer = await ctx.agents.ask(
            { agent: 'fake', question: 'What is 2+2?', context: null, plugin: 'smuggled', extra: true },
            forged,
          )
          return answer.text
        },
      })
    },
  },
})

test('ctx.agents.ask is refused without agents.invoke, and the engine never sees the call', async (t) => {
  const calls: unknown[] = []
  setAgentsEngine({ ask: async (input, scope) => { calls.push({ input, scope }); return { text: '4', agentName: 'Fake', truncated: false } } })
  t.after(() => setAgentsEngine(null))
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  await kernel.load(plugin('denied', false) as any)
  await settle()
  const scope = { runtime: 'codex' as any, sessionId: 'one' as any }
  const denied = await kernel.invokeTool(kernel.list('tool').find((tool) => tool.name === 'ask_denied')!.id, {}, scope)
  assert.equal(denied.ok, false)
  assert.match(denied.ok ? '' : denied.error, /Permission denied: agents\.invoke/)
  assert.equal(calls.length, 0)
})

test('with agents.invoke, ctx.agents.ask reaches the engine with plugin and invocation stamped from the dispatch', async (t) => {
  const calls: { input: AskInput; scope: AgentsScope }[] = []
  const engine: AgentsEngine = {
    ask: async (input, scope) => { calls.push({ input, scope }); return { text: '4', agentName: 'Fake', truncated: false } },
  }
  setAgentsEngine(engine)
  t.after(() => setAgentsEngine(null))
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  await kernel.load(plugin('granted', true) as any)
  await settle()
  const scope = { runtime: 'codex' as any, sessionId: 'one' as any }
  const allowed = await kernel.invokeTool(kernel.list('tool').find((tool) => tool.name === 'ask_granted')!.id, {}, scope)
  assert.equal(allowed.ok, true)
  assert.equal(calls.length, 1)
  const call = calls[0]!
  assert.deepEqual(call.input, { agent: 'fake', question: 'What is 2+2?', context: null })
  assert.deepEqual({ runtime: call.scope.runtime, sessionId: call.scope.sessionId }, { runtime: 'codex', sessionId: 'one' })
  assert.notEqual(call.scope.plugin, 'someone-else')
  assert.match(String(call.scope.plugin), /^granted/)
  assert.equal(typeof call.scope.invocation, 'string')
  assert.notEqual(call.scope.invocation, 'forged')
  // The lifetime is local, never enumerable: it does not cross a process boundary.
  assert.equal(Object.keys(call.scope).includes('signal'), false)
})
