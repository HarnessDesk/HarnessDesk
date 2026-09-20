import { expect, test } from '@playwright/test'

test('stale evidence wraps every readable chip inside its narrow board card', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 900 })
  await page.goto('/preview.html')

  /* Production bundles the Chip module after the utility sheet, while Vite's
     development graph happens to put the utilities last. Reproduce the
     shipped cascade: a screen-level wrapping utility has to survive Chip's
     canonical one-line rule, not merely win in the dev server. */
  await page.addStyleTag({
    content: '[data-tone] { height: var(--hd-chip-h); line-height: 1; white-space: nowrap; }',
  })

  const frame = page.getByRole('heading', { name: 'Board — what the desk observed' }).locator('..')
  const card = frame.locator('[data-slot="board-card"]').filter({ hasText: 'Cap the backoff and add jitter' })
  const evidence = card.getByRole('button', { name: /What the desk observed on #2:/ })

  await card.scrollIntoViewIfNeeded()
  await expect(evidence).toContainText('verify ✓')
  await expect(evidence).toContainText('2 commits since')

  const cardBox = await card.boundingBox()
  const evidenceBox = await evidence.boundingBox()
  if (!cardBox || !evidenceBox) throw new Error('the stale evidence card was not laid out')

  expect(evidenceBox.x).toBeGreaterThanOrEqual(cardBox.x)
  expect(evidenceBox.x + evidenceBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width)

  for (const chip of await evidence.locator('[data-tone]').all()) {
    const chipBox = await chip.boundingBox()
    if (!chipBox) throw new Error('a stale evidence chip was not laid out')
    expect(chipBox.x).toBeGreaterThanOrEqual(cardBox.x)
    expect(chipBox.x + chipBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width)

    const words = chip.locator('[data-slot="chip-words"]')
    const wordsBox = await words.boundingBox()
    if (!wordsBox) throw new Error('a stale evidence chip has no readable words')
    expect(wordsBox.x).toBeGreaterThanOrEqual(chipBox.x)
    expect(wordsBox.x + wordsBox.width).toBeLessThanOrEqual(chipBox.x + chipBox.width)
    expect(await words.evaluate((node) => getComputedStyle(node.parentElement!).whiteSpace)).toBe('normal')
  }
})
