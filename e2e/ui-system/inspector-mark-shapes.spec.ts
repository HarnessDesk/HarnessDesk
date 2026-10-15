import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) {
  test(`an unnamed runtime keeps its event tile square in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    // Exercise Activity's existing fallback with the same synthetic audit rows.
    await page.route('**/src/components/Activity.tsx*', async route => {
      const response = await route.fetch()
      const source = await response.text()
      expect(source).toContain('const info = infoOf(row.runtime)')
      await route.fulfill({ response, body: source.replace('const info = infoOf(row.runtime)', 'const info = null') })
    })
    await page.goto('/preview.html?compact-panels')
    const frame = page.locator('[data-frame-id="panel-activity"]')
    const tiles = frame.locator('[data-slot="inspector-row-mark"] > [data-shape="square"]')
    await expect(tiles.first()).toBeVisible()
    if (process.env.INSPECTOR_FRAMES) {
      await page.evaluate(() => document.fonts.ready)
      await frame.screenshot({ path: `${process.env.INSPECTOR_FRAMES}/activity-${theme}.png` })
    }
    for (const faces of ['round', 'square']) {
      await page.locator('body').evaluate((body, faces) => body.setAttribute('data-hd-faces', faces), faces)
      for (const tile of await tiles.all()) await expect(tile).toHaveCSS('border-radius', '6px')
    }
  })
}
