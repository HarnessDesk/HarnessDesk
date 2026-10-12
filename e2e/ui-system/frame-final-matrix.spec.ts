import { expect, test } from '@playwright/test'
import { applyPageFrameActions } from './frame-page-actions'

for (const theme of ['light', 'dark'] as const) {
  {

for (const [item0, width] of ([1440, 1100, 720]).entries()) test((`final Library matrix keeps every column visible in ${theme}`) + ' [item ' + [item0].join('-') + ']', async ({ page }) => {

await page.setViewportSize({ width, height: 900 })
await page.goto(`/preview.html?frame-wall=library&theme=${theme}`)
await applyPageFrameActions(page, { pageWidth: 'wide', bodyChoice: { label: 'How to show the library', value: 'matrix', item: 'Matrix' } })
const matrix = page.locator('[data-slot="library-matrix"]')
await expect(matrix).toBeVisible()
const container = matrix.locator('[data-slot="table-container"]')
expect(await container.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
const headers = matrix.locator('thead th')
expect(await headers.count()).toBeGreaterThan(1)
const bounds = (await matrix.boundingBox())!
for (const header of await headers.all()) {
        const box = (await header.boundingBox())!
        expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1)
      }
await applyPageFrameActions(page, { expandLibraryEntry: true })
expect(await container.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)


})
}
}
