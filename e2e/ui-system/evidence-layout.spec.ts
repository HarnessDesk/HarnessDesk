import { expect, test } from '@playwright/test'

test('stale evidence stays one line per chip, inside its narrow board card', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 900 })
  await page.goto('/preview.html')

  const frame = page.getByRole('heading', { name: 'Board — what the desk observed' }).locator('..')
  const card = frame.locator('[data-slot="board-card"]').filter({ hasText: 'Cap the backoff and add jitter' })
  const evidence = card.getByRole('button', { name: /What the desk observed on #2:/ })

  await card.scrollIntoViewIfNeeded()
  await expect(evidence).toContainText('verify ✓')

  const cardBox = await card.boundingBox()
  const evidenceBox = await evidence.boundingBox()
  if (!cardBox || !evidenceBox) throw new Error('the stale evidence card was not laid out')

  expect(evidenceBox.x).toBeGreaterThanOrEqual(cardBox.x)
  expect(evidenceBox.x + evidenceBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width)

  const chips = await evidence.locator('[data-slot="chip"]').all()
  expect(chips.length).toBeGreaterThan(0)
  for (const chip of chips) {
    const chipBox = await chip.boundingBox()
    if (!chipBox) throw new Error('an evidence chip was not laid out')
    expect(chipBox.x).toBeGreaterThanOrEqual(cardBox.x)
    expect(chipBox.x + chipBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width)

    // One line: the pill is its own height, whatever the words are.
    const drawn = await chip.evaluate((node) => {
      const style = getComputedStyle(node)
      const words = node.querySelector('[data-slot="chip-words"]') as HTMLElement
      return {
        height: node.getBoundingClientRect().height,
        chipHeight: Number.parseFloat(style.height),
        whiteSpace: style.whiteSpace,
        struck: [node, words, ...words.querySelectorAll('*')].some((one) => getComputedStyle(one).textDecorationLine.includes('line-through')),
        stale: node.hasAttribute('data-stale'),
        glyph: node.firstElementChild?.tagName.toLowerCase() === 'svg',
      }
    })
    expect(drawn.whiteSpace).toBe('nowrap')
    expect(Math.abs(drawn.height - drawn.chipHeight)).toBeLessThanOrEqual(1)
    expect(drawn.struck).toBe(false)
    if (drawn.stale) expect(drawn.glyph).toBe(true)
  }

  // A chip cut short says itself whole when the pointer arrives.
  const cut = evidence.locator('[data-slot="chip"][data-stale]').first()
  await cut.hover()
  await expect(cut).toHaveAttribute('title', /2 commits since/)
})
