import { expect, test } from '@playwright/test'

/**
 * The rail down the left of a transcript, driven rather than described.
 *
 * Its arithmetic is held by `lib/conversation-map.test.ts`, which needs no
 * browser. What only a browser can answer is whether a dash goes where it says
 * it goes — and the first version of this got that wrong in a way no unit test
 * could see: both marks of a turn carried the turn's id, and the transcript put
 * that id only on the wrapper around the whole exchange, so the dash previewing
 * the answer scrolled to the prompt.
 */

const overflow = async (page: import('@playwright/test').Page) => {
  await page.evaluate(() => {
    const scroller = document.querySelector('[class*="scroll_"]') as HTMLElement | null
    if (!scroller) throw new Error('no transcript scroller in the preview')
    scroller.style.height = '150px'
    scroller.style.maxHeight = '150px'
  })
  // The rail watches the scroller with a ResizeObserver; give it its frame.
  await page.waitForTimeout(400)
}

test('a dash goes to the half of the turn it previewed', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 })
  await page.goto('/preview.html')
  await page.evaluate(async () => { await document.fonts.ready })
  await page.waitForTimeout(600)
  await overflow(page)

  const rail = page.locator('nav[aria-label="Jump to a message"]')
  await expect(rail).toBeVisible()
  const marks = rail.getByRole('button')
  await expect(marks).toHaveCount(2)

  for (const [index, part] of [[0, 'prompt'], [1, 'answer']] as const) {
    // Put the scroller somewhere else first, or "it did not move" and "it moved
    // to the right place" are the same observation.
    await page.evaluate(() => {
      const scroller = document.querySelector('[class*="scroll_"]') as HTMLElement
      scroller.scrollTop = scroller.scrollHeight
    })
    await marks.nth(index).click()
    // `scrollIntoView` is smooth, so poll rather than read one frame.
    await expect
      .poll(async () =>
        page.evaluate((want) => {
          const scroller = document.querySelector('[class*="scroll_"]') as HTMLElement
          const target = scroller.querySelector(`[data-part="${want}"]`) as HTMLElement | null
          if (!target) return 'no target'
          const offset = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top
          return Math.abs(offset) <= 4 ? 'at the top' : `off by ${Math.round(offset)}`
        }, part),
      )
      .toBe('at the top')
  }
})

test('the rail keeps out of a transcript that has nowhere to go', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/preview.html')
  await page.evaluate(async () => { await document.fonts.ready })
  await page.waitForTimeout(600)
  // The control: the preview's transcript fits its scroller, so there is
  // nothing to navigate and the rail would be decoration.
  expect(
    await page.evaluate(() => {
      const scroller = document.querySelector('[class*="scroll_"]') as HTMLElement
      return scroller.scrollHeight - scroller.clientHeight
    }),
  ).toBeLessThanOrEqual(1)
  await expect(page.locator('nav[aria-label="Jump to a message"]')).toHaveCount(0)
})
