import { expect, test, type Page } from '@playwright/test'

/*
  A flyout answers the keys of the menu it opens from.

  The composer's "Reasoning effort" row opens a flyout from a vertical menu,
  so ↑ and ↓ move between the menu's rows, → steps into the flyout onto its
  first level, and Escape inside the flyout closes it and puts focus back on
  the row. Each of those went wrong, for one reason: the menu around the row
  is a Base UI Menu.Root with no Menu.Trigger, so the flyout has no parent in
  Base UI's floating tree. With no parent to ask which way the menu runs, ↓
  opened the flyout instead of moving on and → opened it without stepping in;
  and Escape let focus fall out of the closing (inert) flyout onto the
  Popover's own panel, so ← and → then did nothing at all.
*/

const modelControl = (page: Page) => page.locator('button[title$="odel and reasoning"]')
const reasoningRow = (page: Page) => page.getByRole('menuitem', { name: /^Reasoning effort/ })
const manageModels = (page: Page) => page.getByRole('menuitem', { name: /^Manage models/ })
const level = (page: Page, name: RegExp) => page.getByRole('menuitemradio', { name })

async function openFromTheKeyboard(page: Page) {
  await page.setViewportSize({ width: 1440, height: 800 })
  await page.goto('/preview.html')
  const trigger = modelControl(page)
  await trigger.scrollIntoViewIfNeeded()
  await trigger.evaluate((node) => window.scrollBy(0, node.getBoundingClientRect().bottom - (window.innerHeight - 24)))
  await trigger.focus()
  await page.keyboard.press('Enter')
  await expect(reasoningRow(page)).toBeVisible()
  // ↓ into the menu and down its rows to "Reasoning effort".
  for (let step = 0; step < 12; step += 1) {
    if (await reasoningRow(page).evaluate((node) => node === document.activeElement)) return
    await page.keyboard.press('ArrowDown')
  }
  await expect(reasoningRow(page)).toBeFocused()
}

test('the reasoning row answers the keys of a vertical menu', async ({ page }) => {
  await openFromTheKeyboard(page)

  // ↓ moves on to the next row and leaves the flyout shut; ↑ comes back.
  await page.keyboard.press('ArrowDown')
  await expect(manageModels(page)).toBeFocused()
  await expect(level(page, /^Low/)).toBeHidden()
  await page.keyboard.press('ArrowUp')
  await expect(reasoningRow(page)).toBeFocused()

  // → opens the flyout onto its first level, past the note above it.
  await page.keyboard.press('ArrowRight')
  await expect(level(page, /^Low/)).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(level(page, /^Medium/)).toBeFocused()

  // Escape closes the flyout only, and the row has the focus again.
  await page.keyboard.press('Escape')
  await expect(level(page, /^Low/)).toBeHidden()
  await expect(reasoningRow(page)).toBeFocused()
  await expect(modelControl(page)).toHaveAttribute('data-open', '')

  // And the keys still work from there: → back in, Enter takes a level.
  await page.keyboard.press('ArrowRight')
  await expect(level(page, /^Low/)).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(reasoningRow(page)).toBeHidden()
  await expect.poll(() => modelControl(page).evaluate((node) => `${node.textContent} ${node.title}`)).toContain('Low')
})

test('Escape after pointing into the flyout gives the row back to the keyboard', async ({ page }) => {
  await openFromTheKeyboard(page)
  const row = (await reasoningRow(page).boundingBox())!
  const rest = { x: row.x + row.width - 40, y: row.y + row.height / 2 }
  await page.mouse.move(rest.x, rest.y - 30)
  await page.mouse.move(rest.x, rest.y, { steps: 4 })
  await expect(reasoningRow(page)).toHaveAttribute('data-popup-open', '')
  const low = (await level(page, /^Low/).boundingBox())!
  await page.mouse.move(low.x + 40, low.y + low.height / 2, { steps: 12 })
  await expect(level(page, /^Low/)).toBeFocused()

  await page.keyboard.press('Escape')
  await expect(level(page, /^Low/)).toBeHidden()
  await expect(reasoningRow(page)).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(level(page, /^Low/)).toBeFocused()
})

test('↓ from a row whose flyout the pointer opened moves on and closes it', async ({ page }) => {
  await openFromTheKeyboard(page)
  const row = (await reasoningRow(page).boundingBox())!
  const rest = { x: row.x + row.width - 40, y: row.y + row.height / 2 }
  await page.mouse.move(rest.x, rest.y - 30)
  await page.mouse.move(rest.x, rest.y, { steps: 4 })
  await expect(reasoningRow(page)).toHaveAttribute('data-popup-open', '')
  await expect(reasoningRow(page)).toBeFocused()

  await page.keyboard.press('ArrowDown')
  await expect(manageModels(page)).toBeFocused()
  await expect(level(page, /^Low/)).toBeHidden()
})
