import { expect, test } from '@playwright/test'
import { installFramePreviewFixture } from './frame-preview-fixture'

for (const theme of ['light', 'dark']) for (const width of [720, 1440]) {
  test(`goal title keeps a readable share beside the rail at ${width} in ${theme}`, async ({ page }) => {
    await installFramePreviewFixture(page)
    await page.setViewportSize({ width, height: 900 })
    await page.goto(`/preview.html?frame-wall=conversation&theme=${theme}`)
    await page.waitForFunction(() => Boolean((window as Window & { __hdFrameWall?: unknown }).__hdFrameWall))
    await page.evaluate(async () => { await document.fonts.ready })
    const rail = page.getByRole('button', { name: 'Toggle rail', exact: true }).first()
    if (await rail.getAttribute('aria-pressed') !== 'true') await rail.click()
    await expect(page.locator('[data-frame-region="rail"]:visible')).toBeVisible()
    const bar = page.locator('[data-slot="alert"]').filter({ has: page.getByRole('button', { name: 'Clear goal', exact: true }) })
    const title = bar.locator('[data-role="row"][title]')
    await expect(title).toHaveText('Fix the worktree list dropping deleted-upstream branches')
    await expect(bar).toContainText('35% of budget')
    await expect(bar).toContainText('in progress')
    await expect.poll(async () => (await title.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(130)
    await expect(bar.getByRole('button', { name: 'Clear goal' })).toBeVisible()
    const geometry = await bar.evaluate(node => {
      const box = node.getBoundingClientRect()
      const parts = [...node.children].map(child => child.getBoundingClientRect())
      return {
        outside: parts.some(part => part.left < box.left || part.right > box.right + 1 || part.bottom > box.bottom + 1),
        overlap: parts.some((part, index) => parts.slice(index + 1).some(other =>
          Math.min(part.right, other.right) > Math.max(part.left, other.left) + 1 &&
          Math.min(part.bottom, other.bottom) > Math.max(part.top, other.top) + 1)),
      }
    })
    expect(geometry).toEqual({ outside: false, overlap: false })
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width)
  })
}
