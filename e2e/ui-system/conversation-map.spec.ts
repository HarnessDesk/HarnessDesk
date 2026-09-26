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

/**
 * The preview, driven rather than described.
 *
 * `lib/conversation-map.test.ts` proves the arithmetic — one mark is the
 * peak, and its words carry no markdown. What only a browser can answer is
 * whether that single peak becomes a single *card*, and whether the card the
 * system's Tooltip draws actually stays inside the window it is drawn in.
 */
test('hovering between two marks opens exactly one preview, in plain words, cut at a whole line', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 })
  await page.goto('/preview.html')
  await page.evaluate(async () => { await document.fonts.ready })
  await page.waitForTimeout(600)
  await overflow(page)

  const rail = page.locator('nav[aria-label="Jump to a message"]')
  const marks = rail.getByRole('button')
  await expect(marks).toHaveCount(2)

  // The preview page scrolls itself elsewhere once it has mounted; bring the
  // rail back under the pointer before reaching for it.
  await marks.first().scrollIntoViewIfNeeded()
  const first = await marks.nth(0).boundingBox()
  const second = await marks.nth(1).boundingBox()
  if (!first || !second) throw new Error('no box for a mark')

  // Nothing under the pointer at all: no card left over from a previous test.
  await page.mouse.move(first.x - 40, first.y)
  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(0)

  // Between the two dashes, closer to neither — the exact spot the old code
  // opened two cards for, since both marks cleared the SNAP threshold at once.
  const midX = first.x + first.width / 2
  const midY = (first.y + first.height / 2 + second.y + second.height / 2) / 2
  await page.mouse.move(midX, midY)
  await page.waitForTimeout(150)

  const tips = page.locator('[data-slot="tooltip-content"]')
  await expect(tips).toHaveCount(1)

  const tipBox = await tips.first().boundingBox()
  if (!tipBox) throw new Error('no box for the open preview')
  const viewport = page.viewportSize()
  if (!viewport) throw new Error('no viewport')
  expect(tipBox.x).toBeGreaterThanOrEqual(0)
  expect(tipBox.y).toBeGreaterThanOrEqual(0)
  expect(tipBox.x + tipBox.width).toBeLessThanOrEqual(viewport.width)
  expect(tipBox.y + tipBox.height).toBeLessThanOrEqual(viewport.height)

  const text = await tips.first().innerText()
  expect(text).not.toMatch(/[*`]/)
})

test('a long preview is cut at a whole line, never through the middle of one', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 })
  await page.goto('/preview.html')
  await page.evaluate(async () => { await document.fonts.ready })
  await page.waitForTimeout(600)
  await overflow(page)

  const rail = page.locator('nav[aria-label="Jump to a message"]')
  const marks = rail.getByRole('button')
  // The answer: three paragraphs, backticks included, long enough that four
  // lines at the card's width cannot hold it — the only mark worth asking the
  // clamp question of.
  await marks.nth(1).scrollIntoViewIfNeeded()
  const box = await marks.nth(1).boundingBox()
  if (!box) throw new Error('no box for the answer mark')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 2)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)

  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(1)

  // The clamp: the text element's own box, not the card's, stops the flow —
  // and it stops on a whole line rather than showing half of a fifth one.
  const clamp = await page.evaluate(() => {
    const span = document.querySelector<HTMLElement>('[data-slot="tooltip-content"] [class*="previewText_"]')
    if (!span) return null
    const lineHeight = Number.parseFloat(getComputedStyle(span).lineHeight)
    return { clientHeight: span.clientHeight, scrollHeight: span.scrollHeight, lineHeight }
  })
  if (!clamp) throw new Error('no clamped text element in the open preview')
  expect(clamp.scrollHeight).toBeGreaterThan(clamp.clientHeight)
  const remainder = clamp.clientHeight % clamp.lineHeight
  expect(Math.min(remainder, clamp.lineHeight - remainder)).toBeLessThanOrEqual(1)
})

test('a mark near the bottom edge still gets a preview that stays on screen', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 })
  await page.goto('/preview.html')
  await page.evaluate(async () => { await document.fonts.ready })
  await page.waitForTimeout(600)
  await overflow(page)

  // The preview page scrolls itself elsewhere once it has mounted; bring the
  // rail back under the pointer before measuring anything from it.
  const rail = page.locator('nav[aria-label="Jump to a message"]')
  await rail.scrollIntoViewIfNeeded()

  // The rail's own height comes from the pane around it, not the transcript's
  // scroller (shrinking that, as `overflow()` does, still leaves the rail
  // spanning the whole pane) — so pin the rail itself to a thin band right at
  // the window's bottom edge, in a stylesheet rather than the element's own
  // `style`, since the component rewrites that on every pointer move.
  await page.evaluate(() => {
    const nav = document.querySelector('nav[aria-label="Jump to a message"]') as HTMLElement
    const wrapperHeight = (nav.parentElement as HTMLElement).getBoundingClientRect().height
    const style = document.createElement('style')
    style.textContent = `nav[aria-label="Jump to a message"] { top: ${wrapperHeight - 40}px !important; bottom: -30px !important; }`
    document.head.append(style)
  })
  await page.waitForTimeout(150)

  const marks = rail.getByRole('button')
  const near = await marks.nth(1).boundingBox()
  if (!near) throw new Error('no box for the lower mark')
  expect(near.y + near.height).toBeGreaterThan(760) // genuinely at the edge, not a vacuous check

  // A real cursor move can land on whatever the rail's new position now
  // overlaps lower in the pane; dispatching straight at the rail reaches the
  // same handler without depending on what else occupies that screen pixel.
  await page.evaluate((clientY) => {
    const nav = document.querySelector('nav[aria-label="Jump to a message"]') as HTMLElement
    const box = nav.getBoundingClientRect()
    nav.dispatchEvent(new PointerEvent('pointermove', { clientX: box.left + box.width / 2, clientY, bubbles: true }))
  }, near.y + near.height / 2)
  await page.waitForTimeout(150)

  const tips = page.locator('[data-slot="tooltip-content"]')
  await expect(tips).toHaveCount(1)
  const tipBox = await tips.first().boundingBox()
  if (!tipBox) throw new Error('no box for the open preview')
  const viewport = page.viewportSize()
  if (!viewport) throw new Error('no viewport')
  // Uncorrected, a card centred on this mark would run off the bottom by a
  // good 30px; the assertion below is only interesting because of that.
  expect(near.y + near.height / 2 - tipBox.height / 2 + tipBox.height).toBeGreaterThan(viewport.height)
  expect(tipBox.y).toBeGreaterThanOrEqual(0)
  expect(tipBox.y + tipBox.height).toBeLessThanOrEqual(viewport.height)
  expect(tipBox.x).toBeGreaterThanOrEqual(0)
  expect(tipBox.x + tipBox.width).toBeLessThanOrEqual(viewport.width)
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

    // The card is the system's Tooltip, anchored to the mark rather than
    // drawn inside its button — so exactly one is open, and the button
    // itself still holds only the dash, never a div (it is phrasing content).
    await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(1)
    expect(await rail.locator('button div').count()).toBe(0)

    const pushed = await read()
    const peak = pushed.ticks[0]
    if (!peak) throw new Error('no dash under the pointer')
    // The full push where the gutter has room for it.
    if (width === 1440) expect(peak.width).toBe(24)
    for (const tick of pushed.ticks) expect(pushed.text - tick.right).toBeGreaterThanOrEqual(4)
  })
}
