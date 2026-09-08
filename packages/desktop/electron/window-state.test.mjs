import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { DEFAULT_BOUNDS, isVisibleOn, readWindowState, writeWindowState } from './window-state.mjs'

const laptop = { workArea: { x: 0, y: 25, width: 1512, height: 907 } }
const external = { workArea: { x: 1512, y: 0, width: 2560, height: 1440 } }

test('a window fully on a display is restored', () => {
  assert.equal(isVisibleOn({ x: 100, y: 100, width: 1200, height: 700 }, [laptop]), true)
})

test('a window on a display that is no longer attached is refused', () => {
  const onExternal = { x: 2000, y: 200, width: 1200, height: 800 }
  assert.equal(isVisibleOn(onExternal, [laptop, external]), true)
  assert.equal(isVisibleOn(onExternal, [laptop]), false, 'external display unplugged')
})

test('a window with only a sliver on screen is refused', () => {
  // The user could not grab the title bar to move it back.
  assert.equal(isVisibleOn({ x: 1480, y: 500, width: 1200, height: 800 }, [laptop]), false)
})

test('nonsense geometry is refused', () => {
  assert.equal(isVisibleOn(null, [laptop]), false)
  assert.equal(isVisibleOn({ x: 0, y: 0, width: 10, height: 10 }, [laptop]), false)
  assert.equal(isVisibleOn({ x: NaN, y: 0, width: 800, height: 600 }, [laptop]), false)
})

test('state round-trips and falls back cleanly', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-window-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'window.json')

  const missing = await readWindowState(file, [laptop])
  assert.deepEqual(missing.bounds, DEFAULT_BOUNDS)

  await writeWindowState(file, {
    bounds: { x: 40, y: 60, width: 1100, height: 720 },
    maximized: true,
  })
  const restored = await readWindowState(file, [laptop])
  assert.deepEqual(restored.bounds, { x: 40, y: 60, width: 1100, height: 720 })
  assert.equal(restored.maximized, true)
})

test('a corrupt state file falls back to defaults rather than failing to launch', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-window-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'window.json')
  const { writeFile } = await import('node:fs/promises')
  await writeFile(file, '{ not json')
  const state = await readWindowState(file, [laptop])
  assert.deepEqual(state.bounds, DEFAULT_BOUNDS)
})
