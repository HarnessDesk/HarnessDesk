import assert from 'node:assert/strict'
import { test } from 'node:test'

import { runScene } from './shots/scene.mjs'

/**
 * A scene and what it runs among, every step written down as it happens.
 *
 * The scenes that bend an agent's history put it back in `finish`. A frame is
 * only as good as the scene that made it, and a scene that fails halfway is
 * exactly the one that must not leave the desk bent for the next take.
 */
const staged = (scene = {}) => {
  const seen = []
  return {
    seen,
    scene: {
      run: async () => void seen.push('run'),
      finish: async () => void seen.push('finish'),
      ...scene,
    },
    around: {
      leaveOverlay: async () => void seen.push('overlay'),
      themes: ['light', 'dark'],
      photograph: async (theme) => void seen.push(`photograph ${theme}`),
    },
  }
}

test('a scene is staged once, photographed in each theme, and only then put back', async () => {
  const { seen, scene, around } = staged()
  await runScene(scene, around)
  assert.deepEqual(seen, ['run', 'photograph light', 'photograph dark', 'finish'])
})

test('the overlay is left first, and only for a scene that asks', async () => {
  const asks = staged({ leaveOverlay: true })
  await runScene(asks.scene, asks.around)
  assert.deepEqual(asks.seen.slice(0, 2), ['overlay', 'run'])

  const does = staged()
  await runScene(does.scene, does.around)
  assert.equal(does.seen.includes('overlay'), false)
})

test('a scene that fails staging is still put back, and no frame is taken', async () => {
  const { seen, scene, around } = staged({
    run: async () => {
      seen.push('run')
      throw new Error('the row was not there')
    },
  })
  await assert.rejects(runScene(scene, around), /the row was not there/)
  assert.deepEqual(seen, ['run', 'finish'])
})

test('a frame that fails is still put back, and the frames after it are not taken', async () => {
  const { seen, scene, around } = staged()
  around.photograph = async (theme) => {
    seen.push(`photograph ${theme}`)
    throw new Error('expected text is not on screen')
  }
  await assert.rejects(runScene(scene, around), /expected text is not on screen/)
  assert.deepEqual(seen, ['run', 'photograph light', 'finish'])
})

test('a scene with nothing to put back runs as it always did', async () => {
  const { seen, scene, around } = staged({ finish: undefined })
  await runScene(scene, around)
  assert.deepEqual(seen, ['run', 'photograph light', 'photograph dark'])
})

test('a scene that fails and then fails to put back reports why it failed', async () => {
  const { scene, around } = staged({
    run: async () => {
      throw new Error('the row was not there')
    },
    finish: async () => {
      throw new Error('the store could not be written')
    },
  })
  await assert.rejects(runScene(scene, around), /the row was not there/)
})

test('a scene that only fails to put back is reported, having got its frames', async () => {
  const { seen, scene, around } = staged({
    finish: async () => {
      seen.push('finish')
      throw new Error('the store could not be written')
    },
  })
  await assert.rejects(runScene(scene, around), /the store could not be written/)
  assert.deepEqual(seen, ['run', 'photograph light', 'photograph dark', 'finish'])
})
