import { expect, test } from '@playwright/test'

test('stale evidence wraps every readable chip inside its narrow board card', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 900 })
  await page.goto('/preview.html')

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
  }

})
