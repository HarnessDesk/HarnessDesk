import { expect, test } from '@playwright/test'

test('evidence chips show their whole fact on one line, inside a 185px board card', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 900 })
  await page.goto('/preview.html')

  const frame = page.getByRole('heading', { name: 'Board — what the desk observed' }).locator('..')
  const card = frame.locator('[data-slot="board-card"]').filter({ hasText: 'Cap the backoff and add jitter' })
  const evidence = card.getByRole('button', { name: /What the desk observed on #2:/ })

  await card.scrollIntoViewIfNeeded()
  await expect(evidence).toContainText('verify ✓')
  // The card this was measured on: at 700px the board draws it 185px wide.
  expect(Math.round((await card.boundingBox())?.width ?? 0)).toBe(185)

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

    // The fact is whole: the words before any "—" are never cut on a 185px card.
    const words = chip.locator('[data-slot="chip-words"] > span')
    expect(await words.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(0)
    expect((await words.textContent())?.includes('—')).toBe(false)

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

  // A stale chip names how far behind it is in its title, not on the card.
  const stale = evidence.locator('[data-slot="chip"][data-stale]').first()
  await expect(stale).toHaveAttribute('title', 'verify ✓ @a1b2c3d — 2 commits since')

  // The ⋯ keeps the end of the foot's last line, beside the card's age.
  const more = card.getByRole('button', { name: /What to do with #2/ })
  const moreBox = await more.boundingBox()
  const evidenceEnd = await evidence.boundingBox()
  if (!moreBox || !evidenceEnd) throw new Error('the card foot was not laid out')
  expect(moreBox.y).toBeGreaterThanOrEqual(evidenceEnd.y + evidenceEnd.height - 1)
  expect(moreBox.x + moreBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width)
})
