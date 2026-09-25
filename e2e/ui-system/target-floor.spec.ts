import { expect, test } from '@playwright/test'

/**
 * Nothing you can press is under the floor.
 *
 * `--hd-target-min` is 24px and the system names it twice — once as itself and
 * once as `--hd-icon-target` — and then shipped three controls below it. Two
 * were literals: a card's whole menu hung off a 20px square written as
 * `size-5`, and a segmented control's pressable part came out at 22 because
 * its 26px trough was padded by two rather than one. The third was five
 * buttons whose stylesheet had been asked to draw a box and had lost it, so
 * the target was the height of its own words — fifteen pixels.
 *
 * A floor that three shipped controls sit under is a number, not a floor, and
 * nothing in the tree could see them: the audit reads *declared* squares and
 * two of these declared one axis or none. This reads what a person's finger
 * actually gets.
 *
 * Read from the page rather than listed here, so a control added tomorrow is
 * measured by the same rule on the day it is written.
 */
test('every target on the page clears the floor', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1200 })
  await page.goto('/preview.html')
  await page.evaluate(async () => { await document.fonts.ready })
  // The preview mounts its screens as their modules resolve; the floor is
  // about boxes, so wait until the boxes stop appearing.
  await expect
    .poll(async () => page.locator('button, a[href], [role="button"], [role="tab"], [role="radio"]').count(), { timeout: 15_000 })
    .toBeGreaterThan(80)
  await page.waitForTimeout(600)

  const { floor, under, counted } = await page.evaluate(() => {
    const probe = document.body.appendChild(document.createElement('div'))
    probe.style.cssText = 'position:absolute;visibility:hidden;height:var(--hd-target-min)'
    const floor = Math.round(probe.getBoundingClientRect().height)
    probe.remove()
    const nodes = [...document.querySelectorAll('button, a[href], [role="button"], [role="tab"], [role="radio"]')]
    const seen = new Map<string, string>()
    for (const node of nodes) {
      const box = node.getBoundingClientRect()
      // A control with no box is hidden, collapsed or not laid out yet; the
      // floor has nothing to say about it.
      if (box.width === 0 || box.height === 0) continue
      if (Math.min(box.width, box.height) >= floor) continue
      const own = (typeof node.className === 'string' ? node.className : '').match(/_([A-Za-z]+)_[a-z0-9]+_\d+/)
      const who = own ? `.${own[1]}` : String(node.className).split(/\s+/).slice(0, 3).join(' ')
      const label = (node.getAttribute('aria-label') ?? node.textContent ?? '').trim().slice(0, 30)
      seen.set(`${who}|${label}`, `${Math.round(box.width)}x${Math.round(box.height)} ${who} "${label}"`)
    }
    return { floor, under: [...seen.values()], counted: nodes.length }
  })

  // The guard on the guard: a page that rendered nothing would pass an empty
  // list, and a floor read as NaN would make every comparison false.
  expect(floor).toBeGreaterThan(0)
  expect(counted).toBeGreaterThan(80)
  expect(under.join('\n') || `every target clears ${floor}px`).toBe(`every target clears ${floor}px`)
})
