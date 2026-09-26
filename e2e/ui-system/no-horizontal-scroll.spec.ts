import { expect, test } from '@playwright/test'

/**
 * The catalogue used to open 342px wider than a 1440px window and scroll
 * sideways on every view — the top knob bar was one `nowrap` row, and
 * Foundation alone carries six settings. The bar now wraps, but a wrap that
 * regresses to `nowrap` would bring the scrollbar back just as silently.
 * (A specimen wider than its column scrolls inside the page body instead,
 * which this does not see.) This holds the floor: the
 * document is never wider than the window it is in, at the two widths the
 * window actually opens at and the one it should still work down to.
 */
const VIEWS = ['foundation', 'row', 'conversation'] as const
const WIDTHS = [1440, 1280] as const

for (const width of WIDTHS) {
  for (const view of VIEWS) {
    test(`design.html does not scroll sideways at ${width}px on the ${view} view`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`/design.html?view=${view}`)
      await page.waitForLoadState('networkidle')
      const { scrollWidth, innerWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }))
      expect(scrollWidth).toBeLessThanOrEqual(innerWidth)
    })
  }
}

test('the knob bar still wraps rather than scrolling at 1024px, the narrowest width it is asked to work at', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 })
  await page.goto('/design.html?view=foundation')
  await page.waitForLoadState('networkidle')
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }))
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth)
})
