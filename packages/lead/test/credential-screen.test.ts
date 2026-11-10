import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as lead from '../src/index.js'
import type { MessagesTurn } from '../src/index.js'

// The shape that stuck a desk: a worker chat the person stopped mid-run, read back by the Lead. One line of a command's
// output is a clipped config line whose value is the desk's own clip marker, not a credential.
const clipped = '  authorization: … keys}'
const chatRead = (line: string) => JSON.stringify({ id: 'chat-1', title: 'Fix the config loader', agent: { name: 'Agent' }, status: 'stopped',
  turns: [{ type: 'you', id: 'm1', text: 'Fix the loader', attachments: [] },
    { type: 'work', id: 'm2', summary: 'Ran a command', steps: [{ kind: 'run', title: 'a command', output: ['config:', '  name: demo', line, '  retries: 3'] }] }],
  omittedSourceTurns: 0, omittedPhoneEntries: 0, truncated: true })
const conversation = (result: string): MessagesTurn[] => [
  { role: 'user', content: [{ type: 'text', text: 'What happened to the loader chat?' }] },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'read-1', name: 'chat_read', input: { id: 'chat-1' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-1', content: result, is_error: false }] },
]
const github = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'

test('a clipped header line whose value is only the clip marker is not a credential', () => {
  assert.equal(lead.leadDataContainsCredential(clipped), false)
  assert.equal(lead.leadDataContainsCredential('  password=…'), false)
  assert.equal(lead.leadContainsSecret(chatRead(clipped)), false)
  assert.equal(lead.leadMessagesContainSecret({ messages: conversation(chatRead(clipped)) }, 'synthetic-provider-key'), false)
  // Real values are still caught, in prose and inside an encoded tool result.
  for (const text of ['Authorization: Bearer abc123def', 'authorization: Basic ZGV2OnNlY3JldA==', 'x-api-key: abc123', 'password=hunter2', `token ${github}`])
    assert.equal(lead.leadDataContainsCredential(text), true, text)
  assert.equal(lead.leadMessagesContainSecret({ messages: conversation(chatRead('  authorization: Bearer abc123def')) }, 'synthetic-provider-key'), true)
})

test('withholding replaces only the pieces the host would refuse, so the rest of the conversation still goes', () => {
  const turns = [...conversation(chatRead(`  token: ${github}`)),
    { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'The loader chat stopped while printing its config.' }] },
    { role: 'user' as const, content: [{ type: 'text' as const, text: `Use ${github} for the push` }, { type: 'text' as const, text: 'Desk reference for the preceding person message: m3' }] }]
  assert.equal(lead.leadMessagesContainSecret({ messages: turns }, 'synthetic-provider-key'), true)
  const withheld = lead.leadWithholdCredentials(turns)
  assert.equal(lead.leadMessagesContainSecret({ messages: withheld }, 'synthetic-provider-key'), false)
  assert.deepEqual(withheld[0], turns[0]); assert.deepEqual(withheld[1], turns[1]); assert.deepEqual(withheld[3], turns[3])
  assert.deepEqual(withheld[2]!.content[0], { type: 'tool_result', tool_use_id: 'read-1', content: lead.LEAD_WITHHELD_TEXT, is_error: false })
  assert.deepEqual(withheld[4]!.content, [{ type: 'text', text: lead.LEAD_WITHHELD_TEXT }, turns[4]!.content[1]])
  assert.ok(!JSON.stringify(withheld).includes(github))
  // Nothing to withhold returns the same turns, so a stored conversation and its cached prefix stay stable.
  const clean = conversation(chatRead(clipped))
  assert.deepEqual(lead.leadWithholdCredentials(clean), clean)
})

test('withholding keeps the flow preview token the host already lets through, and a tool call keeps its id', () => {
  const token = '123e4567-e89b-42d3-a456-426614174000' // hd-secrets-ok: a flow preview's UUID, not a credential
  const turns: MessagesTurn[] = [
    { role: 'user', content: [{ type: 'text', text: 'Start the review flow' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'preview-1', name: 'flow_preview', input: { root: '/workspace/demo' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'preview-1', content: JSON.stringify({ token, steps: 2 }), is_error: false }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'start-1', name: 'flow_start_goal', input: { token } },
      { type: 'tool_use', id: 'chat-1', name: 'chat_start', input: { prompt: `push with password=hunter2` } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'start-1', content: '{"ok":true}', is_error: false }, { type: 'tool_result', tool_use_id: 'chat-1', content: '{"ok":true}', is_error: false }] },
  ]
  const withheld = lead.leadWithholdCredentials(turns)
  assert.deepEqual(withheld.slice(0, 3), turns.slice(0, 3))
  assert.deepEqual(withheld[3]!.content, [turns[3]!.content[0], { type: 'tool_use', id: 'chat-1', name: 'chat_start', input: {} }])
  assert.equal(lead.leadMessagesContainSecret({ messages: withheld }, 'synthetic-provider-key'), false)
})
