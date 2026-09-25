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

/**
 * The rail stays in its gutter, at every width a pane is given.
 *
 * The dashes grow sideways under the pointer, dock-style, and in a narrow pane
 * the gutter the reading column leaves is about 32px: a 1440 window with the
 * sidebar and the dock open leaves no more than a 640 one. Unmeasured, the
 * pushed dash drew across the first letters of the transcript (#912 review).
 * So at each width: a resting prompt is its full 12px and a resting answer 8
 * (the button once squeezed both to 8), the pushed dash is longer than it was
 * at rest, and neither comes within 4px of the text. A prompt is drawn in the
 * strong ink and an answer in the quiet one.
 */
for (const width of [640, 760, 1440]) {
  test(`the rail's dashes keep 4px clear of the transcript at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    await page.goto('/preview.html')
    await page.evaluate(async () => { await document.fonts.ready })
    await page.waitForTimeout(600)
    await overflow(page)

    const rail = page.locator('nav[aria-label="Jump to a message"]')
    await expect(rail).toBeVisible()

    const read = () => page.evaluate(() => {
      const scroller = document.querySelector('[class*="scroll_"]') as HTMLElement
      const text = Math.min(
        ...[...scroller.querySelectorAll<HTMLElement>('[data-part] > *')]
          .map((one) => one.getBoundingClientRect())
          .filter((box) => box.width > 0)
          .map((box) => box.left),
      )
      const ink = (value: string) => {
        const probe = document.createElement('span')
        probe.style.color = value
        document.body.appendChild(probe)
        const colour = getComputedStyle(probe).color
        probe.remove()
        return colour
      }
      const ticks = [...document.querySelectorAll<HTMLElement>('nav[aria-label="Jump to a message"] button')].map((mark) => {
        const tick = mark.querySelector<HTMLElement>('[data-slot="tick"]') as HTMLElement
        const box = tick.getBoundingClientRect()
        return {
          kind: mark.dataset['kind'],
          emphasis: tick.dataset['emphasis'],
          strongInk: getComputedStyle(tick).backgroundColor === ink('var(--hd-foreground)'),
          quietInk: getComputedStyle(tick).backgroundColor === ink('var(--hd-muted-foreground)'),
          width: Math.round(box.width),
          right: box.right,
        }
      })
      return { text, ticks }
    })

    const rest = await read()
    const prompt = rest.ticks.find((one) => one.kind === 'prompt')
    const answer = rest.ticks.find((one) => one.kind === 'answer')
    expect(prompt).toMatchObject({ emphasis: 'strong', strongInk: true, width: 12 })
    expect(answer).toMatchObject({ emphasis: 'quiet', quietInk: true, width: 8 })
    for (const tick of rest.ticks) expect(rest.text - tick.right).toBeGreaterThanOrEqual(4)

    const mark = rail.getByRole('button').first()
    // The preview page scrolls itself elsewhere once it has mounted; bring the
    // rail back under the pointer before reaching for it.
    await mark.scrollIntoViewIfNeeded()
    const box = await mark.boundingBox()
    if (!box) throw new Error('no box for the first mark')
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 2)
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await expect.poll(async () => (await read()).ticks[0]?.width).toBeGreaterThan(12)

    const pushed = await read()
    const peak = pushed.ticks[0]
    if (!peak) throw new Error('no dash under the pointer')
    // The full push where the gutter has room for it.
    if (width === 1440) expect(peak.width).toBe(24)
    for (const tick of pushed.ticks) expect(pushed.text - tick.right).toBeGreaterThanOrEqual(4)
  })
}
