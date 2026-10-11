import { expect, test, type Page } from '@playwright/test'
import { installFramePreviewFixture } from './frame-preview-fixture'

test.use({ screenshot: 'off', trace: 'off', video: 'off' })
const openFrame = async (page: Page, query: string, width = 1280, theme: 'light' | 'dark' = 'light') => {
  await installFramePreviewFixture(page)
  await page.setViewportSize({ width, height: 900 })
  await page.goto(`/preview.html?${query}&theme=${theme}`)
  await page.evaluate(async () => { await document.fonts.ready })
  await page.waitForFunction(() => Boolean((window as Window & { __hdFrameWall?: unknown }).__hdFrameWall))
}

test('kept conversation opens read-only after runtime failure', async ({ page }) => {
  for (const theme of ['light', 'dark'] as const) {
    await openFrame(page, 'frame-wall=conversation&frame-fix8-kept=1', 1280, theme)
    const row = page.getByRole('button', { name: 'Kept conversation', exact: true })
    await row.click()
    await expect(page.locator('[data-live-transcript]')).toContainText('First kept message')
    await expect(page.locator('textarea:visible')).toHaveCount(0)
    await expect(page.locator('[data-slot="notice-strip"]')).toHaveCount(0)
    await expect(page.locator('[data-slot="composer-dock"]')).toContainText('Choose a working installation in Settings.')
    await expect(page.locator('[data-work-tool="activity"]')).toBeDisabled()
    await expect(page.locator('[data-work-tool="activity"]')).toHaveAttribute('title', /failed its version check/)
  }
})

test('draft composer distinguishes a failed runtime from one starting', async ({ page }) => {
  for (const state of ['failed', 'starting']) {
    await openFrame(page, `frame-wall=draft&frame-fix8-readiness=${state}`)
    const textarea = page.locator('textarea:visible')
    await expect(textarea).toHaveAttribute('placeholder', state === 'starting'
      ? 'Waiting for the runtime…' : 'The agent failed its version check. Choose a working installation in Settings.')
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
  }
})

test('column filter keeps a matching conversation across repository worktrees', async ({ page }) => {
  await openFrame(page, 'frame-wall=conversation&frame-fix8-filter=1')
  await expect(page.getByRole('button', { name: 'Lead', exact: true })).toBeVisible()
  await page.getByRole('searchbox', { name: 'Filter this list' }).fill('Lead')
  await expect(page.getByRole('button', { name: 'Lead', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Review', exact: true })).toHaveCount(0)
  await expect(page.getByText('No conversations match', { exact: false })).toHaveCount(0)
})

test('right tools overlay the full main area below the wide breakpoint', async ({ page }) => {
  for (const width of [1100, 720]) for (const tool of ['Changes', 'Details', 'Browser']) {
    await openFrame(page, 'frame-wall=conversation', width)
    const main = page.locator('[data-frame-region="main"]:visible')
    const before = await main.boundingBox()
    await page.getByRole('button', { name: tool, exact: true }).first().click()
    const right = page.locator('[data-frame-region="right"]:visible')
    await expect(right).toBeVisible()
    const after = await main.boundingBox(), panel = await right.boundingBox()
    expect(after!.width).toBe(before!.width)
    expect(panel!.x).toBeGreaterThanOrEqual(after!.x)
    expect(panel!.x + panel!.width).toBeLessThanOrEqual(after!.x + after!.width + 1)
  }
})

test('dashboard without plan reports explains the absence once', async ({ page }) => {
  await openFrame(page, 'frame-wall=dashboard&frame-view=overview&frame-empty-usage=1')
  await expect(page.getByText('Nothing is spent or low right now.', { exact: true })).toHaveCount(0)
  await expect(page.getByText('No agent here reports plan usage.', { exact: true })).toHaveCount(1)
})

test('spend keeps unscanned days as gaps in bars and line beside its coverage', async ({ page }) => {
  await openFrame(page, 'frame-wall=dashboard&frame-view=spend&frame-fix8-ledger=1')
  const range = page.getByRole('combobox', { name: 'How far back', exact: true })
  await range.selectOption('7')
  const plot = page.locator('[data-slot="day-columns"]').first()
  await expect(plot.locator('li').filter({ hasText: 'No record yet' })).toHaveCount(3)
  await expect(page.locator('[data-slot="chart-head"]').first()).toContainText('4 of 7 days scanned')
  await page.getByRole('combobox', { name: 'Bars or line', exact: true }).selectOption('line')
  await expect(plot.locator('li').filter({ hasText: 'No record yet' })).toHaveCount(3)
})

test('projects empty usage has one message and headings follow the grouping', async ({ page }) => {
  await openFrame(page, 'frame-wall=dashboard&frame-view=projects&frame-empty-usage=1')
  await expect(page.getByRole('heading', { name: 'Team usage', exact: true })).toBeVisible()
  await expect(page.getByText('No usage recorded in this range', { exact: true })).toHaveCount(1)
  await expect(page.locator('[data-slot="banner"]')).toHaveCount(0)
  await page.getByRole('combobox', { name: 'Project usage view', exact: true }).selectOption('agent')
  await expect(page.getByRole('heading', { name: 'Agent usage', exact: true })).toBeVisible()
  await expect(page.getByText('No usage recorded in this range', { exact: true })).toHaveCount(1)
})

test('spend selected ranges equal their shorter figures', async ({ page }) => {
  await openFrame(page, 'frame-wall=dashboard&frame-view=spend&frame-fix8-ledger=1')
  const range = page.getByRole('combobox', { name: 'How far back', exact: true })
  for (const [wide, span] of [[30, 7], [90, 30]]) {
    await range.selectOption(String(wide))
    const stat = page.locator('[data-slot="stat"]').filter({ hasText: `Last ${span} days` })
    const value = await stat.locator('[data-role="metric"]').innerText()
    await range.selectOption(String(span))
    await expect(page.locator('[data-slot="chart-title"][data-figure]').first()).toHaveText(value)
  }
})

test('stopping a waiting Team removes its command approval', async ({ page }) => {
  await openFrame(page, 'frame-wall=team&frame-fix8-stop=1')
  await expect(page.getByRole('button', { name: 'Allow', exact: true })).toBeVisible()
  await page.getByRole('tab', { name: 'Run 1', exact: true }).click()
  await page.getByRole('button', { name: 'Stop run…', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Stop run', exact: true }).click()
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  await page.getByRole('tab', { name: 'Overview', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Allow', exact: true })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Needs you', exact: true })).toHaveCount(0)
  await expect(page.getByRole('banner')).not.toContainText('Needs you')
})
