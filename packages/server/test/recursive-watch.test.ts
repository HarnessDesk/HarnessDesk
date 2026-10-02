import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { watchRoster } from '../src/recursive-watch.js'
import { tempDir } from './scratch.js'

test('a missing recursive watch root refuses instead of returning an inert watcher', () => {
  const root = join(tempDir('hd-recursive-watch-'), 'missing')
  let watcher = null as ReturnType<typeof watchRoster> | null
  try {
    assert.throws(() => {
      watcher = watchRoster(root, { recursive: true, persistent: false }, () => {})
    }, { code: 'ENOENT' })
  } finally {
    watcher?.close()
  }
})
