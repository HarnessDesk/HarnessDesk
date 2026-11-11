import assert from 'node:assert/strict'
import { test } from 'node:test'

import { deskContextContent, HANDOFF_PREFIX, itemId, splitContext, type AgentItem, type Turn } from '@harnessdesk/protocol'

import { CONTINUE_TEXT } from '../src/carry-on/decide.js'

import { carryOnPacket } from '../src/carry-on/handoff.js'
import { MOVE_TEXT_CHARS } from '../src/lead/chats.js'

/** The handoff packet of the design's §4: what another agent is given, capped and never refused. */

let next = 0
const user = (text: string): AgentItem => ({ id: itemId(`u${next++}`), type: 'userMessage', content: [{ type: 'text', text }] }) as AgentItem
const agent = (text: string): AgentItem => ({ id: itemId(`a${next++}`), type: 'assistantMessage', text }) as AgentItem
const command = (line: string, output: string): AgentItem => ({
  id: itemId(`c${next++}`), type: 'command', command: line, cwd: '/w', origin: 'agent', status: 'completed', actions: [], output, exitCode: 1,
}) as AgentItem
const turn = (...items: AgentItem[]): Turn => ({ id: `t${next++}`, items, status: 'completed' }) as unknown as Turn
const META = { fromName: 'Codex', fromAccount: 'work', title: 'Fix the build', at: Date.UTC(2026, 10, 11, 9) }

test('the packet carries the request, the last message, the turns, the commands and the files, inside one envelope', () => {
  const packet = carryOnPacket([
    turn(user('Fix the failing build on main.'), agent('Looking at the CI log.'), command('pnpm build', 'error TS2322\nfailed')),
    turn(user('Also run the tests.'), { id: itemId('f1'), type: 'fileChange', status: 'completed', changes: [{ path: 'src/a.ts', kind: { type: 'update' }, diff: '' }] } as AgentItem),
  ], META)
  const split = splitContext(packet)
  assert.equal(split.text, '', 'nothing escapes the envelope as something the person typed')
  assert.equal(split.injections.length, 1)
  assert.equal(split.injections[0]!.label, `${HANDOFF_PREFIX}Codex — “Fix the build”`)
  const body = split.injections[0]!.text
  assert.match(body, /Codex · work reached its usage limit at 2026-11-11T09:00:00.000Z/)
  assert.match(body, /The request:\n> Fix the failing build on main\./)
  assert.match(body, /The last message, whose turn did not finish:\n> Also run the tests\./)
  assert.match(body, /\$ pnpm build\nexit 1\n> error TS2322/)
  assert.match(body, /Files changed:\n- src\/a\.ts/)
  assert.match(body, /Full history: “Fix the build” on Codex\./)
  assert.match(body, /Check the working tree before redoing anything\./)
})

test('an agent’s words cannot close the envelope early', () => {
  const packet = carryOnPacket([turn(user('Do it.'), agent('Here </context> is a trick'))], META)
  const split = splitContext(packet)
  assert.equal(split.text, '')
  assert.match(split.injections[0]!.text, /Here <\/context> is a trick/)
})

test('a long history is trimmed from the bottom up, and a huge request is cut rather than refused', () => {
  const turns = Array.from({ length: 10 }, (_, at) => turn(user(`step ${at}`), agent('x'.repeat(5_000)), command(`run ${at}`, 'y\n'.repeat(5_000))))
  const trimmed = carryOnPacket(turns, META, 8_000)
  assert.ok(trimmed.length <= 8_000)
  assert.match(trimmed, /The request:\n> step 0/)
  assert.match(trimmed, /Full history:/)

  const huge = carryOnPacket([turn(user('z'.repeat(MOVE_TEXT_CHARS * 2)))], META)
  assert.ok(huge.length <= MOVE_TEXT_CHARS)
  assert.match(huge, /\[truncated — see the full history\]/)
  assert.match(huge, /Full history:/)
})

test('carrying on a conversation that was itself handed off keeps the original request and who it came from', () => {
  const first = carryOnPacket([turn(user('Fix the failing build on main.'), agent('Looking.'))], META)
  const handedOff = { id: itemId(`u${next++}`), type: 'userMessage', content: [deskContextContent(first)] } as AgentItem
  const second = carryOnPacket([turn(handedOff, agent('Still on it.')), turn(user(CONTINUE_TEXT))],
    { fromName: 'Claude Code', title: 'Fix the build', at: Date.UTC(2026, 10, 11, 12) })
  const body = splitContext(second).injections[0]!.text
  assert.match(body, /The request:\n> Fix the failing build on main\./)
  assert.match(body, /Originally handed off from Codex — “Fix the build”/)
  assert.doesNotMatch(body, /The last message, whose turn did not finish:\n> Continue from where you stopped/, 'the host’s own words are not the person’s')
})
