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

test('FIX9 kept history remains readable after reopening', async ({ page }) => {
  await openFrame(page, 'frame-wall=conversation&frame-fix8-kept=1')
  await page.getByRole('button', { name: 'Kept conversation', exact: true }).click()
  await expect(page.locator('[data-live-transcript]')).toContainText('First kept message')
  await expect(page.locator('[data-slot="composer-dock"]')).toContainText('Choose a working installation in Settings.')
})

test('FIX9 wrapped findings use the receipt and ask nothing of a person', async ({ page }) => {
  for (const theme of ['light', 'dark'] as const) {
    await openFrame(page, 'frame-wall=team-receipt&frame-fix9-findings=1', 1280, theme)
    await page.getByRole('tab', { name: 'Findings 5', exact: true }).click()
    const pane = page.getByRole('region', { name: 'Findings', exact: true })
    await expect(pane.getByRole('button', { name: /Advisory finding/ })).toHaveCount(4)
    await expect(pane.locator('[aria-label="Findings summary"]')).toContainText('Open4Blocking0All5')
    await expect(pane.locator('[aria-label="This round"]')).toHaveCount(0)
    await expect(pane.getByText('Waiting for a person', { exact: true })).toHaveCount(0)
    await expect(pane).toContainText('The run was stopped before this was posted')
    await expect(pane).not.toContainText('yet')
    await expect(pane).not.toContainText('Goal')
  }
})

test('FIX9 stopped Team keeps its Researcher and explains round counts', async ({ page }) => {
  await openFrame(page, 'frame-wall=team&frame-fix9-stop=1')
  await page.getByRole('tab', { name: 'Run 1', exact: true }).click()
  await page.getByRole('button', { name: 'Stop run…', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Stop run', exact: true }).click()
  await page.getByRole('tab', { name: 'Overview', exact: true }).click()
  const agents = page.locator('[data-slot="team-overview"]')
  await expect(agents).not.toContainText('No agents')
  await expect(agents).toContainText('Researcher')
  await expect(agents).toContainText('Stopped')
  await expect(page.locator('[data-slot="team-overview"]')).not.toContainText('Rounds 0 of')
})

test('FIX9 command card waits for approval and names its folder', async ({ page }) => {
  await openFrame(page, 'frame-wall=conversation&frame-fix9-command-waiting=1')
  const transcript = page.locator('[data-live-transcript]')
  await expect(transcript).toContainText('Waiting for approval · List files in storefront')
  await expect(transcript).not.toContainText('Listed')
  await expect(transcript).not.toContainText('/work/storefront')
})
