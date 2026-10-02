import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// shoot.mjs launches the native rig at import. Exercise its actual renderer
// assertion against representative rail boxes without launching an app here.
const shoot = readFileSync(new URL('./shots/shoot.mjs', import.meta.url), 'utf8')
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
