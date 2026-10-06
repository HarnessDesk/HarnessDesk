import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const protocolRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

test('notice-turn classification sits outside the notice and reducer modules', async () => {
  const [reducer, noticeTurn] = await Promise.all([
    readFile(resolve(protocolRoot, 'src/reduce.ts'), 'utf8'),
    readFile(resolve(protocolRoot, 'src/notice-turn.ts'), 'utf8'),
  ])

  assert.ok(!reducer.includes("from './notices.js'"), 'the reducer must not import notice folding')
  assert.ok(reducer.includes("from './notice-turn.js'"), 'session reduction consumes the independent predicate')
  assert.ok(!noticeTurn.includes("from './notices.js'"), 'the predicate must not import notice folding')
  assert.ok(!noticeTurn.includes("from './reduce.js'"), 'the predicate must not import session reduction')
})
