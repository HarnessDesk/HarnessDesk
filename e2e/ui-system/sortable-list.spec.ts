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
  // The last row's lower half: the line is drawn under it, where the row lands.
  await page.mouse.move(to.x + to.width / 2, to.y + to.height * 0.75, { steps: 8 })
  // One more nudge in place, so the last drag-over is read at the resting point.
  await page.mouse.move(to.x + to.width / 2 + 1, to.y + to.height * 0.75)
  await expect(rows.nth(2)).toHaveAttribute('data-drop', 'after')
  const line = await rows.nth(2).evaluate((node) => {
    const mark = getComputedStyle(node, '::before')
    return { bottom: mark.bottom, top: mark.top, content: mark.content }
  })
  expect(line.content).not.toBe('none')
  expect(line.bottom).toBe('-1px')
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

/** Drag the row at `from` over the `half` of the row at `over`, and read where the line is drawn. */
const dragOver = async (page: Page, from: number, over: number, half: 'upper' | 'lower') => {
  const rows = list(page).locator('[data-slot="sortable-row"]')
  await rows.nth(from).hover()
  const grip = await rows.nth(from).locator('[data-slot="sortable-handle"]').boundingBox()
  const target = await rows.nth(over).boundingBox()
  if (!grip || !target) throw new Error('no boxes')
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await page.mouse.down()
  await page.mouse.move(grip.x + 6, grip.y + grip.height / 2 + 4, { steps: 4 })
  const y = target.y + target.height * (half === 'upper' ? 0.25 : 0.75)
  await page.mouse.move(target.x + target.width / 2, y, { steps: 8 })
  await page.mouse.move(target.x + target.width / 2 + 1, y)
  return rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-drop')))
}

test('the line shows where a row will land, dragging down and dragging up', async ({ page }) => {
  await page.goto('/design.html?view=queue')
  // Down: the first row over the second's lower half lands between the second
  // and the third, so the line is above the third — not above the second.
  expect(await dragOver(page, 0, 1, 'lower')).toEqual([null, null, 'before'])
  await page.mouse.up()
  expect(await order(page)).toEqual(['Then write the release note', 'Run the focused tests again', 'Open a pull request'])

  // Up: the last row over the first's upper half lands first, the line above it.
  expect(await dragOver(page, 2, 0, 'upper')).toEqual(['before', null, null])
  await page.mouse.up()
  expect(await order(page)).toEqual(['Open a pull request', 'Then write the release note', 'Run the focused tests again'])

  // Over its own place, nothing would change, and nothing is drawn.
  expect(await dragOver(page, 1, 1, 'upper')).toEqual([null, null, null])
  await page.mouse.up()
  expect(await order(page)).toEqual(['Open a pull request', 'Then write the release note', 'Run the focused tests again'])
})

test('Space picks a row up, the arrows carry it, and focus and the words follow it', async ({ page }) => {
  await page.goto('/design.html?view=queue')
  const handle = page.getByRole('button', { name: 'Move “Run the focused tests again”' })
  await handle.focus()
  await page.keyboard.press('Space')
  await expect(handle).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('ArrowDown')
  await expect(handle).toBeFocused()
  await expect(said(page)).toHaveText('Moved “Run the focused tests again” to position 2 of 3')
  await page.keyboard.press('Space')
  await expect(handle).toHaveAttribute('aria-pressed', 'false')
  expect(await order(page)).toEqual(['Then write the release note', 'Run the focused tests again', 'Open a pull request'])
})
