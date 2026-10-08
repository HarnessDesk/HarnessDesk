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
  test(`verdict, composer and a Browser tile keep their own space in ${theme}`, async ({ page }) => {
    await page.goto('/preview.html?comparison-verdict=combined')
    await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
    const frame = page.locator('[data-frame-id="comparison-combined"]')
    await expect(frame.locator('[data-slot="comparison-notice"]')).toContainText('picked Attempt A')
    for (const width of [1200, 841]) {
      await frame.locator('[data-side-by-side-container]').evaluate((node, px) => { node.style.width = `${px}px` }, width)
      const tiles = frame.locator('[data-slot="side-by-side-tile"]')
      await expect(tiles.nth(0).getByRole('radio', { name: 'Browser', exact: true })).toHaveAttribute('aria-checked', 'true')
      await expect(tiles.nth(0).locator(':scope > header')).toContainText('Picked')
      await expect(tiles.nth(1).locator(':scope > header')).toContainText('Not kept')
      await expect(tiles.nth(0).locator('iframe')).toBeVisible()
      const dock = frame.locator('[data-shared-composer]')
      await expect(dock.locator('textarea')).toBeVisible()
      const geometry = () => frame.evaluate(node => {
        const box = (selector: string) => node.querySelector(selector)!.getBoundingClientRect()
        const shelf = box('[data-slot="comparison-notice-slot"]')
        const grid = box('[data-slot="side-by-side-grid"]')
        const dock = box('[data-shared-composer]')
        const browser = box('[data-slot="side-by-side-tile"] [data-mode="browser"]')
        return { shelfBottom: shelf.bottom, gridTop: grid.top, dockTop: dock.top, browserBottom: browser.bottom }
      })
      await expect.poll(async () => (await geometry()).browserBottom - (await geometry()).dockTop).toBeLessThanOrEqual(1)
      expect((await geometry()).shelfBottom).toBeLessThanOrEqual((await geometry()).gridTop)
    }
    const gridY = (await frame.locator('[data-slot="side-by-side-grid"]').boundingBox())!.y
    await frame.getByRole('button', { name: 'Dismiss verdict' }).click()
    expect((await frame.locator('[data-slot="side-by-side-grid"]').boundingBox())!.y).toBe(gridY)
    await expect(frame.locator('[data-shared-composer] textarea')).toBeVisible()
  })
  test(`a narrow verdict tile keeps its name readable beside an approval in ${theme}`, async ({ page }) => {
    await page.goto('/preview.html?comparison-verdict=approval')
    await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
    const frame = page.locator('[data-frame-id="comparison-approval"]')
    await frame.locator('[data-side-by-side-container]').evaluate(node => { node.style.width = '841px' })
    const beta = frame.locator('[data-slot="side-by-side-tile"]').nth(1)
    const name = beta.locator(':scope > header [data-role="row"]')
    await expect(name).toHaveText('Beta')
    expect(await name.evaluate(node => node.getBoundingClientRect().height <= parseFloat(getComputedStyle(node).lineHeight) + 1)).toBe(true)
    expect(await beta.locator(':scope > header').evaluate(bar => {
      const name = bar.querySelector('[data-role="row"]')!.getBoundingClientRect()
      return [...bar.querySelectorAll('[data-slot="chip"], button')].every(node => {
        const other = node.getBoundingClientRect()
        return name.right <= other.left + 0.5 || name.left >= other.right - 0.5 || name.bottom <= other.top + 0.5 || name.top >= other.bottom - 0.5
      })
    })).toBe(true)
    await expect(beta.locator(':scope > header')).toContainText('Not kept')
    await expect(beta.getByRole('radio', { name: 'Browser', exact: true })).toBeVisible()
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
