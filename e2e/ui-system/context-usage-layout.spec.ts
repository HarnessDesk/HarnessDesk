import { expect, test, type Page } from '@playwright/test'

/** Give the real composer a cache verdict, so the context panel draws the
 * value-and-note row this test measures. The fixture module is intercepted at
 * its boundary, as the other UI-system usage tests do; the production panel,
 * popover and CSS still mount unchanged. */
const stageContextUsage = async (page: Page): Promise<void> => {
  await page.route('**/src/preview/sidebar-fixture.ts*', async (route) => {
    const response = await route.fetch()
    await route.fulfill({
      response,
      body: `${await response.text()}
Object.assign(previewSession, {
  usage: {
    total: { totalTokens: 200000, inputTokens: 180000, cachedInputTokens: 0, outputTokens: 20000, reasoningOutputTokens: 0, cacheWriteTokens: 180000 },
    last: { totalTokens: 1, inputTokens: 1, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, cacheWriteTokens: 1 },
    contextUsed: 180000,
    contextWindow: 258000,
  },
})`,
    })
  })
}

test('the context information plate keeps fact columns aligned and its note whole below them', async ({ page }) => {
  await stageContextUsage(page)
  await page.goto('/preview.html?frame-wall=conversation')
  const composer = page.locator('[data-frame-id="frame-wall"] [data-slot="composer-dock"]')
  await composer.locator('[data-info-source="context"]').focus()
  const panel = page.locator('[data-popup-kind="info-card"]').filter({ hasText: 'cold cache' })
  const reading = panel.locator('[data-info-pair]').filter({ hasText: 'cold cache' })
  await expect(reading).toHaveCount(1)
  const inline = await reading.evaluate(node => {
    const label = node.querySelector('dt')!.getBoundingClientRect()
    const value = node.querySelector('dd:not([data-info-pair-note])')!.getBoundingClientRect()
    const note = node.querySelector('[data-info-pair-note]')!.getBoundingClientRect()
    return { sameLine: Math.abs(label.top - value.top) <= 4,
      gap: value.left - label.right, textEdgeDelta: Math.abs(note.left - label.left), below: note.top >= value.bottom - 1 }
  })
  expect(inline.sameLine).toBe(true)
  expect(inline.gap).toBeGreaterThan(0)
  expect(inline.textEdgeDelta).toBeLessThanOrEqual(1)
  expect(inline.below).toBe(true)
  // The frame information plate deliberately spans a note across its fact
  // columns. At the same narrow measure the whole cache verdict still fits.
  const wrapped = await reading.evaluate(node => {
    const note = node.querySelector<HTMLElement>('[data-info-pair-note]')!
    note.style.width = '76px'
    const label = node.querySelector('dt')!.getBoundingClientRect()
    const value = node.querySelector('dd:not([data-info-pair-note])')!.getBoundingClientRect()
    const box = note.getBoundingClientRect()
    const range = document.createRange(); range.selectNodeContents(note)
    return { below: box.top >= value.bottom - 1, textEdgeDelta: Math.abs(box.left - label.left),
      noteWidth: box.width, scrollWidth: note.scrollWidth,
      visualLines: new Set([...range.getClientRects()].map(rect => Math.round(rect.top * 100))).size }
  })
  expect(wrapped.below).toBe(true)
  expect(wrapped.textEdgeDelta).toBeLessThanOrEqual(1)
  expect(Math.abs(wrapped.scrollWidth - wrapped.noteWidth)).toBeLessThanOrEqual(1)
  expect(wrapped.visualLines).toBe(1)
})
