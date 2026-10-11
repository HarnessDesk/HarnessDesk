import { expect, test, type Page } from '@playwright/test'
import { installFramePreviewFixture } from './frame-preview-fixture'

test.use({ screenshot: 'off', trace: 'off', video: 'off' })
const openFrame = async (page: Page, query: string, theme: 'light' | 'dark' = 'light') => {
  await installFramePreviewFixture(page)
  await page.goto(`/preview.html?${query}&theme=${theme}`)
  await page.evaluate(async () => { await document.fonts.ready })
  await page.waitForFunction(() => Boolean((window as Window & { __hdFrameWall?: unknown }).__hdFrameWall))
}

test('FIX10 partly read spend agrees across ranges and keeps today unread', async ({ page }) => {
  for (const theme of ['light', 'dark'] as const) {
    await openFrame(page, 'frame-wall=dashboard&frame-view=spend&frame-fix10-ledger=partial', theme)
    const cost = page.getByRole('region', { name: 'What it cost', exact: true })
    await expect(cost.locator('[data-slot="stat"]').filter({ hasText: 'Last 7 days' })).toContainText('$23.09· 4 of 7 days read')
    await expect(cost.locator('[data-slot="stat"]').filter({ hasText: 'Today' })).toContainText('Not read yet')
    await page.getByRole('combobox', { name: 'How far back', exact: true }).selectOption('7')
    await expect(cost.locator('[data-slot="chart-title"]').first()).toHaveText('$23.09')
    await expect(cost).toContainText('4 of 7 days scanned')
    await expect(cost.locator('[data-slot="stat"]').filter({ hasText: 'Today' })).toContainText('Not read yet')
  }
})
