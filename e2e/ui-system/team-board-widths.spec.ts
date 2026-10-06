import { expect, test } from '@playwright/test'
import { COLLECT, textReasons } from '../../script/shots/audit.mjs'

for (const theme of ['light', 'dark'] as const) {
  for (const width of [1440, 1000, 900, 760, 640, 560]) {
    test(`board rearranges in a ${width}px pane in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 })
      await page.emulateMedia({ colorScheme: theme })
      await page.goto('/preview.html?board-list')
      const pane = page.locator('[data-frame-id="board-list-page"]')
      await page.evaluate(() => document.fonts.ready)
      expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
      if (process.env.HD_BOARD_WIDTH_FRAMES) await pane.screenshot({ path: `${process.env.HD_BOARD_WIDTH_FRAMES}/${width}-${theme}.png` })
      if (width < 600) {
        const table = pane.getByRole('table', { name: 'Jobs' })
        await expect(table).toHaveAttribute('data-hd-table', 'compact')
        await expect(pane.locator('[data-slot="board-list"]')).toHaveAttribute('data-grouped', 'true')
        await expect(table.locator('[data-state-group]').first()).toContainText('Needs you')
        await expect(table.locator('tbody tr[data-job]')).toHaveCount(4)
        return
      }
      const board = pane.locator('[data-slot="board"]')
      const columns = board.locator('[data-slot="board-column"]:not([data-collapsed])')
      await expect(columns).toHaveCount(width === 1440 ? 5 : width === 900 ? 3 : 4)
      for (const column of await columns.all()) expect((await column.boundingBox())!.width).toBeGreaterThanOrEqual(220)
      expect(await board.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
      if (width <= 760) {
        const needs = await board.locator('[data-column="needs"]').boundingBox()
        const working = await board.locator('[data-column="working"]').boundingBox()
        const review = await board.locator('[data-column="review"]').boundingBox()
        const todo = await board.locator('[data-column="todo"]').boundingBox()
        expect(needs!.y).toBe(working!.y)
        expect(review!.y).toBe(todo!.y)
        expect(review!.y).toBeGreaterThan(needs!.y)
      }
      if (width === 900) await expect(board.getByRole('button', { name: 'Open To do', exact: true })).toBeVisible()
      if (width !== 1440) await expect(board.getByRole('button', { name: 'Open Ready', exact: true })).toBeVisible()
    })
  }
  test(`folded rails open and close in place with the keyboard in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 1000 })
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/preview.html?board-list')
    const pane = page.locator('[data-frame-id="board-list-page"]')
    const ready = pane.locator('[data-column="ready"]')
    const rail = ready.getByRole('button', { name: 'Open Ready', exact: true })
    await rail.focus()
    await rail.press('Enter')
    await expect(ready).not.toHaveAttribute('data-collapsed')
    expect((await ready.boundingBox())!.width).toBeGreaterThanOrEqual(220)
    await expect(pane.locator('[data-slot="board-card"]')).toHaveCount(4)
    await expect(ready.locator('[data-slot="board-card"]')).toBeVisible()
    await expect(pane.locator('[data-column="todo"]')).toHaveAttribute('data-collapsed', 'true')
    expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
    if (process.env.HD_BOARD_WIDTH_FRAMES) await pane.screenshot({ path: `${process.env.HD_BOARD_WIDTH_FRAMES}/opened-${theme}.png` })
    await ready.getByRole('button', { name: 'Fold Ready', exact: true }).press('Enter')
    await expect(rail).toBeVisible()
    await expect(rail).toBeFocused()
    await rail.press('Enter')
    await page.setViewportSize({ width: 1440, height: 1000 })
    await expect(ready.getByRole('button', { name: 'Fold Ready', exact: true })).toHaveCount(0)
  })
  test(`board follows the pane when the window stays wide in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/preview.html?board-list')
    const pane = page.locator('[data-frame-id="board-list-page"]')
    await pane.evaluate(el => { el.style.width = '560px' })
    await expect(pane.getByRole('table', { name: 'Jobs' })).toHaveAttribute('data-hd-table', 'compact')
    await pane.evaluate(el => { el.style.width = '1000px' })
    await expect(pane.locator('[data-slot="board"]')).toBeVisible()
    await expect(pane.getByRole('button', { name: 'Open Ready', exact: true })).toBeVisible()
  })
}
