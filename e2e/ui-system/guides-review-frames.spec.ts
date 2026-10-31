import path from 'node:path'

import { expect, test, type FrameLocator } from '@playwright/test'

import { installFramePreviewFixture } from './frame-preview-fixture'
import { WALL_TIME } from './frame-wall-destinations'

// The iframe loads asynchronously; give its scene steps their own deadline once they start.
const waitForScene = async (frame: FrameLocator) => {
  await expect(frame.locator('html')).toHaveAttribute('data-scene-steps', /^(running|done|failed)$/, { timeout: 15_000 })
  await expect(frame.locator('html')).toHaveAttribute('data-scene-steps', 'done', { timeout: 15_000 })
}

// Opt in to the controlled delay; adding it to a cold CI server would compound its load.
if (process.env.GUIDES_DELAY_REGRESSION === '1' && process.env.UI_SYSTEM_SERVER !== 'static') test('a slow iframe startup does not consume the scene steps deadline', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.clock.setFixedTime(WALL_TIME)
  await installFramePreviewFixture(page)
  let delayed = false
  await page.route('**/src/preview/main.tsx*', async route => {
    delayed = true
    await new Promise(resolve => setTimeout(resolve, 10_500))
    await route.continue()
  })
  await page.addInitScript(() => {
    if (!new URLSearchParams(location.search).has('steps')) return
    const raf = window.requestAnimationFrame.bind(window)
    window.requestAnimationFrame = callback => raf(time => { setTimeout(() => callback(time), 500) })
  })
  await page.goto('/review.html?themes=light&guides=lines&scene=conversation-details-no-background')
  const frame = page.frameLocator('iframe[title="Details, no background list (light)"]')
  await waitForScene(frame)
  expect(delayed).toBe(true)
  await expect(frame.locator('[aria-label="Conversation facts"]')).toBeVisible()
})

for (const theme of ['light', 'dark'] as const) {
  test(`review board reports the measured Details frame in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 })
    await page.emulateMedia({ colorScheme: theme })
    await page.clock.setFixedTime(WALL_TIME)
    await installFramePreviewFixture(page)
    await page.goto(`/review.html?themes=${theme}&guides=lines&scene=conversation-details-no-background`)
    const frame = page.frameLocator(`iframe[title="Details, no background list (${theme})"]`)
    await waitForScene(frame)
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
    const facts = frame.locator('[aria-label="Conversation facts"]')
    await expect(facts).toBeVisible()
    await expect(facts).not.toHaveText('')
    const recordedFacts = (await facts.textContent())!
    await expect(frame.locator('[data-slot="empty-state"]')).toHaveCount(0)
    if (process.env.REVIEW_BOARD_FRAMES) await page.screenshot({ path: path.join(process.env.REVIEW_BOARD_FRAMES, `board-${theme}-as-is.png`), animations: 'disabled' })
    await page.getByRole('radio', { name: 'fixed', exact: true }).click()
    await expect(scene.getByText(/\d+ fixed/)).toBeVisible()
    await expect(facts).toHaveText(recordedFacts)
    await expect(frame.locator('[data-slot="empty-state"]')).toHaveCount(0)
    await check()
    if (process.env.REVIEW_BOARD_FRAMES) await page.screenshot({ path: path.join(process.env.REVIEW_BOARD_FRAMES, `board-${theme}-fixed.png`), animations: 'disabled' })
    await page.getByRole('radio', { name: 'as is', exact: true }).click()
    await expect(scene.getByText(/\d+ fixed/)).toHaveCount(0)
    await expect(facts).toHaveText(recordedFacts)
    await expect(frame.locator('[data-slot="empty-state"]')).toHaveCount(0)
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
