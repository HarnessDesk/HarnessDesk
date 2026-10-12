import { expect, test } from '@playwright/test'
import { openWallDestination } from './frame-wall-actions'

for (const theme of ['light', 'dark'] as const) {
  test(`final context facts contain recorded finite counts in ${theme}`, async ({ page }) => {
    await page.goto(`/preview.html?frame-wall=conversation&theme=${theme}`)
    await openWallDestination(page, { contextInfo: true })
    const card = page.locator('[data-popup-kind="info-card"]')
    await expect(card).toBeVisible()
    await expect(card).not.toContainText('NaN')
    await expect(card).toContainText('500')
  })
}
