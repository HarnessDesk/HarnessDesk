import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const shoot = readFileSync(new URL('./shots/shoot.mjs', import.meta.url), 'utf8')
const from = shoot.indexOf("  for (const section of ['profile'")
const to = shoot.indexOf("  SCENES['composer-menu']", from)
assert.ok(from >= 0 && to > from)

for (const [section, destination] of [['library', 'library'], ['plugins', 'plugins'], ['appearance', 'settings']]) {
  test(`native ${section} scene asserts the visible ${destination} destination`, async () => {
    let asked
    const store = { askSettings: name => { asked = name } }
    const document = { querySelector: selector => selector === `[data-page-destination="${destination}"]:not([hidden])`
      ? { getBoundingClientRect: () => ({ width: 800, height: 700 }) } : null }
    const scenes = {}
    const cdp = { eval: async expression => new Function('fixtureStore', 'document', `return ${expression}`)(store, document) }
    new Function('SCENES', 'cdp', 'STORE', 'q', 'sleep', shoot.slice(from, to))(scenes, cdp, 'fixtureStore', JSON.stringify, async () => {})
    await scenes[`settings-${section}`].run()
    assert.equal(asked, section)
    document.querySelector = () => null
    await assert.rejects(scenes[`settings-${section}`].run(), /visible/)
  })
}

test('native scene transitions dismiss menus and return retained pages to work', async () => {
  const from = shoot.indexOf('  const leaveOverlay = async () => {')
  const to = shoot.indexOf('  /* ------------------------------------------------------------ the scenes */', from)
  assert.ok(from >= 0 && to > from)
  const seen = []
  const store = { returnToWork: () => seen.push('work') }
  const document = { dispatchEvent: () => seen.push('dismiss') }
  const cdp = { eval: async expression => new Function('fixtureStore', 'document', `return ${expression}`)(store, document) }
  const leave = new Function('cdp', 'STORE', 'sleep', `${shoot.slice(from, to)}; return leaveOverlay`)(cdp, 'fixtureStore', async () => {})
  await leave()
  assert.deepEqual(seen, ['dismiss', 'work'])
})

test('native Agents scrolls the destination itself to include its shadowed row', () => {
  const from = shoot.indexOf('        const dialog = document.querySelector(\'[data-page-destination="agents"]:not([hidden])\')')
  const to = shoot.indexOf('      })()`)', from)
  assert.ok(from >= 0 && to > from)
  let scrolled = false
  const page = { clientHeight: 700, scrollHeight: 1400, scrollTop: 0, querySelectorAll: () => [], dispatchEvent: () => { scrolled = true } }
  const run = new Function('document', shoot.slice(from, to))
  assert.equal(run({ querySelector: () => page }), true)
  assert.equal(page.scrollTop, page.scrollHeight)
  assert.equal(scrolled, true)
})
