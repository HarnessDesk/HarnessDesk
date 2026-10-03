import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { waitForSnapshot } from './lib/desk.mjs'

// shoot.mjs launches the native rig at import. Exercise its actual renderer
// assertion against representative rail boxes without launching an app here.
const shoot = readFileSync(new URL('./shots/shoot.mjs', import.meta.url), 'utf8')

test('native hover waits for opaque actions and settled mark geometry', async () => {
  const from = shoot.indexOf('  const hover = async (selector) => {')
  const to = shoot.indexOf('  const workspaceHoverAction =', from)
  let reads = 0
  const samples = [
    { ready: false, geometry: 'old' },
    { ready: false, geometry: 'old' },
    { ready: false, geometry: 'moving' },
    { ready: true, geometry: 'settled' },
    { ready: true, geometry: 'settled' },
  ]
  const cdp = {
    send: async () => {},
    json: async expression => expression.includes('getAnimations')
      ? samples[Math.min(reads++, samples.length - 1)] : { x: 100, y: 100 },
  }
  const hover = new Function('cdp', 'sleep', 'q', 'waitForSnapshot', `${shoot.slice(from, to)}; return hover`)(
    cdp, async () => {}, JSON.stringify,
    (read, matches) => waitForSnapshot(read, matches, { sleepImpl: async () => {} }),
  )
  await hover('[data-slot="sidebar-menu-action"]')
  assert.equal(reads, samples.length, 'a fixed delay cannot vouch for opacity or mark placement')
})
const start = shoot.indexOf('        for (const row of document.querySelectorAll(\'[data-slot="sidebar-menu-item"]:hover\'))')
const end = shoot.indexOf('        // A popup', start)
assert.ok(start >= 0 && end > start, 'the native hover assertion is present')
const check = new Function('document', 'visible', 'faults', shoot.slice(start, end))

for (const marks of [0, 1, 2, 3, 4]) {
  for (const actionCount of [1, 2]) {
    test(`native action centres stay on the rail with ${marks} marks and ${actionCount} actions`, () => {
      const box = (centre) => ({ left: centre - 12, right: centre + 12, top: 0, bottom: 24, height: 24 })
      const actions = Array.from({ length: actionCount }, (_, index) => ({
        getBoundingClientRect: () => box(268 - (actionCount - index - 1) * 24),
      }))
      const row = {
        getAttribute: () => String(marks),
        querySelectorAll: (selector) => selector.includes('sidebar-menu-action') ? actions : [],
      }
      const document = {
        querySelectorAll: () => [row],
        querySelector: () => ({ parentElement: { getBoundingClientRect: () => ({ right: 300 }) } }),
      }
      const faults = []
      check(document, () => true, faults)
      assert.deepEqual(faults, [])
    })
  }
}

// Evaluate just the two scene declarations, supplying the same staging seam.
// Both must preserve the marked sessions and pinned project supplied by it.
for (const scene of ['workspace-hover', 'session-hover']) {
  test(`${scene} preserves the rig's marks and pinned project`, async () => {
    const from = shoot.indexOf('  const workspaceHoverAction =')
    const to = shoot.indexOf('  /**', from)
    const scenes = {}
    const mutations = []
    const hovered = []
    let staged = 0
    new Function('SCENES', 'stageSidebarMarks', 'hover', 'cdp', 'sleep', 'STORE',
      shoot.slice(from, to))(
      scenes, async () => { staged += 1 }, async (selector) => { hovered.push(selector) },
      { eval: async (expression) => { mutations.push(expression) } }, async () => {}, 'store',
    )
    await scenes[scene].run()
    assert.equal(staged, 1)
    assert.deepEqual(mutations, [], 'the staged history and pin are not stripped')
    assert.equal(hovered.length, 1)
    if (scene === 'session-hover') assert.doesNotMatch(hovered[0], /trailing-marks="0"/, 'the native scene targets a marked session')
  })
}
