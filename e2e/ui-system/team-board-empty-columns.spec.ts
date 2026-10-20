import { expect, test } from '@playwright/test'

test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } })

for (const theme of ['light', 'dark'] as const) {
  for (const width of [1280, 720]) test(`finished Team shows all three cards at ${width}px in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 840 })
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/preview.html?finished-board')
    await page.evaluate(() => document.fonts.ready)
    const board = page.locator('[data-slot="board"]')
    await expect(board.locator('[data-slot="board-card"]')).toHaveCount(3)
    if (process.env.HD_EMPTY_BOARD_FRAMES) await page.screenshot({ path: `${process.env.HD_EMPTY_BOARD_FRAMES}/${width}-${theme}.png` })
    await expect(board.locator('[data-collapsed]')).toHaveCount(4)
    const ready = board.locator('[data-column="ready"]')
    const bounds = (await ready.boundingBox())!
    const viewport = (await board.boundingBox())!
    expect(bounds.x).toBeGreaterThanOrEqual(viewport.x)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.x + viewport.width)
    await expect(page.getByRole('tab', { name: 'Tasks 3', exact: true })).toBeVisible()
    for (const rail of await board.getByRole('button', { name: /0 — Open column/ }).all()) {
      await rail.focus()
      await page.keyboard.press('Enter')
      const fold = board.getByRole('button', { name: /^Fold / })
      await expect(fold).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(rail).toBeFocused()
    }
  })

  test(`empty Team keeps one empty state in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/preview.html?finished-board&empty')
    await expect(page.getByText('Nothing on the board yet', { exact: true })).toHaveCount(1)
    await expect(page.locator('[data-slot="board-column"]')).toHaveCount(0)
  })

  test(`overflowing columns advertise scrolling before a gesture in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 720, height: 840 })
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/preview.html?board-list')
    const board = page.locator('[data-slot="board"]')
    expect(await board.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true)
    const thumb = () => board.evaluate(el => getComputedStyle(el, '::-webkit-scrollbar-thumb').backgroundColor)
    expect(await thumb()).not.toBe('rgba(0, 0, 0, 0)')
    if (process.env.HD_EMPTY_BOARD_FRAMES) await page.screenshot({ path: `${process.env.HD_EMPTY_BOARD_FRAMES}/overflow-${theme}.png` })
    await board.evaluate(el => { el.scrollLeft = el.scrollWidth })
    await expect(board.locator('[data-column="ready"]')).toBeInViewport()
  })
}
