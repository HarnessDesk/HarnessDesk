import { expect, test, type Locator, type Page } from '@playwright/test'
import path from 'node:path'

/**
 * A Run's controls. Abandoning a card is a question that says first what the
 * rule after its role will do, and the inspector offers it before the link to
 * the conversation. What only a browser can see is held here, on the
 * production inspector and the production question: the control's place, the
 * question's title on one line, every sentence arriving whole, both buttons on
 * screen, a refusal beside the disabled act, and nothing past a narrow pane.
 */
const open = async (page: Page, theme: 'light' | 'dark', query = '') => {
  await page.emulateMedia({ colorScheme: theme })
  await page.goto(`/preview.html?run-controls${query}&theme=${theme}`)
  await page.evaluate(() => document.fonts.ready)
}
const capture = async (locator: Locator, filename: string) => {
  const directory = process.env.TEAMS_ANSWERS_FRAMES_DIR
  if (directory) await locator.screenshot({ path: path.join(directory, filename) })
}

for (const theme of ['light', 'dark'] as const) {
  test(`a card that has not finished offers Abandon card… before its conversation link in ${theme}`, async ({ page }) => {
    await open(page, theme)
    const inspector = page.locator('#run-controls-abandon [data-slot="run-inspector"]')
    expect(await inspector.locator('button').evaluateAll((all) => all.map((one) => one.textContent))).toEqual(['Abandon card…', 'Open the conversation'])
    // The door to a question is an ordinary button; the red belongs on the step that cannot be taken back.
    await expect(inspector.getByRole('button', { name: 'Abandon card…' })).toHaveAttribute('data-variant', 'outline')
    const [abandon, conversation] = await inspector.locator('button').all()
    expect((await abandon!.boundingBox())!.y).toBeLessThan((await conversation!.boundingBox())!.y)
    expect(await inspector.evaluate((one) => one.scrollWidth <= one.clientWidth + 1)).toBe(true)
  })

  test(`a person's step is answered from its inspector with its words, a note and what each does in ${theme}`, async ({ page }) => {
    await open(page, theme)
    const inspector = page.locator('#run-controls-person-answer [data-slot="run-inspector"]')
    await expect(inspector.getByRole('button', { name: 'Abandon card…' })).toBeVisible()
    await expect(inspector).toContainText('Your answer')
    await expect(inspector).toContainText('Approved opens a writer round.')
    expect(await inspector.locator('[role="group"] button').evaluateAll((all) => all.map((one) => one.textContent))).toEqual(['Approved'])
    await expect(inspector.locator('input[aria-label="Note"]')).toBeVisible()
    expect(await inspector.evaluate((one) => one.scrollWidth <= one.clientWidth + 1)).toBe(true)
    await capture(inspector, `inspector-person-answer-${theme}.png`)
    const review = page.locator('#run-controls-person-review [data-slot="run-inspector"]')
    expect(await review.locator('button').evaluateAll((all) => all.map((one) => one.textContent))).toEqual(['Pick an attempt on the board', 'Abandon card…'])
  })

  test(`an unfinished check can be abandoned from its inspector in ${theme}`, async ({ page }) => {
    await open(page, theme)
    const inspector = page.locator('#run-controls-check-abandon [data-slot="run-inspector"]')
    await expect(inspector).toContainText('Latest result')
    await expect(inspector.getByRole('button', { name: 'Abandon card…' })).toBeVisible()
    expect(await inspector.evaluate((one) => one.scrollWidth <= one.clientWidth + 1)).toBe(true)
    await capture(inspector, `inspector-check-abandon-${theme}.png`)
  })

  for (const [variant, first] of [
    ['opens', 'The rule that follows the writer role still fires, so abandoning this card opens a reviewer round.'],
    ['ends', 'No rule that follows the writer role accepts a card with no answer, so abandoning this card ends the Run without a next step.'],
    ['waits', 'Round 4 stays open until its other card finishes (#5). Then the rule that follows the writer role decides, with this card counting as no answer.'],
    ['refused', 'The rule that follows the writer role still fires, so abandoning this card opens a reviewer round.'],
  ] as const) {
    test(`the question for "${variant}" says the rule first, whole, with both buttons on screen in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 })
      await open(page, theme, `&abandon=${variant}`)
      const dialog = page.getByRole('alertdialog', { name: 'Abandon card #4?' })
      await expect(dialog).toBeVisible()
      const body = dialog.locator('[data-slot="confirm-body"]')
      await expect(body.locator('p').first()).toHaveText(first)
      await expect(body.locator('p').nth(1)).toHaveText('Alpha holds this card now. Abandoning takes it back, and Alpha cannot finish it.')
      const held = await dialog.evaluate((node) => {
        const title = node.querySelector('[data-slot="alert-dialog-title"], h2')!
        const range = document.createRange()
        range.selectNodeContents(title)
        const box = node.getBoundingClientRect()
        const buttons = [...node.querySelectorAll('button')].map((one) => one.getBoundingClientRect())
        const sentences = [...node.querySelectorAll('[data-slot="confirm-body"] p')].map((one) => {
          const style = getComputedStyle(one)
          return { ellipsis: style.textOverflow === 'ellipsis', fits: one.scrollWidth <= one.clientWidth + 1 }
        })
        return {
          titleLines: new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size,
          inside: box.left >= 0 && box.right <= window.innerWidth && box.top >= 0 && box.bottom <= window.innerHeight,
          buttonsInside: buttons.every((rect) => rect.left >= box.left && rect.right <= box.right && rect.bottom <= box.bottom),
          sentences,
          wide: [...node.querySelectorAll('*')].reduce((most, child) => Math.max(most, child.scrollWidth - (child as HTMLElement).clientWidth), 0),
        }
      })
      expect(held.titleLines).toBe(1)
      expect(held.inside).toBe(true)
      expect(held.buttonsInside).toBe(true)
      expect(held.sentences.every((one) => !one.ellipsis && one.fits)).toBe(true)
      expect(held.wide).toBeLessThanOrEqual(1)
      // The act is the one filled button; keeping the card is the quiet way out.
      await expect(dialog.getByRole('button', { name: 'Abandon card', exact: true })).toHaveAttribute('data-filled', '')
      await expect(dialog.getByRole('button', { name: 'Keep it', exact: true })).not.toHaveAttribute('data-filled', '')
    })
  }

  test(`a refused abandon keeps the host's reason in the question and disables the act in ${theme}`, async ({ page }) => {
    await open(page, theme, '&abandon=refused')
    const dialog = page.getByRole('alertdialog', { name: 'Abandon card #4?' })
    await expect(dialog.locator('[role="alert"]')).toHaveText('There is no card #4 on this board.')
    await expect(dialog.getByRole('button', { name: 'Abandon card', exact: true })).toBeDisabled()
    await expect(dialog.getByRole('button', { name: 'Keep it', exact: true })).toBeEnabled()
    await dialog.getByRole('button', { name: 'Keep it', exact: true }).click()
    await expect(dialog).toBeHidden()
  })

  test(`the question holds at a phone width in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 700 })
    await open(page, theme, '&abandon=ends')
    const dialog = page.getByRole('alertdialog', { name: 'Abandon card #4?' })
    await expect(dialog).toBeVisible()
    const box = (await dialog.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(390)
    await expect(dialog.getByRole('button', { name: 'Abandon card', exact: true })).toBeInViewport()
    await expect(dialog.getByRole('button', { name: 'Keep it', exact: true })).toBeInViewport()
  })

  test(`at a narrow pane a person's step is a pushed detail with its controls and no sideways scroll in ${theme}`, async ({ page }) => {
    await open(page, theme)
    const narrow = page.locator('#run-controls-narrow')
    await expect(narrow.locator('[data-slot="run-view"]')).toBeHidden()
    const inspector = narrow.locator('[data-slot="run-inspector"]')
    await expect(inspector).toBeVisible()
    await expect(inspector).toContainText('Your answer')
    expect(await inspector.evaluate((one) => one.scrollWidth <= one.clientWidth + 1)).toBe(true)
    const note = (await inspector.locator('input[aria-label="Note"]').boundingBox())!
    const pane = (await inspector.boundingBox())!
    expect(note.x).toBeGreaterThanOrEqual(pane.x)
    expect(note.x + note.width).toBeLessThanOrEqual(pane.x + pane.width + 1)
  })
}
