import { mkdir } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { openFrame } from './frame-contract-helpers'

const capture = async (page: Page, scene: string, theme: string) => {
  if (!process.env.HD_LIBRARY_CARD_FRAMES) return
  await mkdir(process.env.HD_LIBRARY_CARD_FRAMES, { recursive: true })
  await page.screenshot({ path: `${process.env.HD_LIBRARY_CARD_FRAMES}/${scene}-${theme}.png` })
}
for (const theme of ['light', 'dark'] as const) {
  test(`skills cards, chips, matrix and Add skill ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=library', theme, 1440)
    const cards = page.locator('[data-slot="skill-card"]')
    await expect(cards).toHaveCount(6)
    await expect(page.getByRole('radio', { name: /^All/ })).toHaveText('All6')
    await expect(page.locator('[data-slot="library-attention"]')).toHaveCount(0)
    await expect(page.getByRole('radio', { name: 'List', exact: true })).toHaveCount(0)
    await expect(cards.filter({ hasText: 'code-review' })).toContainText('Update available')
    await expect(cards.filter({ hasText: 'code-review' }).locator('[data-card-finding]')).not.toHaveAttribute('data-tone', 'warning')
    const rowHeights = await cards.evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect(); return { y: box.y, height: box.height } }))
    for (const row of rowHeights) expect(rowHeights.filter(other => other.y === row.y).every(other => other.height === row.height)).toBe(true)
    const summary = cards.filter({ hasText: 'design-review' })
    await expect(summary.locator('[data-runtime-state]')).toHaveCount(0)
    await expect(summary.getByText(/^\d+ runtimes?$/)).toBeVisible()
    await capture(page, 'all', theme)
    await page.getByRole('radio', { name: /^Needs attention/ }).click()
    await expect(cards).toHaveCount(3)
    await expect(page.locator('[data-slot="library-attention"]')).toBeVisible()
    await capture(page, 'needs-you', theme)
    await page.getByTitle('View', { exact: true }).click()
    await page.getByRole('menuitemradio', { name: 'Runtime comparison', exact: true }).click()
    await expect(page.locator('[data-slot="library-matrix"] tbody th[scope="row"]')).toHaveCount(3)
    await capture(page, 'matrix', theme)
    await page.getByRole('radio', { name: /^All/ }).click()
    await page.getByTitle('View', { exact: true }).click()
    await page.getByRole('menuitemradio', { name: 'Cards', exact: true }).click()
    await page.getByRole('button', { name: 'Add skill', exact: true }).click()
    await expect(page.getByRole('menuitem')).toHaveText(['Write a skill', 'From GitHub…', 'Copy from another runtime…'])
    await capture(page, 'add-skill', theme)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'systematic-debugging', exact: true }).click()
    await expect(page.locator('[data-slot="skill-page"]')).toBeVisible()
  })
  test(`narrow skills pane uses one card column ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=library', theme, 480)
    const grid = page.locator('[data-slot="skill-cards"]')
    await expect(grid).toBeVisible()
    const columns = await grid.evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').length)
    expect(columns).toBe(1)
    const cards = await grid.locator('[data-slot="skill-card"]').evaluateAll(nodes => nodes.map(node => {
      const box = node.getBoundingClientRect(); return { x: box.x, right: box.right }
    }))
    expect(new Set(cards.map(card => card.x)).size).toBe(1)
    expect(cards.every(card => card.right <= 480)).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await capture(page, 'narrow', theme)
  })
  test(`empty skills region has a title and its two actions ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=library&frame-empty=1', theme, 1440)
    const region = page.locator('[data-page-destination="library"]:visible [data-slot="empty-state"]')
    await expect(region.getByRole('heading', { name: 'No skills yet', exact: true })).toBeVisible()
    await expect(region.locator('p')).toHaveCount(0)
    await expect(region.getByRole('button')).toHaveText(['Write a skill', 'From GitHub…'])
    await capture(page, 'empty', theme)
  })
}
