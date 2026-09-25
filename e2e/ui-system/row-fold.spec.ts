import { expect, test } from '@playwright/test'

/**
 * A row that opens something and also folds what it holds (`RowButton fold`),
 * and a checkbox named by its label.
 *
 * The fold is a toggle at the row's end: down while folded, up while open, the
 * same box either way (no popup-trigger fill), its mark on the column the
 * drill-in chevrons of the rows under it stand in. The pair draws one rule under itself while something follows it in the
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

  // One trailing column of marks: the fold's mark is centred on the column
  // the drill-in chevrons of the rows under it stand in.
  const centres = await card.evaluate((node) => {
    const centre = (mark: Element | null | undefined) => {
      const box = mark?.getBoundingClientRect()
      return box ? box.left + box.width / 2 : NaN
    }
    const fold = node.querySelector('[data-slot="row-folding"] [data-slot="disclosure-chevron"]')
    const account = [...node.querySelectorAll('button')].find((one) => one.textContent?.includes('dev@example.com'))
    return { fold: centre(fold), chevron: centre(account?.querySelector('.lucide-chevron-right')) }
  })
  expect(Number.isFinite(centres.chevron)).toBe(true)
  expect(Math.abs(centres.fold - centres.chevron)).toBeLessThanOrEqual(1)

  // The head's name is the subject step, a step above the row titles under it.
  const sizes = await card.evaluate((node) => {
    const name = node.querySelector('[data-slot="row-folding"] [data-role="subject"]') as HTMLElement
    const account = [...node.querySelectorAll('button')].find((one) => one.textContent?.includes('dev@example.com'))
    const title = [...(account?.querySelectorAll('span') ?? [])].find((one) => one.textContent === 'dev') as HTMLElement
    return { name: parseFloat(getComputedStyle(name).fontSize), title: parseFloat(getComputedStyle(title).fontSize) }
  })
  expect(sizes.name).toBe(14)
  expect(sizes.name).toBeGreaterThan(sizes.title)
})

test('a labelled checkbox is named by its words and ticked by them', async ({ page }) => {
  await page.goto('/design.html?view=row')
  const box = page.getByRole('checkbox', { name: 'Install for Codex' })
  await expect(box).toHaveAttribute('aria-checked', 'false')
  await page.getByText('Install for Codex', { exact: true }).click()
  await expect(box).toHaveAttribute('aria-checked', 'true')
})

test('hovering a folding row lights the whole row to the card edge, and the fold a step deeper', async ({ page }) => {
  await page.goto('/design.html?view=row')
  const card = page.locator('[data-catalog-case="row-fold"]')
  const pair = card.locator('[data-slot="row-folding"]')
  const opener = pair.locator('button:not([aria-expanded])')
  const fold = pair.locator('button[aria-expanded]')

  const read = () => pair.evaluate((node) => {
    const card = node.closest('[data-catalog-case="row-fold"]') as HTMLElement
    const opener = node.querySelector('button:not([aria-expanded])') as HTMLElement
    const fold = node.querySelector('button[aria-expanded]') as HTMLElement
    return {
      pair: getComputedStyle(node).backgroundColor,
      opener: getComputedStyle(opener).backgroundColor,
      fold: getComputedStyle(fold).backgroundColor,
      // The lit box is the pair's, so its ends are the card's.
      reachesEdge: Math.abs(node.getBoundingClientRect().right - card.getBoundingClientRect().right) <= 1,
    }
  })

  await page.mouse.move(0, 0)
  const rest = await read()
  expect(rest.pair).toBe('rgba(0, 0, 0, 0)')

  await opener.hover()
  const onName = await read()
  expect(onName.pair).not.toBe(rest.pair)
  // Not the opener's own ground: that one stopped a fold's width short.
  expect(onName.opener).toBe('rgba(0, 0, 0, 0)')
  expect(onName.reachesEdge).toBe(true)

  await fold.hover()
  const onFold = await read()
  expect(onFold.pair).toBe(onName.pair)
  expect(onFold.fold).not.toBe('rgba(0, 0, 0, 0)')
})

test('a folding row’s two targets draw their whole focus ring inside the card', async ({ page }) => {
  await page.goto('/design.html?view=row')
  const card = page.locator('[data-catalog-case="row-fold"]')
  const pair = card.locator('[data-slot="row-folding"]')
  const opener = pair.locator('button:not([aria-expanded])')
  const fold = pair.locator('button[aria-expanded]')
  for (const target of [opener, fold]) {
    await target.focus()
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Tab')
    const ring = await target.evaluate((node) => {
      const style = getComputedStyle(node)
      const box = node.getBoundingClientRect()
      const clip = (node.closest('[data-catalog-case="row-fold"]') as HTMLElement).getBoundingClientRect()
      const offset = parseFloat(style.outlineOffset)
      const width = parseFloat(style.outlineWidth)
      const out = offset + width
      return {
        style: style.outlineStyle,
        inside: box.left - out >= clip.left - 0.5 && box.right + out <= clip.right + 0.5 && box.top - out >= clip.top - 0.5 && box.bottom + out <= clip.bottom + 0.5,
        insideOwnBox: out <= 0,
      }
    })
    expect(ring.style).not.toBe('none')
    expect(ring.insideOwnBox).toBe(true)
    expect(ring.inside).toBe(true)
  }
})
