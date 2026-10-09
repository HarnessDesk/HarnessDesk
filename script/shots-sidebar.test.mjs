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
  let tooltipReads = 0
  const moves = []
  const samples = [
    { ready: false, geometry: 'old' },
    { ready: false, geometry: 'old' },
    { ready: false, geometry: 'moving' },
    { ready: true, geometry: 'settled' },
    { ready: true, geometry: 'settled' },
  ]
  const cdp = {
    send: async (_method, params) => { moves.push(params) },
    eval: async () => ++tooltipReads >= 3,
    json: async expression => expression.includes('getAnimations')
      ? samples[Math.min(reads++, samples.length - 1)] : { x: 100, y: 100 },
  }
  const hover = new Function('cdp', 'sleep', 'q', 'waitForSnapshot', `${shoot.slice(from, to)}; return hover`)(
    cdp, async () => {}, JSON.stringify,
    (read, matches) => waitForSnapshot(read, matches, { sleepImpl: async () => {} }),
  )
  await hover('[data-slot="sidebar-menu-action"]')
  assert.equal(tooltipReads, 3, 'the previous row tooltip must leave before targeting another row')
  assert.deepEqual(moves[0], { type: 'mouseMoved', x: 0, y: 0 })
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
test('sidebar marks follow the indexed list without altering agent history', async () => {
  const from = shoot.indexOf('  const stageSidebarMarks = async () => {')
  const to = shoot.indexOf("  SCENES['session-rest']", from)
  const root = '/demo/storefront'
  // The index sorts across agents: other projects can precede this project.
  const data = [
    { id: 'other-first', cwd: '/demo/other' },
    { id: 'other-second', cwd: '/demo/other' },
    ...[0, 1, 2].map(index => ({ id: String(index), cwd: root })),
  ]
  const store = {
    transport: { request: async () => ({ data }) },
    setListPrefs: () => {},
    loadHistory: async () => {},
  }
  const stage = new Function('SCENES', 'cdp', 'q', 'REPO', 'STORE', 'sleep', `${shoot.slice(from, to)}; return stageSidebarMarks`)(
    { desk: { run: async () => {} } },
    { eval: async expression => new Function('fixtureStore', `return ${expression}`)(store) },
    JSON.stringify, root, 'fixtureStore', async () => {},
  )
  await stage()
  const rows = (await store.transport.request('session/index', {})).data
  assert.deepEqual(rows.slice(0, 2), data.slice(0, 2))
  assert.equal(rows[2].repo?.worktree, true)
  assert.equal(rows[3].folderGone, true)
  assert.deepEqual(rows[4], data[4])
  assert.deepEqual((await store.transport.request('session/list', {})).data, data)
})

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
