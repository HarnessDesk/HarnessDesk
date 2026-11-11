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

// Values without an ASCII letter or digit are still credentials; only a value that is wholly a placeholder is not.
const nonAscii = ['password=пароль', 'password=密码密码', 'password=!@#$%^&*()', 'x-api-key: €€€€', 'secret=////']
const placeholders = ['  authorization: … keys}', 'password=***', 'token=...', 'Authorization: Bearer [redacted]', 'secret=<redacted>', 'password=•••']

test('a credential value in any script is caught by the request check, and a placeholder value is not', () => {
  for (const text of nonAscii) {
    assert.equal(lead.leadDataContainsCredential(text), true, text)
    assert.equal(lead.leadMessagesContainSecret({ messages: conversation(chatRead(`  ${text}`)) }, 'synthetic-provider-key'), true, text)
  }
  for (const text of placeholders) {
    assert.equal(lead.leadDataContainsCredential(text), false, text)
    assert.equal(lead.leadMessagesContainSecret({ messages: conversation(chatRead(text)) }, 'synthetic-provider-key'), false, text)
  }
  // A placeholder is the whole value: anything after it in the same value is a value.
  for (const text of ['password=***abc', 'authorization: …abc', 'secret=[redacted]x']) assert.equal(lead.leadDataContainsCredential(text), true, text)
})

// A placeholder ends at a delimiter, or at the quote that really closes an encoded string. Anything glued to it is a value.
const dodges = ['password=..."abc', 'password=***\\"hunter2', 'password=…"hunter2', 'Authorization: Bearer …\\realtoken', 'password=…Abc', 'password=[redacted]"x']
const passing = ['  authorization: … keys}', 'authorization: …', 'password=***', 'token=...']
const encodings = (text: string) => [text, JSON.stringify([text]), JSON.stringify(JSON.stringify({ output: [text, 'next'] }))]

test('a value glued to a placeholder by a quote or an escape is still a credential, in every encoding', () => {
  for (const text of dodges) {
    for (const encoded of encodings(text)) assert.equal(lead.leadDataContainsCredential(encoded), true, encoded)
    assert.equal(lead.leadMessagesContainSecret({ messages: conversation(chatRead(text)) }, 'synthetic-provider-key'), true, text)
  }
  for (const text of passing) {
    for (const encoded of encodings(text)) assert.equal(lead.leadDataContainsCredential(encoded), false, encoded)
    assert.equal(lead.leadMessagesContainSecret({ messages: conversation(chatRead(text)) }, 'synthetic-provider-key'), false, text)
  }
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

test('withholding counts what it put aside, and drops screened reasoning only where the provider does not need it', () => {
  const thinking = (text: string) => ({ type: 'thinking' as const, thinking: text, signature: 'synthetic-signature' })
  const turns: MessagesTurn[] = [
    { role: 'user', content: [{ type: 'text', text: 'Push the branch' }] },
    // An earlier assistant turn: its reasoning is not needed again, so a screened block is dropped.
    { role: 'assistant', content: [thinking('I will use password=hunter2'), { type: 'text', text: 'Pushed.' }] },
    { role: 'user', content: [{ type: 'text', text: 'And the tag?' }] },
    { role: 'assistant', content: [thinking('maybe secret=xyz again')] },
    { role: 'user', content: [{ type: 'text', text: 'Read the loader chat' }] },
    // The latest assistant turn is mid tool loop: its reasoning is kept as it was, and the host decides.
    { role: 'assistant', content: [thinking('the token=abc123 is in the config'), { type: 'tool_use', id: 'read-1', name: 'chat_read', input: { id: 'chat-1' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-1', content: 'ok', is_error: false }] },
  ]
  const { messages, withheld } = lead.leadWithholdCredentialsReport(turns)
  assert.deepEqual(messages[1]!.content, [{ type: 'text', text: 'Pushed.' }])
  assert.deepEqual(messages[3]!.content, [{ type: 'text', text: lead.LEAD_WITHHELD_TEXT }], 'a turn is never left empty')
  assert.deepEqual(messages[5], turns[5])
  assert.deepEqual(withheld, [{ turn: 1, kind: 'thinking', count: 1 }, { turn: 3, kind: 'thinking', count: 1 }])
  assert.ok(!JSON.stringify(withheld).includes('hunter2'))
  assert.deepEqual(lead.leadWithholdCredentials(turns), messages)
})
