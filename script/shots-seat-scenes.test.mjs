import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const shoot = readFileSync(new URL('./shots/shoot.mjs', import.meta.url), 'utf8')
const waitForSnapshot = async (read, accept) => assert.equal(accept(await read()), true)

for (const initialRail of [false, true]) test(`the add-member scene reaches the current Seat action with rail initially ${initialRail ? 'open' : 'closed'}`, async () => {
  const from = shoot.indexOf("    'add-member-agents':")
  const to = shoot.indexOf('\n  })', from)
  assert.ok(from >= 0 && to > from)
  let rail = initialRail, dialog = false
  const document = { querySelector: selector => selector === '[data-work-rail-toggle]'
    ? { getAttribute: () => String(rail) }
    : selector === '[role="dialog"][aria-label="Seat an Agent in this Goal"]' && dialog ? {} : null }
  const fixtureStore = { openTeamRoom: () => {} }
  const cdp = { eval: async expression => new Function('fixtureStore', 'document', `return ${expression}`)(fixtureStore, document) }
  const scene = new Function('clearAgentScenes', 'stageRoom', 'cdp', 'STORE', 'q', 'roomId', 'sleep', 'click', 'waitForSnapshot',
    `return ({${shoot.slice(from, to)}})['add-member-agents']`)(async () => {}, async () => {}, cdp, 'fixtureStore', JSON.stringify,
    'synthetic-team', async () => {}, async label => {
      if (label === 'Toggle rail') { rail = !rail; return true }
      if (label === 'Seat an Agent in this Team' && rail) { dialog = true; return true }
      return false
    }, waitForSnapshot)
  await scene.run()
  assert.equal(rail, true)
  assert.equal(dialog, true)
  assert.equal(scene.expect, 'Seat an Agent in this Goal')
})

for (const initialSection of [false, true]) test(`Seat record facts open both disclosures without closing an already ${initialSection ? 'open' : 'folded'} section`, async () => {
  const from = shoot.indexOf('  const seatRecordSays = async () => {')
  const to = shoot.indexOf("  SCENES['seat-record']", from)
  assert.ok(from >= 0 && to > from)
  let sectionOpen = initialSection, detailsOpen = false
  const scope = '[data-frame-region="right"] [data-slot="tool-section"][aria-label="Seat record"]'
  const document = { querySelector: selector => {
    if (selector === `${scope} [data-slot="tool-section-fold"]`) return { getAttribute: () => String(sectionOpen) }
    if (selector === `${scope} [data-slot="tool-fold"] button`) return { getAttribute: () => String(detailsOpen) }
    if (selector === scope) return { innerText: sectionOpen && detailsOpen ? 'Code reviewer · In storefront · Read only · asked, not enforced' : 'Seat record',
      getBoundingClientRect: () => ({ width: 400, height: sectionOpen ? 360 : 40 }) }
    return null
  } }
  const cdp = { eval: async expression => new Function('document', `return ${expression}`)(document) }
  const [reveal, verify] = new Function('cdp', 'q', 'clickScrolled', 'waitForSnapshot',
    `${shoot.slice(from, to)}; return [typeof revealSeatRecord === 'undefined' ? async () => {} : revealSeatRecord, seatRecordSays]`)(cdp, JSON.stringify,
    async (label, within) => {
      assert.equal(within, scope)
      if (label === 'Seat record') sectionOpen = !sectionOpen
      else if (label === 'Details' && sectionOpen) detailsOpen = !detailsOpen
      else return false
      return true
    }, waitForSnapshot)
  await reveal()
  await verify()
  assert.equal(sectionOpen, true)
  assert.equal(detailsOpen, true)
  await reveal()
  await verify()
  assert.equal(sectionOpen, true)
  assert.equal(detailsOpen, true)
})
