import { expect, test } from '@playwright/test'

/**
 * The browser pane's footer is the system's bar, and a bar is one row tall.
 *
 * It used to be a strip that grew with its text, so a narrow pane made it
 * taller; as a `Bar` it holds `--hd-bar-h`, and a split can leave a pane at a
 * sixth of its parent. The sentence on the right may wrap to two lines inside
 * the bar and no further: below 18rem the pane keeps only its state on the
 * left. The checks are on the real pane in the real engine, at widths from a
 * roomy pane down to a thin split, and at the threshold itself: nothing in the
 * footer ends outside it, the bar keeps its height, and the sentence is there
 * when there is room for it.
 *
 * Both states the left side takes are measured. The preview pane is idle, and
 * driving it for real takes a browser tool in flight on a live conversation,
 * so the driven state is built the way the pane draws it — a 6px dot before
 * "Being driven" — since that width is all the layout depends on.
 */
const WIDTHS = [480, 300, 288, 280, 240, 140]
const THRESHOLD = 288

test('the browser pane footer stays one bar tall at every pane width, idle or driven', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 })
  await page.goto('/preview.html')

  // Found by its state once, then held by a mark: the driven case below
  // rewrites that state, and the footer must still be the same element.
  const idle = page.locator('[data-slot="tool-pane"] [data-slot="bar"][data-rule="top"]').filter({ hasText: 'Idle' }).first()
  await expect(idle).toBeVisible()
  await idle.evaluate((bar) => bar.setAttribute('data-testid', 'browser-footer'))
  const footer = page.getByTestId('browser-footer')
  const sentence = footer.getByText(/Framed pages only|Never your own browser profile/)

  for (const state of ['idle', 'driven'] as const) {
    if (state === 'driven') {
      await footer.evaluate((bar) => {
        const dot = document.createElement('span')
        dot.style.cssText = 'display:block;flex:none;width:6px;height:6px'
        bar.prepend(dot)
        const left = bar.querySelector('[data-slot="text"]')
        if (!left) throw new Error('the footer has no state on its left')
        left.textContent = 'Being driven'
      })
    }

    for (const width of WIDTHS) {
      await footer.evaluate((bar, px) => {
        const pane = bar.closest<HTMLElement>('[data-slot="tool-pane"]')
        if (!pane) throw new Error('the footer is not inside its pane')
        pane.style.width = `${px}px`
      }, width)

      const held = await footer.evaluate((bar) => {
        const box = bar.getBoundingClientRect()
        const barHeight = parseFloat(getComputedStyle(document.body).getPropertyValue('--hd-bar-h')) || box.height
        const spilled = [...bar.querySelectorAll('*')]
          .map((node) => node.getBoundingClientRect())
          .filter((rect) => rect.height > 0 && (rect.top < box.top - 0.5 || rect.bottom > box.bottom + 0.5))
        return { height: Math.round(box.height), barHeight: Math.round(barHeight), spilled: spilled.length }
      })
      expect(held.spilled, `${state}: nothing in the footer ends outside it at ${width}px`).toBe(0)
      expect(held.height, `${state}: the footer keeps the bar height at ${width}px`).toBe(held.barHeight)

      if (width >= THRESHOLD) await expect(sentence, `${state}: the sentence is shown at ${width}px`).toBeVisible()
      else await expect(sentence, `${state}: the sentence gives way at ${width}px`).toBeHidden()
    }
  }
})
