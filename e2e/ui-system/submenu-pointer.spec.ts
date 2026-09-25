import { expect, test, type Page } from '@playwright/test'

import { level, modelControl, pointAtLevel, reasoningRow } from './reasoning-menu'

/*
  A flyout is reached by pointing at it.

  The pointer has to leave a row to reach the flyout that row opened, and for
  a while the flyout did not survive the trip: Base UI answers a row losing
  the pointer by focusing the menu, and the flyout — filed in its floating
  tree with no parent, because the menu around it has no Base UI trigger —
  read that as focus leaving and closed. The composer's reasoning levels could
  not be taken with a mouse at all.

  Where the flyout opens decides how far the pointer travels to it, so these
  hold that too: beside its row when there is room, across it when there is
  not — never above or below it, over the menu's other rows, where the way
  there crosses rows that take the flyout's place. They drive a real pointer
  from where a hand rests on the row, out of it and on to a level.
*/

const low = (page: Page) => level(page, /^Low/)

async function openModelMenu(page: Page, width: number) {
  await page.setViewportSize({ width, height: 800 })
  await page.goto('/preview.html')
  const trigger = modelControl(page)
  await trigger.scrollIntoViewIfNeeded()
  // Where the app has it: the composer at the foot of the window.
  await trigger.evaluate((node) => window.scrollBy(0, node.getBoundingClientRect().bottom - (window.innerHeight - 24)))
  await trigger.click()
  await expect(reasoningRow(page)).toBeVisible()
}

/** Rest on the row near its value — where the eye reads the current level — until the flyout opens. */
async function restOnRow(page: Page) {
  const row = (await reasoningRow(page).boundingBox())!
  const at = { x: row.x + row.width - 40, y: row.y + row.height / 2 }
  await page.mouse.move(at.x, at.y - 30)
  await page.mouse.move(at.x, at.y, { steps: 4 })
  await expect(reasoningRow(page)).toHaveAttribute('data-popup-open', '')
  return at
}

for (const width of [1440, 600, 375]) {
  test(`a reasoning level is taken by pointing at it at ${width}px`, async ({ page }, testInfo) => {
    await openModelMenu(page, width)
    const rest = await restOnRow(page)
    await expect(low(page)).toBeVisible()
    const placed = await low(page).evaluate((node) => {
      const flyout = node.closest('[data-slot="dropdown-menu-sub-content"]')!.getBoundingClientRect()
      const row = [...document.querySelectorAll('[role="menuitem"]')]
        .find((item) => /^Reasoning effort/.test(item.textContent ?? ''))!
        .getBoundingClientRect()
      return {
        side: node.closest('[data-side]')?.getAttribute('data-side'),
        flyout: { top: flyout.top, bottom: flyout.bottom, left: flyout.left, right: flyout.right },
        row: { top: row.top, bottom: row.bottom, left: row.left, right: row.right },
      }
    })
    await testInfo.attach('placement', { body: JSON.stringify(placed, null, 2), contentType: 'application/json' })
    // Beside the row or across it: the flyout spans the row's height.
    expect(placed.side === 'left' || placed.side === 'right', `the flyout opened ${placed.side}`).toBe(true)
    expect(placed.flyout.top).toBeLessThanOrEqual(placed.row.top + 1)
    expect(placed.flyout.bottom).toBeGreaterThanOrEqual(placed.row.bottom - 1)

    // Out of the row — the step that used to close the flyout — and on to
    // the level.
    await pointAtLevel(page, rest, /^Low/)
    await expect(low(page)).toBeVisible()
    await page.mouse.down()
    await page.mouse.up()

    await expect(reasoningRow(page)).toBeHidden()
    await expect.poll(() => modelControl(page).evaluate((node) => `${node.textContent} ${node.title}`)).toContain('Low')
  })
}

test('the flyout goes when the pointer takes another row, and no row stays lit when it leaves the menu', async ({ page }) => {
  await openModelMenu(page, 1440)
  const at = await restOnRow(page)
  const manage = page.getByRole('menuitem', { name: /^Manage models/ })
  const below = (await manage.boundingBox())!
  await page.mouse.move(at.x, below.y + below.height / 2, { steps: 6 })
  await expect(reasoningRow(page)).not.toHaveAttribute('data-popup-open', '')
  await expect(low(page)).toBeHidden()
  await expect(manage).toBeFocused()

  // Back onto the row, then out of the menu along the row itself, away from
  // the flyout — no other row is crossed that would take the focus on its
  // own — and the row it belonged to is not left looking chosen.
  await page.mouse.move(at.x, at.y, { steps: 6 })
  await expect(reasoningRow(page)).toHaveAttribute('data-popup-open', '')
  await expect(reasoningRow(page)).toBeFocused()
  const side = await low(page).evaluate((node) => node.closest('[data-side]')?.getAttribute('data-side'))
  const menu = (await page.locator('[data-slot="dropdown-menu-popup"]').boundingBox())!
  const away = side === 'right' ? menu.x - 60 : menu.x + menu.width + 60
  await page.mouse.move(away, at.y, { steps: 16 })
  await expect(low(page)).toBeHidden()
  await expect(reasoningRow(page)).not.toBeFocused()
  await expect(reasoningRow(page)).not.toHaveAttribute('data-highlighted', '')
})
