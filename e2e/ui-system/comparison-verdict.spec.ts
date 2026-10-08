import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) {
  test(`a wrapped recorded sentence scrolls without moving the tiles in ${theme}`, async ({ page }) => {
    await page.goto('/preview.html?comparison-verdict')
    await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
    await page.evaluate(async () => { await document.fonts.ready })
    const frame = page.locator('[data-frame-id="comparison-picked"]')
    await frame.locator('[data-side-by-side-container]').evaluate(node => { node.style.width = '841px' })
    const shelf = frame.locator('[data-slot="comparison-notice-slot"]')
    const grid = frame.locator('[data-slot="side-by-side-grid"]')
    const notice = frame.locator('[data-slot="comparison-notice"]')
    const initialShelf = await shelf.boundingBox()
    const initialGrid = await grid.boundingBox()
    const words = notice.getByRole('status')
    const longReason = `Attempt A keeps ${'the retries and ordering inside the client, '.repeat(40)}and passes the checks.`
    await words.locator('div').last().evaluate((node, text) => { node.textContent = text }, longReason)
    expect((await shelf.boundingBox())!.height).toBe(initialShelf!.height)
    expect((await grid.boundingBox())!.y).toBe(initialGrid!.y)
    await expect(words).toContainText(longReason)
    const scrolls = await words.evaluate(node => {
      node.scrollTop = node.scrollHeight
      return node.scrollHeight > node.clientHeight && node.scrollTop > 0
    })
    expect(scrolls).toBe(true)
    await expect(words).toHaveAttribute('tabindex', '0')
    expect((await notice.boundingBox())!.y + (await notice.boundingBox())!.height).toBeLessThanOrEqual(initialGrid!.y)
    // Removing the reserved track makes the same sentence move the tiles;
    // the geometry assertion must distinguish that old fluid layout.
    await shelf.evaluate(node => { node.style.gridTemplateRows = 'auto' })
    expect((await shelf.boundingBox())!.height).not.toBe(initialShelf!.height)
    await shelf.evaluate(node => { node.style.gridTemplateRows = '' })
    await frame.getByRole('button', { name: 'Dismiss verdict' }).click()
    expect((await shelf.boundingBox())!.height).toBe(initialShelf!.height)
    expect((await grid.boundingBox())!.y).toBe(initialGrid!.y)
  })
  test(`a finished or stopped merge step leaves only its recorded verdict in ${theme}`, async ({ page }) => {
    for (const scene of ['merged', 'stopped']) {
      await page.goto(`/preview.html?comparison-verdict=${scene}`)
      await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
      const notice = page.locator(`[data-frame-id="comparison-${scene}"] [data-slot="comparison-notice"]`)
      await expect(notice).toContainText('picked Attempt A')
      await expect(notice.getByRole('button', { name: 'Merge the picked change' })).toHaveCount(0)
    }
  })
}
