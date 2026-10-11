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


test('FIX10 stopped Team agrees while its waiting turn finishes', async ({ page }) => {
  for (const theme of ['light', 'dark'] as const) {
  await openFrame(page, 'frame-wall=team&frame-fix10-stop=1', theme)
  await page.getByRole('tab', { name: 'Run 1', exact: true }).click()
  await page.getByRole('button', { name: 'Stop run…', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Stop run', exact: true }).click()
  await page.getByRole('tab', { name: 'Overview', exact: true }).click()
  const room = page.getByRole('button', { name: 'Room Retry the checkout call', exact: true })
  await expect(room).toHaveAttribute('title', /Stopping/)
  await expect(room).not.toHaveAttribute('title', /Working/)
  await expect(page.locator('[data-slot="team-overview"] [aria-label="Run"]')).toContainText('Stopping')
  await expect(page.locator('[data-seat="seat-1"] [data-slot="seat-state"]')).toHaveText('Stopping')
  await page.evaluate(() => (window as Window & { __hdFrameWall: { finishStoppedTurn(): void } }).__hdFrameWall.finishStoppedTurn())
  await expect(room).toHaveAttribute('title', /Stopped/)
  await expect(room.locator('..').getByRole('img', { name: 'Working', exact: true })).toHaveCount(0)
  await expect(page.locator('[data-slot="team-overview"] [aria-label="Run"]')).toContainText('Stopped')
  await expect(page.locator('[data-seat="seat-1"] [data-slot="seat-state"]')).toHaveText('Stopped')
  }
})


test('FIX10 Activity figure labels use sentence case', async ({ page }) => {
  for (const theme of ['light', 'dark'] as const) {
    await openFrame(page, 'frame-wall=dashboard&frame-view=activity&frame-empty-usage=1', theme)
    const activity = page.getByRole('region', { name: 'When it ran', exact: true })
    await expect(activity.locator('[data-slot="stat-label"]')).toHaveText(['Last 12 months', 'Active days', 'Streak · best 0', 'Busiest day', 'Did the most'])
    await page.getByRole('combobox', { name: 'Show by', exact: true }).selectOption('hour')
    await expect(activity.locator('[data-slot="stat-label"]')).toHaveText(['Tokens, last 12 months', 'Busiest hour', 'Busiest day of the week'])
  }
})
