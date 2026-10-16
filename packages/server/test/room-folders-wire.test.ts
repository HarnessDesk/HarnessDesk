import assert from 'node:assert/strict'
import { mkdirSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { GoalView } from '@harnessdesk/protocol'
import { goalViewForWire } from '../src/goals/wire.js'
import { goalMethods } from '../src/methods/goals.js'
import { tempDir } from './scratch.js'

test('Goal wire views measure roots without changing the durable board', () => {
  const root = join(tempDir('hd-room-folders-'), 'project')
  mkdirSync(root)
  const view = { board: { root, intents: [] } } as unknown as GoalView
  assert.equal(goalViewForWire(view).board.folderGone, false)
  rmSync(root, { recursive: true })
  assert.equal(goalViewForWire(view).board.folderGone, true)
  assert.equal(Object.hasOwn(view.board, 'folderGone'), false)
  mkdirSync(root)
  assert.equal(goalViewForWire(view).board.folderGone, false)
})

test('a Goal list measures a shared root once for hundreds of Teams', async (t) => {
  const root = tempDir('hd-room-folders-list-')
  const view = { board: { root, intents: [] } } as unknown as GoalView
  let calls = 0
  const native = realpathSync.native
  t.mock.method(realpathSync, 'native', new Proxy(native, {
    apply(target, receiver, args) { calls++; return Reflect.apply(target, receiver, args) },
  }))
  const context = { goals: { list: async () => Array.from({ length: 300 }, () => view) } } as unknown as Parameters<typeof goalMethods['goal/list']>[0]
  const result = await goalMethods['goal/list'](context, {})
  assert.equal(result.length, 300)
  assert.ok(result.every(one => one.board.folderGone === false))
  assert.equal(calls, 1)
})
