import assert from 'node:assert/strict'
import { test } from 'node:test'
import { trayMenuTemplate } from './tray-menu.mjs'

const agent = (id, over = {}) => ({ id, name: `Agent ${id}`, detail: 'Ready', needsSignIn: false, brand: null, left: null, ...over })
const setup = agents => {
  const calls = []
  const actions = Object.fromEntries(['show', 'newSession', 'openFolder', 'openUsage', 'settings', 'quit', 'signIn'].map(name => [name, (...args) => calls.push([name, ...args])]))
  const menu = trayMenuTemplate({ title: '', agents }, { actions, iconFor: name => `icon:${name}`, agentIcon: one => `agent:${one.id}` })
  return { menu, calls, usage: menu.find(one => one.label === 'Usage')?.submenu }
}
const rootLabels = menu => menu.filter(one => one.type !== 'separator').map(one => one.label)

test('the native menu stays at six choices as the runtime roster grows', () => {
  for (const size of [0, 1, 20]) {
    const { menu } = setup(Array.from({ length: size }, (_, i) => agent(String(i))))
    assert.deepEqual(rootLabels(menu), ['Open HarnessDesk', 'New Session', 'Open Folder…', 'Usage', 'Settings…', 'Quit HarnessDesk'])
  }
})

test('observed readings keep account names, resets and their scoped dashboard action', () => {
  const { usage, calls } = setup([
    agent('writer', { name: 'Writer · jane@example.com', detail: '71% left, resets in 2h', left: 71 }),
    agent('reviewer', { detail: '0% left, resets in 1h', left: 0 }),
  ])
  const first = usage.find(one => one.label === 'Writer · jane@example.com — 71% left, resets in 2h')
  assert.equal(first.icon, 'agent:writer')
  assert.notEqual(first.enabled, false)
  first.click()
  usage.find(one => one.label === 'Agent reviewer — 0% left, resets in 1h').click()
  assert.deepEqual(calls, [['openUsage', 'writer'], ['openUsage', 'reviewer']])
})

test('sign-in is an action even when a cached reading is still present', () => {
  const { usage, calls } = setup([agent('signed-out', { name: 'Workspace account', detail: '45% left', left: 45, needsSignIn: true })])
  const row = usage.find(one => one.label === 'Workspace account — Sign in…')
  assert.ok(row)
  row.click()
  assert.deepEqual(calls, [['signIn', 'signed-out']])
})

test('unavailable and other attention facts survive without usage readings', () => {
  const { usage, calls } = setup([
    agent('unavailable', { detail: 'Unavailable' }),
    agent('limit', { detail: 'Limit reached' }),
  ])
  usage.find(one => one.label === 'Agent unavailable — Unavailable').click()
  assert.ok(usage.some(one => one.label === 'Agent limit — Limit reached'))
  assert.deepEqual(calls, [['openUsage', 'unavailable']])
})

test('unreported ready and unanswered runtimes take one quiet note, not one row each', () => {
  const { usage } = setup([
    agent('ready'), agent('available', { detail: 'Not added' }), agent('unknown', { detail: 'Not checked yet' }),
  ])
  assert.deepEqual(usage.filter(one => one.type !== 'separator').map(one => one.label), ['No usage reported for 3 runtimes', 'Open Dashboard…'])
  assert.equal(usage[0].enabled, false)
  assert.equal(usage[0].click, undefined)
})

test('an empty menu still opens Dashboard and all primary native actions', () => {
  const { menu, usage, calls } = setup([])
  assert.equal(usage[0].label, 'No usage reported yet')
  assert.equal(usage[0].enabled, false)
  usage.find(one => one.label === 'Open Dashboard…').click()
  for (const row of menu.filter(one => one.click)) row.click()
  assert.deepEqual(calls, [['openUsage'], ['show'], ['newSession'], ['openFolder'], ['settings'], ['quit']])
})

test('a missing native icon leaves its action usable', () => {
  let shown = 0
  const noop = () => {}
  const menu = trayMenuTemplate({ title: '', agents: [agent('one', { left: 60, detail: '60% left' })] }, {
    actions: { show: () => { shown++ }, newSession: noop, openFolder: noop, openUsage: noop, settings: noop, quit: noop, signIn: noop },
    iconFor: () => null, agentIcon: () => null,
  })
  assert.equal(menu[0].icon, undefined)
  menu[0].click()
  assert.equal(shown, 1)
})
