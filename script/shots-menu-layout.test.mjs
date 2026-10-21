import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'

const { JSDOM } = createRequire(new URL('../packages/ui/package.json', import.meta.url))('jsdom')
const source = readFileSync(new URL('./shots/shoot.mjs', import.meta.url), 'utf8')
const start = source.indexOf('        const leaving = (node) =>')
const end = source.indexOf('        return faults', start)
assert.ok(start >= 0 && end > start)
const check = new Function('document', 'visible', 'getComputedStyle', 'innerWidth', 'innerHeight', 'faults', source.slice(start, end))

const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height, toJSON() { return { left, top, width, height } } })
const sample = () => {
  // Base UI may mount its submenu portal inside the root Popover. Its rows
  // belong to the flyout's painted box, not to that DOM ancestor's box.
  const dom = new JSDOM('<div data-slot="popover-popup"><button role="menuitem">Accounts</button><div data-slot="dropdown-menu-sub-content"><button role="menuitem">Review account</button></div></div>')
  const document = dom.window.document
  const root = document.querySelector('[data-slot="popover-popup"]')
  const flyout = document.querySelector('[data-slot="dropdown-menu-sub-content"]')
  const [parentRow, childRow] = document.querySelectorAll('[role="menuitem"]')
  for (const [element, box] of [[root, rect(20, 20, 200, 80)], [parentRow, rect(24, 24, 192, 30)], [flyout, rect(220, 24, 240, 180)], [childRow, rect(224, 28, 232, 30)]]) {
    element.getBoundingClientRect = () => box
    Object.defineProperties(element, { scrollWidth: { value: box.width }, scrollHeight: { value: box.height } })
  }
  document.elementFromPoint = x => x < 220 ? parentRow : childRow
  return { document, flyout, childRow, close: () => dom.window.close() }
}
const faultsOf = ({ document }) => {
  const faults = []
  check(document, () => true, () => ({ opacity: '1' }), 800, 600, faults)
  return faults
}

test('native layout checks account flyout rows against their own surface', t => {
  const page = sample()
  t.after(page.close)
  assert.deepEqual(faultsOf(page), [])
})

test('native layout still rejects a flyout row outside its own content', t => {
  const page = sample()
  t.after(page.close)
  page.childRow.getBoundingClientRect = () => rect(480, 28, 232, 30)
  assert.ok(faultsOf(page).some(fault => fault.includes('clipped outside popup: Review account')))
})

test('native layout checks flyouts against the viewport too', t => {
  const page = sample()
  t.after(page.close)
  page.flyout.getBoundingClientRect = () => rect(700, 24, 240, 180)
  assert.ok(faultsOf(page).some(fault => fault.includes('popup extends outside the viewport')))
})

test('native layout still rejects a covered flyout row', t => {
  const page = sample()
  t.after(page.close)
  page.document.elementFromPoint = () => page.document.body
  assert.ok(faultsOf(page).some(fault => fault.includes('menu item cannot receive a pointer: Review account')))
})
