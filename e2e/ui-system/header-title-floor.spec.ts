import { expect, test } from '@playwright/test'

/**
 * The title wins the header's last few pixels (#983 round 2).
 *
 * At a phone's width the ceiling chip and the header's own rule already fold;
 * `.title`'s own floor (`min(9ch, 40%)`) is what keeps the one name in this
 * row readable once they have. Measured with a real canvas against the
 * title's own rendered width — jsdom has no layout to measure — rather than
 * asserted against the fixture's exact string, so a different title still
 * has to clear the same floor.
 */

test('the conversation title keeps at least 10 characters and the header never overflows at a phone width', async ({ page }) => {
  await page.setViewportSize({ width: 340, height: 800 })
  await page.goto('/preview.html')
  await page.evaluate(async () => { await document.fonts.ready })
  await page.waitForTimeout(300)

  const heading = page.locator('h2', { hasText: 'Conversation — the transcript and its composer' })
  await expect(heading).toBeVisible()
  const bar = heading.locator('xpath=following-sibling::*[1]').locator('[data-slot="bar"]')
  await expect(bar).toBeVisible()

  const measured = await bar.evaluate((el) => {
    const title = el.querySelector('span[class*="title_"]') as HTMLElement | null
    if (!title) throw new Error('no title span in the header')
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
    return { fit, overflow: el.scrollWidth - el.clientWidth }
  })

  expect(measured.fit).toBeGreaterThanOrEqual(10)
  expect(measured.overflow).toBeLessThanOrEqual(0)
})

test('a wide window keeps the ceiling chip beside the title, unfolded', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/preview.html')
  await page.evaluate(async () => { await document.fonts.ready })
  await page.waitForTimeout(300)

  const heading = page.locator('h2', { hasText: 'Conversation — the transcript and its composer' })
  const bar = heading.locator('xpath=following-sibling::*[1]').locator('[data-slot="bar"]')
  await expect(bar.locator('[data-slot="ceiling-wrap"]')).toBeVisible()

  const overflow = await bar.evaluate((el) => el.scrollWidth - el.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})
