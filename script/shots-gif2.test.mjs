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
  assert.match(hero, /seatGoal\(\{ goal: .*agent: 'room-codex' \}\)/)
  assert.match(hero, /startRoomDelivery\(claudeKey, 'Please make the 502 retry fix/)
  assert.match(hero, /startRoomDelivery\(claudeKey, 'Please acknowledge the checkout result/)
  assert.match(hero, /await followRoomChat\(\)/)
  assert.match(hero, /await click\('Chat'\)/)
  assert.match(hero, /startIdleSeatTurn\(codexKey, 'Keep the completed checkout open/)
  assert.match(gif, /agent\.env\.SHOT_TURN = '5,5,8'/)
  assert.doesNotMatch(hero, /\$\{STORE\}\.send\(/, 'the hero must not prompt a seated conversation directly')
})
