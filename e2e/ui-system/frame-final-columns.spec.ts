import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) {
  test(`final frame columns have no dividing rule in ${theme}`, async ({ page }) => {
    await page.goto(`/preview.html?frame-wall=conversation&theme=${theme}`)
    await page.locator('[data-work-tool="details"]').click()
    const panel = page.locator('[data-frame-region="right"]')
    await expect(panel).toBeVisible()
    expect(await panel.evaluate(element => {
      const style = getComputedStyle(element)
      const after = getComputedStyle(element, '::after')
      return { border: style.borderLeftWidth, rule: after.content }
    })).toEqual({ border: '0px', rule: 'none' })
    await expect(page.locator('[data-topbar="tools"][data-standing]')).toHaveCSS('border-left-width', '0px')
    for (const width of [1100, 720]) {
      await page.setViewportSize({ width, height: 900 })
      const main = page.locator('[data-frame-region="main"]')
      await expect.poll(async () => {
        const body = (await main.boundingBox())!, rail = (await panel.boundingBox())!
        return body.x + body.width <= rail.x
      }).toBe(true)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }
  })
}
