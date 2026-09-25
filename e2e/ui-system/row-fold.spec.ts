import { expect, test } from '@playwright/test'

/**
 * A row that opens something and also folds what it holds (`RowButton fold`),
 * and a checkbox named by its label.
 *
 * The fold is a toggle at the row's end: down while folded, up while open, the
 * same box either way (no popup-trigger fill), with the row's own inset at its
 * end. The pair draws one rule under itself while something follows it in the
 * card and none when it is the card's last row — the doubled and stray rules
 * the runtime cards used to draw.
 *
 * Measured in the real engine: jsdom resolves no `var()` border and lays
 * nothing out.
 */

test('a folding row draws one rule open, none folded, and one box either way', async ({ page }) => {
  await page.goto('/design.html?view=row')
  const card = page.locator('[data-catalog-case="row-fold"]')
  const pair = card.locator('[data-slot="row-folding"]')
  const fold = card.getByRole('button', { name: 'Show the accounts under Codex' })
  await expect(fold).toBeVisible()

  const read = () => pair.evaluate((node) => {
    const opener = node.querySelector('button:not([aria-expanded])') as HTMLElement
    const foldButton = node.querySelector('button[aria-expanded]') as HTMLElement
    const mark = foldButton.querySelector('[data-slot="disclosure-chevron"]') as SVGElement
    const card = node.parentElement as HTMLElement
    const pairBox = node.getBoundingClientRect()
    const foldBox = foldButton.getBoundingClientRect()
    const rules = [node, ...node.querySelectorAll('*')].filter((one) => {
      const style = getComputedStyle(one)
      return style.borderBottomStyle !== 'none' && parseFloat(style.borderBottomWidth) > 0
    }).length
    return {
      pairRule: getComputedStyle(node).borderBottomStyle,
      openerRule: getComputedStyle(opener).borderBottomStyle,
      rules,
      foldGround: getComputedStyle(foldButton).backgroundColor,
      turn: getComputedStyle(mark).rotate,
      inset: card.getBoundingClientRect().right - foldBox.right,
      cardInset: parseFloat(getComputedStyle(document.body).getPropertyValue('--hd-card-padding')),
      fillsHead: foldBox.bottom <= pairBox.bottom && foldBox.top >= pairBox.top,
    }
  })

  await page.mouse.move(0, 0)
  const folded = await read()
  expect(folded.pairRule).toBe('none')
  expect(folded.openerRule).toBe('none')
  expect(folded.rules).toBe(0)
  expect(folded.turn).toBe('none')
  expect(folded.fillsHead).toBe(true)
  // The row's inset holds the fold's end, as it holds any row control's.
  expect(Math.round(folded.inset)).toBe(Math.round(folded.cardInset + 1))

  await fold.click()
  await page.mouse.move(0, 0)
  const open = await read()
  expect(open.pairRule).toBe('solid')
  expect(open.openerRule).toBe('none')
  expect(open.rules).toBe(1)
  // Up while open: a half turn of the down caret.
  expect(open.turn).toBe('180deg')
  // A toggle, not a menu: nothing fills the fold because it is open.
  expect(open.foldGround).toBe(folded.foldGround)
  await expect(card.getByRole('button', { name: 'Hide the accounts under Codex' })).toBeVisible()
})

test('a labelled checkbox is named by its words and ticked by them', async ({ page }) => {
  await page.goto('/design.html?view=row')
  const box = page.getByRole('checkbox', { name: 'Install for Codex' })
  await expect(box).toHaveAttribute('aria-checked', 'false')
  await page.getByText('Install for Codex', { exact: true }).click()
  await expect(box).toHaveAttribute('aria-checked', 'true')
})
