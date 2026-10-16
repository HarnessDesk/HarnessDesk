import path from 'node:path'

import { expect, test } from '@playwright/test'

import { installFramePreviewFixture } from './frame-preview-fixture'
import { WALL_TIME } from './frame-wall-destinations'

for (const theme of ['light', 'dark'] as const) {
  test(`review board reports the measured Details frame in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 })
    await page.emulateMedia({ colorScheme: theme })
    await page.clock.setFixedTime(WALL_TIME)
    await installFramePreviewFixture(page)
    await page.goto(`/review.html?themes=${theme}&guides=lines&scene=conversation-details-no-background`)
    const frame = page.frameLocator(`iframe[title="Details, no background list (${theme})"]`)
    await expect(frame.locator('html')).toHaveAttribute('data-scene-steps', 'done', { timeout: 15_000 })
    const scene = page.locator(`[data-scene="conversation-details-no-background"][data-theme="${theme}"]`)
    const measured = async () => frame.locator('body').evaluate(() => {
      const report = (window as any).__hdGuides.current
      return report.reduce((all: number[], one: any) => all.map((n, i) => n + one[['offLine', 'overflow', 'offScale'][i]].length), [0, 0, 0]) as number[]
    })
    const check = async () => {
      await expect.poll(async () => {
        const [lines, overflow, scale] = await measured()
        return scene.getByText(`${lines} off-line · ${overflow} overflow · ${scale} off-scale`, { exact: true }).count()
      }).toBe(1)
    }
    await check()
    if (process.env.REVIEW_BOARD_FRAMES) await page.screenshot({ path: path.join(process.env.REVIEW_BOARD_FRAMES, `board-${theme}-as-is.png`), animations: 'disabled' })
    await page.getByRole('radio', { name: 'fixed', exact: true }).click()
    await expect(scene.getByText(/\d+ fixed/)).toBeVisible()
    await expect(frame.locator('[data-slot="empty-state"]').first()).toHaveCSS('padding-left', '12px')
    await expect.poll(async () => frame.locator('body').evaluate(() =>
      (window as any).__hdGuides.current.flatMap((one: any) => one.overflow).some((one: string) => one.includes('"Nothing to list" touches frame')),
    )).toBe(false)
    await check()
    if (process.env.REVIEW_BOARD_FRAMES) await page.screenshot({ path: path.join(process.env.REVIEW_BOARD_FRAMES, `board-${theme}-fixed.png`), animations: 'disabled' })
    await page.getByRole('radio', { name: 'as is', exact: true }).click()
    await expect(scene.getByText(/\d+ fixed/)).toHaveCount(0)
    await expect(frame.locator('[data-slot="empty-state"]').first()).not.toHaveAttribute('style', /padding/)
    // Appearance changes leave the scene mounted: the guides must follow the
    // new palette without a pointer move, resize, or remount.
    await frame.locator('body').evaluate(() => {
      const stroke = CanvasRenderingContext2D.prototype.strokeRect
      CanvasRenderingContext2D.prototype.strokeRect = function (...args) {
        ;(window as any).__guideEdge = this.strokeStyle
        stroke.apply(this, args)
      }
      document.body.dataset.hdPalette = 'shadcn'
      document.body.dataset.hdAccent = 'violet'
      document.body.dataset.hdCorners = 'square'
      document.body.dataset.hdInterface = 'studio'
    })
    await expect.poll(async () => frame.locator('body').evaluate(() => {
      const ctx = document.createElement('canvas').getContext('2d')!
      ctx.strokeStyle = getComputedStyle(document.body).getPropertyValue('--hd-accent').trim()
      return (window as any).__guideEdge === ctx.strokeStyle
    })).toBe(true)
    await check()
    if (process.env.REVIEW_BOARD_FRAMES) await page.screenshot({ path: path.join(process.env.REVIEW_BOARD_FRAMES, `board-${theme}-appearance.png`), animations: 'disabled' })
  })
}
