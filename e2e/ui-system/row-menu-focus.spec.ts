import { expect, test, type Page } from '@playwright/test'

/*
  Escape from a conversation row's ⋯ menu gives the focus back to the row.

  The ⋯ opens a context menu. The menu takes the focus into its popup, outside
  the row, and a keyboard user who leaves it with Escape expects to be where
  they were, on the ⋯, with the list around it. Until #789 the focus was left
  on the page instead: nothing ever asked the ⋯ to take it back, the only
  element the menu tried to focus on the way out was its own popup, already
  gone, and the reader started again from the top of the list.

  The ⋯ is the hard target here. It is `display: none` until its row is
  hovered, holds the focus, or has its menu open, and an element that is not
  displayed refuses the focus. So the focus has to go back while the open menu
  still keeps the ⋯ on screen — the keyboard tests park the pointer away from
  every row, so nothing but that keeps it there. The pointer test goes
  further and moves the pointer off the row right after Escape: once the ⋯
  holds the focus, `:focus-within` is what keeps it on screen, and a fix that
  only worked because the click had left the pointer sitting on the row would
  lose it at that point.

  Each runs with motion reduced and with it left alone, as #797 measured.
*/

const label = 'Draft the 2.5 migration notes after reviewing the sidebar target behavior'
const actions = `Actions for ${label}`

const rowOf = (page: Page) =>
  page.locator('[data-region="session-row"] [data-slot="sidebar-menu-item"]').filter({
    has: page.locator(`button[aria-label="${actions}"]`),
  })

/** What holds the focus, as a person would name it: the page itself, or the control by its label. */
const holder = (page: Page) =>
  page.evaluate(() => {
    const held = document.activeElement
    if (held === null || held === document.body) return 'the page'
    return held.getAttribute('aria-label') ?? held.textContent?.trim() ?? held.tagName.toLowerCase()
  })

/**
 * Escape from the menu that is open, then read where the focus went: once the
 * menu is gone, and again two frames on, so a focus that is taken away after
 * the popup goes is not missed.
 */
async function escapeTheMenu(page: Page) {
  // The control: the focus is in the menu, so Escape has something to give back.
  await expect(page.getByRole('menu').getByRole('menuitem').first()).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect.poll(() => holder(page)).toBe(label)
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  expect(await holder(page)).toBe(label)
}

for (const motion of ['reduce', 'no-preference'] as const) {
  test.describe(`with motion ${motion === 'reduce' ? 'reduced' : 'left alone'}`, () => {
    test.use({ reducedMotion: motion })

    test.beforeEach(async ({ page }) => {
      await page.goto('/preview.html')
      // The control: the setting this block names is the one the page has.
      expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(motion === 'reduce')
      await rowOf(page).scrollIntoViewIfNeeded()
      // No row is hovered until a test says so.
      await page.mouse.move(1400, 0)
    })

    test('a ⋯ opened with the pointer has the focus back after Escape', async ({ page }) => {
      const row = rowOf(page)
      await row.hover()
      await row.locator(`button[aria-label="${actions}"]`).click()
      await escapeTheMenu(page)
      // The row keeps focus after its context menu closes, even when the
      // pointer moves away and the hover-only action disappears.
      await page.mouse.move(1400, 0)
      expect(await holder(page)).toBe(label)
    })

    test('a ⋯ opened from the keyboard has the focus back after Escape', async ({ page }) => {
      const row = rowOf(page)
      await row.locator('[data-slot="sidebar-menu-button"]').focus()
      // The row is the one tab stop now; ContextMenu opens its actions without
      // making the hover-only ⋯ a second stop. Escape returns to the row.
      await page.keyboard.press('ContextMenu')
      await expect(page.getByRole('menu').getByRole('menuitem').first()).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('menu')).toHaveCount(0)
      await expect.poll(() => holder(page)).toBe(label)
    })
  })
}
