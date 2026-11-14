import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ExtensionKernel, setAgentsEngine, type AgentsScope, type AskInput } from '@harnessdesk/cordis-host'
import { DESK_TOOL_CEILINGS, type ToolResult } from '@harnessdesk/protocol'

import { builtinPlugins, consultPlugin } from '../src/index.js'

/**
 * `ask_agent` through the real kernel: the plugin holds `agents.invoke` and
 * nothing else, bounds what the model may send, hands the engine exactly the
 * question and the invocation's own scope, and returns the answer as text.
 * Every decision about whether the caller may ask is the host's.
 */

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60))
const text = (result: ToolResult): string =>
  result.ok ? result.content.map((part) => (part.type === 'text' ? part.text : '')).join('') : `!${result.error}`

test('the manifest asks for agents.invoke and nothing else, and the plugin is built in', () => {
  assert.deepEqual(consultPlugin.manifest.permissions, { agents: { invoke: true } })
  assert.equal(consultPlugin.manifest.id, 'consult')
  assert.equal(consultPlugin.manifest.name, 'Ask another agent')
  assert.ok(builtinPlugins.includes(consultPlugin))
  assert.equal(DESK_TOOL_CEILINGS['consult']?.['ask_agent'], 'read', 'asking changes nothing on disk')
})

test('ask_agent: bounded input, the engine hears the question and the dispatch’s scope, the answer comes back as text', async (t) => {
  const calls: { input: AskInput; scope: AgentsScope }[] = []
  setAgentsEngine({
    ask: async (input, scope) => {
      calls.push({ input, scope })
      if (input.agent === 'nobody') throw Object.assign(new Error('This seat may ask only: holdfake (Hold Fake).'), { wireCode: 'askNotAllowed' })
      return { text: '4 <img src=x onerror=alert(1)>', agentName: 'Hold Fake', truncated: false }
    },
  })
  t.after(() => setAgentsEngine(null))
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  await kernel.load(consultPlugin)
  await settle()
  const tool = kernel.list('tool').find((one) => one.name === 'ask_agent')!
  assert.equal(tool.title, 'Ask another agent')
  const schema = tool.inputSchema as { required: string[]; additionalProperties: boolean; properties: Record<string, { maxLength?: number; minLength?: number }> }
  assert.deepEqual(schema.required, ['agent', 'question'])
  assert.equal(schema.additionalProperties, false)
  assert.deepEqual([schema.properties['agent']!.minLength, schema.properties['agent']!.maxLength], [1, 64])
  assert.equal(schema.properties['question']!.maxLength, 16384)
  assert.equal(schema.properties['context']!.maxLength, 16384)

  const scope = { runtime: 'fake' as never, sessionId: 'caller-1' as never }
  const answered = await kernel.invokeTool(tool.id, { agent: 'holdfake', question: 'What is 2+2?' }, scope)
  assert.equal(text(answered), '4 <img src=x onerror=alert(1)>', 'the answer is handed back as text, untouched; the transcript renders it inert')
  assert.deepEqual(calls[0]!.input, { agent: 'holdfake', question: 'What is 2+2?', context: null })
  assert.deepEqual({ runtime: calls[0]!.scope.runtime, sessionId: calls[0]!.scope.sessionId }, { runtime: 'fake', sessionId: 'caller-1' })
  assert.match(String(calls[0]!.scope.plugin), /^consult/)

  await kernel.invokeTool(tool.id, { agent: 'holdfake', question: 'Why?', context: 'The diff is in src/.' }, scope)
  assert.equal(calls[1]!.input.context, 'The diff is in src/.')

  const refused = await kernel.invokeTool(tool.id, { agent: 'nobody', question: 'q' }, scope)
  assert.equal(refused.ok, false)
  assert.match(text(refused), /may ask only: holdfake \(Hold Fake\)/, 'a refusal reaches the agent in words it can act on')
})
