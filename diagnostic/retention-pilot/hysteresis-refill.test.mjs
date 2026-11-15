import test from 'node:test'
import assert from 'node:assert/strict'
import { exerciseRefill } from './hysteresis-refill.mjs'

test('under-high restore stays exact, then a real high-water crossing releases an older body', async () => {
  let loaded = new Set(Array.from({ length: 126 }, (_, i) => i)), observations = 0, crossing = false
  const inspect = async () => ({ loaded: [...loaded], quiet: true, protected: true, bytes: loaded.size * 32768 })
  const out = await exerciseRefill({ total: 200, chosen: 126, initialLoaded: [...loaded], inspect,
    restore: async i => { loaded.add(i); if (loaded.size > 128) { crossing = true; loaded = new Set([...loaded].slice(-32)) }; return true },
    verify: async i => i === 126, begin: async () => { observations++ }, end: async () => ({ snapshots: 1, prepares: 1, freshReleased: true }), crossed: async () => crossing })
  assert.deepEqual(out, { underHighWarm: true, contentExact: true, crossedHigh: true, releaseObserved: true, restores: 3 })
  assert.equal(observations, 1)
})

test('refill refuses missing proof, protection, threshold, or fresh-release evidence', async () => {
  const initialLoaded = Array.from({ length: 126 }, (_, i) => i)
  for (const failure of ['content', 'protection', 'crossing', 'fresh', 'freshKey', 'release']) {
    let loaded = new Set(initialLoaded), crossed = false
    const inspect = async () => ({ loaded: [...loaded], quiet: true, protected: failure !== 'protection', bytes: loaded.size * 32768 })
    await assert.rejects(exerciseRefill({ total: 200, chosen: 126, initialLoaded, inspect,
      restore: async i => { loaded.add(i); if (loaded.size > 128) { crossed = true; if (failure !== 'release') loaded = new Set([...loaded].slice(-32)) }; return true },
      verify: async () => failure !== 'content', begin: async () => {}, end: async () => ({ snapshots: failure === 'fresh' ? 0 : 1, prepares: 1, freshReleased: failure !== 'freshKey' }), crossed: async () => failure !== 'crossing' && crossed }))
  }
})
