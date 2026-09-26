import { expect, test } from '@playwright/test'

/**
 * The catalogue's stalled-round case: a run whose round could not seat its
 * first card. The header says Needs you, and the room's live line carries the
 * host's own reason whole — the refusal, the sibling held back, the way on —
 * one line per line it was written as, never cut to one.
 */
test('a round stalled on a Seat names why and what to do on the live line, lines kept', async ({ page }) => {
  await page.goto('/design.html?view=group')
  await page.evaluate(async () => { await document.fonts.ready })

  const wrap = page.locator('[data-testid="group-run-stalled-on-a-seat"]')
  await expect(wrap).toBeVisible()
  await wrap.scrollIntoViewIfNeeded()
  await expect(wrap.locator('header').filter({ hasText: 'Needs you' }).first()).toBeVisible()

  const line = wrap.locator('[data-slot="room-live-line"][data-kind="stall"]')
  await expect(line).toBeVisible()
  await expect(line).toContainText('The Seat for card #1 could not be opened')
  await expect(line).toContainText('card #2 was not started either')
  await expect(line).toContainText('Next: wrap this Goal, which stops this run, then fix what stopped card #1')

  // Four lines as written: the refusal wraps rather than truncating, and each
  // written line starts on its own.
  const words = line.locator('.whitespace-pre-line')
  const { height, lineHeight, overflow } = await words.evaluate((el) => {
    const style = getComputedStyle(el)
    return { height: el.getBoundingClientRect().height, lineHeight: parseFloat(style.lineHeight), overflow: el.scrollWidth > el.clientWidth + 1 }
  })
  expect(overflow).toBe(false)
  expect(height).toBeGreaterThanOrEqual(lineHeight * 4 - 1)
})
