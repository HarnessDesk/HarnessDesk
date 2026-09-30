import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const script = dirname(fileURLToPath(import.meta.url))
const gif = readFileSync(resolve(script, 'shots/gif2.mjs'), 'utf8')

test('hero lets each named seat reply through an idle-checked room delivery', () => {
  const start = gif.indexOf("if (SCENARIO === 'hero') {\n    // HarnessDesk never shows")
  const hero = gif.slice(start, gif.indexOf("} else if (SCENARIO === 'flow') {", start))

  assert.match(gif, /seatGoal\(\{ goal: .*agent: 'room-claude-code' \}\)/)
  assert.match(gif, /seatGoal\(\{ goal: .*agent: 'room-codex' \}\)/)
  assert.match(hero, /startIdleSeatTurn\(claudeKey, 'Make the 502 retry fix/)
  assert.match(hero, /startRoomDelivery\(claudeKey, 'Your call on the nit\.'/)
  assert.match(hero, /await followRoomChat\(\)/)
  assert.match(hero, /await click\('Chat'\)/)
  assert.match(gif, /agent\.env\.SHOT_TURN = '8,8,5'/)
  assert.match(gif, /SHOT_ROOM_MESSAGE/)
  assert.match(readFileSync(resolve(script, 'shots/agent.mjs'), 'utf8'), /turn\.say \?\? \[\]/)
})

test('flow records its board changes through the seated agents, not person verbs', () => {
  const start = gif.indexOf("  } else if (SCENARIO === 'flow') {\n    // Beat 1")
  const flow = gif.slice(start)
  const agent = readFileSync(resolve(script, 'shots/agent.mjs'), 'utf8')

  assert.match(gif, /SHOT_FLOW/)
  assert.doesNotMatch(flow, /\.teamIntent\(/)
  assert.match(flow, /crop=960:600/)
  assert.match(agent, /claim_next/)
  assert.match(agent, /complete_claim/)
})
