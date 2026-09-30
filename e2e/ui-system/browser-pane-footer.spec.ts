import { expect, test } from '@playwright/test'

/**
 * The browser pane's footer is the system's bar, and a bar is one row tall.
 *
 * It used to be a strip that grew with its text, so a narrow pane made it
 * taller; as a `Bar` it holds `--hd-bar-h`, and a split can leave a pane at a
 * sixth of its parent. The sentence on the right may wrap to two lines inside
 * the bar and no further: below 16rem the pane keeps only its state on the
 * left. The checks are on the real pane in the real engine, at widths from a
 * roomy pane down to a thin split: nothing in the footer ends outside it, the
 * bar keeps its height, and the sentence is there when there is room for it.
 */
test('the browser pane footer stays one bar tall at every pane width', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 })
  await page.goto('/preview.html')

  const footer = page.locator('[data-slot="tool-pane"] [data-slot="bar"][data-rule="top"]').filter({ hasText: 'Idle' }).first()
  await expect(footer).toBeVisible()
  const sentence = footer.getByText(/Framed pages only|Never your own browser profile/)

  for (const width of [480, 300, 240, 140]) {
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
    expect(held.spilled, `nothing in the footer ends outside it at ${width}px`).toBe(0)
    expect(held.height, `the footer keeps the bar height at ${width}px`).toBe(held.barHeight)

    if (width >= 256) await expect(sentence, `the sentence is shown at ${width}px`).toBeVisible()
    else await expect(sentence, `the sentence gives way at ${width}px`).toBeHidden()
  }
})
