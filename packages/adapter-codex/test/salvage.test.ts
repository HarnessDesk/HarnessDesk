import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { runtimeId, sessionId } from '@harnessdesk/protocol'

import { salvageSession } from '../src/salvage.js'

/**
 * Codex refuses a whole thread over one stored item it cannot deserialize —
 * a rollout saved by a newer build. The salvage reads the file line by line
 * and keeps what parses, so the conversation is at least readable.
 */

const ID = '01a03647-1daf-7433-aaf1-2ed2bb79af7a'

const line = (type: string, payload: unknown): string =>
  JSON.stringify({ timestamp: '2026-08-25T00:17:05.885Z', type, payload })

const ROLLOUT = [
  line('session_meta', { cwd: '/repo', originator: 'Codex Desktop', cli_version: '0.149.0-alpha.4.3' }),
  // The scaffolding the desktop app stores as `user`: never speech.
  line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<recommended_plugins>…' }] }),
  line('response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<app-context>…' }] }),
  line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Plan the website.' }] }),
  line('response_item', {
    type: 'reasoning',
    summary: [{ type: 'summary_text', text: 'Weighing the layout' }],
    encrypted_content: 'gAAAA…',
  }),
  line('response_item', {
    type: 'custom_tool_call',
    call_id: 'call_1',
    name: 'exec',
    input: 'tools.exec_command({cmd:"ls"})',
  }),
  line('response_item', {
    type: 'custom_tool_call_output',
    call_id: 'call_1',
    output: [{ type: 'input_text', text: 'README.md\n' }],
  }),
  // The item kind the stable CLI chokes on; the salvage just walks past it.
  line('event_msg', { type: 'subagent-completed', variant: 'completed' }),
  'not json at all {{{',
  line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Here is the plan.' }] }),
  line('compacted', {}),
  line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue with design A.' }] }),
  line('response_item', {
    type: 'message',
    role: 'assistant',
    content: [
      {
        type: 'output_text',
        // Codex appends memory citations to the prose; its own UI chips them.
        text: 'Design A it is.\n\n<oai-mem-citation>\n<citation_entries>\nMEMORY.md:108-118|note=[positioning prefs]\nrollout_summaries/x.md:36-41|note=[prior audit] 01a03216-6a3d-75f1-93e3-1752bf1a6968\n</citation_entries>\n</oai-mem-citation>',
      },
    ],
  }),
].join('\n')

test('a rollout the CLI refuses is salvaged into a readable conversation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hd-codex-home-'))
  try {
    const day = join(home, 'sessions', '2026', '08', '24')
    await mkdir(day, { recursive: true })
    await writeFile(join(day, `rollout-2026-08-24T17-17-05-${ID}.jsonl`), ROLLOUT)

    const session = await salvageSession(home, runtimeId('codex'), sessionId(ID))
    assert.ok(session, 'the rollout stands in for the refused thread')
    assert.equal(session.cwd, '/repo')
    assert.equal(session.status.type, 'idle')

    const shape = session.turns.map((turn) =>
      turn.items.map((item) => {
        if (item.type === 'userMessage')
          return `user: ${item.content.map((part) => (part.type === 'text' ? part.text : '')).join('')}`
        if (item.type === 'assistantMessage') return `assistant: ${item.text}`
        if (item.type === 'notice') return `notice: ${item.text.slice(0, 40)}`
        if (item.type === 'reasoning') return `reasoning: ${item.summary.join(' ')}`
        if (item.type === 'toolCall') return `tool: ${item.tool}`
        return item.type
      }),
    )
    assert.deepEqual(shape, [
      [
        'notice: Recovered from the session file on disk ',
        'user: Plan the website.',
        'reasoning: Weighing the layout',
        'tool: exec',
        'assistant: Here is the plan.',
        'notice: The conversation was compacted to fit in',
      ],
      ['user: Continue with design A.', 'assistant: Design A it is.'],
    ])

    const call = session.turns[0]?.items.find((item) => item.type === 'toolCall')
    assert.ok(call && call.type === 'toolCall')
    assert.deepEqual(call.result, [{ type: 'text', text: 'README.md\n' }])
    const note = session.turns[0]?.items[0]
    assert.ok(note && note.type === 'notice' && note.text.includes('Codex Desktop 0.149.0-alpha.4.3'))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('no rollout, or one with no readable speech, salvages nothing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hd-codex-home-'))
  try {
    assert.equal(await salvageSession(home, runtimeId('codex'), sessionId(ID)), null)

    const day = join(home, 'sessions', '2026', '08', '24')
    await mkdir(day, { recursive: true })
    await writeFile(
      join(day, `rollout-x-${ID}.jsonl`),
      line('response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<scaffolding>' }] }),
    )
    assert.equal(await salvageSession(home, runtimeId('codex'), sessionId(ID)), null, 'scaffolding alone is not a conversation')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
