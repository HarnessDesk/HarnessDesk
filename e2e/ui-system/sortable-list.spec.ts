import { expect, test, type Page } from '@playwright/test'

/**
 * A sortable list in the real engine (the queue's rows on the catalogue's
 * queue board): a drag that starts on the handle lands where it is dropped,
 * ⌥↓ moves the focused row one place and keeps focus on it, and each move is
 * said in the list's live region.
 *
 * jsdom has no drag session and no layout, so the drag is measured here.
 */

const list = (page: Page) => page.locator('[data-catalog-case="sortable-list"]')
const order = (page: Page) => list(page).locator('[data-slot="sortable-row"] [data-role="navigation"]').allTextContents()
const said = (page: Page) => page.locator('[data-slot="sortable-announcer"]').first()

test('a drag from the handle moves the row to where it is dropped', async ({ page }) => {
  await page.goto('/design.html?view=queue')
  await expect(list(page)).toBeVisible()
  expect(await order(page)).toEqual(['Run the focused tests again', 'Then write the release note', 'Open a pull request'])

  const rows = list(page).locator('[data-slot="sortable-row"]')
  // The handle draws only under the pointer.
  const handle = rows.nth(0).locator('[data-slot="sortable-handle"]')
  await expect(handle).toHaveCSS('opacity', '0')
  await rows.nth(0).hover()
  await expect(handle).toHaveCSS('opacity', '1')

  const from = await handle.boundingBox()
  const to = await rows.nth(2).boundingBox()
  if (!from || !to) throw new Error('no boxes')
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + from.width / 2 + 4, from.y + from.height / 2 + 6, { steps: 4 })
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 })
  await expect(rows.nth(2)).toHaveAttribute('data-drop', '')
  await page.mouse.up()

  expect(await order(page)).toEqual(['Then write the release note', 'Open a pull request', 'Run the focused tests again'])
  await expect(said(page)).toHaveText('Moved “Run the focused tests again” to position 3 of 3')
})

test('a drag that starts on the text does not move anything', async ({ page }) => {
  await page.goto('/design.html?view=queue')
  const rows = list(page).locator('[data-slot="sortable-row"]')
  const text = await rows.nth(0).locator('[data-role="navigation"]').boundingBox()
  const to = await rows.nth(2).boundingBox()
  if (!text || !to) throw new Error('no boxes')
  await page.mouse.move(text.x + 20, text.y + text.height / 2)
  await page.mouse.down()
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 })
  await page.mouse.up()
  expect(await order(page)).toEqual(['Run the focused tests again', 'Then write the release note', 'Open a pull request'])
})

test('⌥↓ moves the focused row one place, keeps focus on it, and says so', async ({ page }) => {
  await page.goto('/design.html?view=queue')
  const handle = page.getByRole('button', { name: 'Move “Run the focused tests again”' })
  await handle.focus()
  await expect(handle).toHaveCSS('opacity', '1')
  await page.keyboard.press('Alt+ArrowDown')
  expect(await order(page)).toEqual(['Then write the release note', 'Run the focused tests again', 'Open a pull request'])
  await expect(handle).toBeFocused()
  await expect(said(page)).toHaveText('Moved “Run the focused tests again” to position 2 of 3')
  await page.keyboard.press('Alt+ArrowDown')
  await page.keyboard.press('Alt+ArrowDown')
  await expect(said(page)).toHaveText('“Run the focused tests again” is already last')
  await expect(handle).toBeFocused()
})
