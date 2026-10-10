import { expect, test } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'

/** Shell migration preserves title readability at the supported desktop
 * minimum (main.mjs minWidth720), with every fixed tool still visible. */

test('the conversation title keeps at least 10 characters and the header never overflows at the minimum desktop width', async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 800 })
  await page.goto('/preview.html?frame-wall=conversation')
  await page.evaluate(async () => { await document.fonts.ready })
  await page.waitForTimeout(300)

  const bar = page.locator('[data-slot="top-bar"]').locator('..')
  await expect(bar).toBeVisible()
  await expect(bar.locator('[data-work-tool]')).toHaveCount(4)
  // The sidebar's fixed narrow-window fold lands in Task 8. Exercise the
  // existing explicit-away state here so this checks the real lead controls.
  await page.getByRole('button', { name: 'Hide sidebar', exact: true }).click()
  await expect(bar.getByRole('button', { name: /^(Show|Hide) sidebar$/ })).toBeVisible()

  const measured = await bar.evaluate((el) => {
    const title = el.querySelector('[data-topbar-title] > *') as HTMLElement | null
    if (!title) throw new Error('no shell title in the header')
    const cs = getComputedStyle(title)
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')!
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
    const text = title.textContent ?? ''
    const width = title.getBoundingClientRect().width
    let fit = 0
    for (let index = 0; index < text.length; index += 1) {
      if (ctx.measureText(text.slice(0, index + 1)).width > width) break
      fit = index + 1
    }
    return { fit, width, overflow: el.scrollWidth - el.clientWidth }
  })

  expect(measured.fit).toBeGreaterThanOrEqual(10)
  expect(measured.width).toBeGreaterThanOrEqual(FRAME.bar.titleMin)
  expect(measured.overflow).toBeLessThanOrEqual(0)
})

test('a wide window keeps one state beside the title and ceiling facts out of the bar', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/preview.html?frame-wall=conversation')
  await page.evaluate(async () => { await document.fonts.ready })
  await page.waitForTimeout(300)

  const bar = page.locator('[data-slot="top-bar"]').locator('..')
  await expect(bar.locator('[data-topbar="state"]')).toBeVisible()
  await expect(bar.locator('[data-slot="ceiling-wrap"]')).toHaveCount(0)
  await expect(bar.locator('[data-work-tool]')).toHaveCount(4)
  await expect(bar.locator('[data-slot="top-bar"]')).toHaveAttribute('data-fold', '0')

  const overflow = await bar.evaluate((el) => el.scrollWidth - el.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})
