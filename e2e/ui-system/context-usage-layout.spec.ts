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

test('the context panel keeps a reading and its note inline, then wraps the note whole at the row end', async ({ page }) => {
  await stageContextUsage(page)
  await page.goto('/preview.html?composer')

  const composer = page.locator('[data-preview="composer"]')
  await composer.getByRole('button', { name: 'Context window 70% full — 180K of 258K tokens' }).click()
  const panel = page.getByRole('menu').filter({ hasText: 'Last turn' })
  const reading = panel.locator('[class*="rowReading"]').filter({ hasText: 'cold cache' })
  await expect(reading).toHaveCount(1)

  const inline = await reading.evaluate((node) => {
    const reading = node as HTMLElement
    const value = reading.querySelector<HTMLElement>('[data-role="value"]')!
    const note = reading.querySelector<HTMLElement>('[data-role="meta"]')!
    const row = reading.getBoundingClientRect()
    const valueBox = value.getBoundingClientRect()
    const noteBox = note.getBoundingClientRect()
    return {
      // The two Text variants use adjacent line-height tokens, so their box
      // tops differ slightly while their rendered baselines share one line.
      sameLine: Math.abs(valueBox.top - noteBox.top) <= 4,
      gap: noteBox.left - valueBox.right,
      rightInset: row.right - noteBox.right,
    }
  })
  expect(inline.sameLine).toBe(true)
  expect(inline.gap).toBeGreaterThan(0)
  expect(inline.rightInset).toBeLessThanOrEqual(1)

  // A narrow row is the browser-level proof of the wrap rule: the cache
  // verdict moves below the number as one piece, and its own auto margin
  // holds it against the row's right edge. jsdom has no layout engine, so the
  // component test cannot make either assertion.
  const wrapped = await reading.evaluate((node) => {
    const reading = node as HTMLElement
    reading.style.width = '64px'
    const value = reading.querySelector<HTMLElement>('[data-role="value"]')!
    const note = reading.querySelector<HTMLElement>('[data-role="meta"]')!
    const row = reading.getBoundingClientRect()
    const valueBox = value.getBoundingClientRect()
    const noteBox = note.getBoundingClientRect()
    return {
      below: noteBox.top >= valueBox.bottom - 1,
      rightInset: row.right - noteBox.right,
      noteWidth: noteBox.width,
      scrollWidth: note.scrollWidth,
    }
  })
  expect(wrapped.below).toBe(true)
  expect(wrapped.rightInset).toBeLessThanOrEqual(1)
  expect(Math.abs(wrapped.scrollWidth - wrapped.noteWidth)).toBeLessThanOrEqual(1)
})
