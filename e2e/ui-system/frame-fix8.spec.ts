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

