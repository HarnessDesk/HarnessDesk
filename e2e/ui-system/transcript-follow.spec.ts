import { expect, test } from '@playwright/test'

/**
 * The release has to stick (#983 round 1).
 *
 * `Conversation.tsx`'s own auto-scroll sets `scrollTop` itself while a turn
 * streams, and that assignment fires its own native `scroll` event a frame
 * later — indistinguishable, to a plain listener, from the reader scrolling
 * back to the bottom. Only a real browser fires that event at all; jsdom
 * never does, so no unit test can see this class of bug. `window.__hdStreamPreview`
 * (preview/main.tsx) grows the preview conversation's own last turn exactly
 * the way a live agent's items arrive, chunk by chunk, on a real interval.
 */

const stream = (page: import('@playwright/test').Page, chunks: number, intervalMs: number): void => {
  void page.evaluate(
    ([c, i]) => (window as unknown as { __hdStreamPreview: (chunks: number, intervalMs: number) => Promise<void> }).__hdStreamPreview(c, i),
    [chunks, intervalMs],
  )
}

test('a selection made mid-stream keeps its scroll position, not just its pinned flag, across several frames', async ({ page }) => {
  await page.goto('/preview.html')
  await page.evaluate(async () => { await document.fonts.ready })
  await page.waitForTimeout(300)

  const scroller = page.locator('[data-live-transcript]')
  await expect(scroller).toBeVisible()

  // Start at the bottom — the state auto-follow keeps while nothing has
  // released it — then start the stream.
  await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight })
  stream(page, 24, 50)

  // Let a few chunks land, so there is real growth to auto-scroll behind.
  await page.waitForTimeout(220)

  // Select some text inside the transcript — the release under test.
  await scroller.evaluate((el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    const text = walker.nextNode()
    if (!text) throw new Error('no text in the streaming transcript to select')
    const range = document.createRange()
    range.selectNodeContents(text)
    const selection = window.getSelection()
    if (!selection) throw new Error('no Selection in this browser')
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })

  const scrollTopAfterRelease = await scroller.evaluate((el) => el.scrollTop)

  // The stream keeps growing the transcript underneath the reader for
  // several more frames. A release that does not stick shows up here: the
  // next chunk's own auto-scroll attempt re-pins, and `scrollTop` jumps back
  // to the (still growing) bottom.
  for (let frame = 0; frame < 6; frame += 1) {
    await page.waitForTimeout(80)
    const scrollTop = await scroller.evaluate((el) => el.scrollTop)
    expect(scrollTop).toBe(scrollTopAfterRelease)
  }

  // The release is not just geometry: the reader's own way back is offered.
  await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeVisible()
})
