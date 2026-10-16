import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) {
  test(`the rail shares the bar and the pane has its own full-height column in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 })
    await page.goto(`/preview.html?frame-wall=conversation&theme=${theme}`)
    await page.locator('[data-work-tool="changes"]').click()
    const pane = page.locator('[data-frame-region="right"]')
    const rail = page.locator('[data-frame-region="rail"]')
    const bar = page.locator('[data-frame-region="top"]')
    await expect(pane).toBeVisible()
    const [p, r, b] = await Promise.all([pane.boundingBox(), rail.boundingBox(), bar.boundingBox()])
    expect(p!.y).toBe(0)
    expect(p!.height).toBe(900)
    expect(r!.y).toBe(b!.y + b!.height)
    expect(b!.x + b!.width).toBe(p!.x)
    await expect(pane).toHaveCSS('border-left-width', '1px')
    await expect(page.locator('[data-work-pane-header]')).toHaveCSS('height', '40px')
    await page.setViewportSize({ width: 720, height: 900 })
    await expect(page.locator('[data-slot="fixed-shell"]')).toHaveAttribute('data-panel-floats', 'true')
    await expect(page.locator('[data-frame-region="main"]')).toBeHidden()
    await expect.poll(() => pane.boundingBox()).toEqual({ x: 0, y: 0, width: 720, height: 900 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}
