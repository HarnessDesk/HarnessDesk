import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) for (const width of [700, 1440]) {
  test(`dense card keeps one complete evidence row and keyboard details at ${width} in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(`/preview.html?theme=${theme}`)
    await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
    const frame = page.getByRole('heading', { name: 'Board — what the desk observed' }).locator('..')
    await frame.locator('[data-slot="tool-pane"]').evaluate(el => { (el as HTMLElement).style.width = '1164px' })
    await frame.locator('[data-slot="board-column"]').evaluateAll(columns => {
      for (const column of columns) (column as HTMLElement).style.width = '220px'
    })
    const card = frame.locator('[data-slot="board-card"]').filter({ hasText: 'Retry the checkout call on a 502' })
    await card.scrollIntoViewIfNeeded()
    const button = card.getByRole('button', { name: /What the desk observed on #1:/ })
    await expect(button).toHaveText('Failed')
    await expect(button.locator('[data-slot="chip"]')).toHaveCount(1)
    const bounds = await button.evaluate(el => {
      const chip = el.querySelector<HTMLElement>('[data-slot="chip"]')!
      const words = chip.querySelector<HTMLElement>('[data-slot="chip-words"]')!
      const card = el.closest<HTMLElement>('[data-slot="board-card"]')!
      const b = el.getBoundingClientRect(), c = chip.getBoundingClientRect(), outer = card.getBoundingClientRect()
      return { buttonHeight: b.height, chipHeight: c.height, clipped: words.scrollWidth > words.clientWidth, whiteSpace: getComputedStyle(chip).whiteSpace, inside: c.left >= outer.left && c.right <= outer.right, cardWidth: outer.width }
    })
    expect(Math.round(bounds.cardWidth)).toBe(202)
    expect(bounds.inside).toBe(true)
    expect(bounds.clipped).toBe(false)
    expect(bounds.whiteSpace).toBe('nowrap')
    expect(bounds.buttonHeight).toBeLessThanOrEqual(32)
    const more = card.getByRole('button', { name: /What to do with #1/ })
    const moreBox = await more.boundingBox()
    const evidenceBox = await button.boundingBox()
    const cardBox = await card.boundingBox()
    if (!moreBox || !evidenceBox || !cardBox) throw new Error('the card foot was not laid out')
    expect(moreBox.y).toBeGreaterThanOrEqual(evidenceBox.y + evidenceBox.height - 1)
    expect(moreBox.x + moreBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width)
    for (const key of ['Enter', 'Space']) {
      await button.focus()
      await page.keyboard.press(key)
      const dialog = page.getByRole('dialog', { name: 'What the desk observed on #1' })
      await expect(dialog).toBeVisible()
      await expect(dialog.locator('section')).toHaveCount(7)
      for (const text of ['synthetic failure output', 'pnpm verify', 'build: passed · lint: skipped', '2 commits landed', 'review: request-changes', 'finding open', 'PR #12 open']) await expect(dialog).toContainText(text)
      if (key === 'Enter') await page.keyboard.press('Escape')
      else await dialog.getByRole('button', { name: 'Done' }).click()
      await expect(button).toBeFocused()
    }
  })
}
