import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) {
  test(`a changed tail wraps visibly inside the narrow Changes pane in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.setViewportSize({ width: 412, height: 1000 })
    await page.goto('/preview.html?compact-panels')
    await page.evaluate(() => document.fonts.ready)
    const pane = page.locator('[data-frame-id="panel-changes"]')
    const table = pane.locator('table').first()
    await expect(table).toHaveAttribute('data-wrap', '')
    for (const word of ['before', 'after']) {
      const changed = table.locator('[data-changed-word]').filter({ hasText: word })
      await expect(changed).toHaveText(word)
      const reading = await changed.evaluate(node => {
        const cell = node.closest('td')!, row = cell.parentElement!
        const pane = node.closest('[data-frame-id]')!, box = pane.getBoundingClientRect()
        const range = document.createRange()
        range.selectNodeContents(node)
        const rects = [...range.getClientRects()]
        const wholeLine = document.createRange()
        wholeLine.selectNodeContents(cell)
        return {
          wrapped: new Set([...wholeLine.getClientRects()].map(rect => rect.top)).size > 1,
          inside: rects.every(rect => rect.left >= box.left && rect.right <= box.right),
          band: getComputedStyle(node).backgroundColor,
          ground: getComputedStyle(row).backgroundColor,
          fits: tableWidth(cell.closest('table')!),
        }
        function tableWidth(table: HTMLTableElement) { return table.getBoundingClientRect().width <= box.width }
      })
      expect(reading.wrapped).toBe(true)
      expect(reading.inside).toBe(true)
      expect(reading.fits).toBe(true)
      expect(reading.band).not.toBe(reading.ground)
      expect(reading.band).not.toBe('rgba(0, 0, 0, 0)')
    }
    const menu = pane.getByRole('button', { name: 'Diff view options' }).first()
    await menu.click()
    await expect(page.getByRole('menuitemcheckbox', { name: 'Word wrap', exact: true })).toHaveAttribute('aria-checked', 'true')
    await page.getByRole('menuitemcheckbox', { name: 'Word wrap', exact: true }).click()
    await expect(table).not.toHaveAttribute('data-wrap', '')
    await page.keyboard.press('Escape')
    await menu.click()
    await page.getByRole('menuitemcheckbox', { name: 'Highlight changed words', exact: true }).click()
    await expect(table.locator('[data-changed-word]')).toHaveCount(0)
  })
}
