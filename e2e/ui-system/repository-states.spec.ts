import { mkdir } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

test.use({ viewport: { width: 1100, height: 720 } })

for (const theme of ['light', 'dark']) {
  test(`first commit opens the existing flow and restores worktree creation in ${theme}`, async ({ page }) => {
    await page.goto(`/preview.html?repository-states=unborn&theme=${theme}`)
    await page.getByRole('button', { name: 'storefront', exact: true }).click()
    await expect(page.getByText('Make a first commit to work in a worktree', { exact: true })).toBeVisible()
    await expect(page.getByRole('menuitemradio', { name: /^New worktree/ })).toHaveCount(0)
    if (process.env.REPOSITORY_STATE_FRAMES) {
      await mkdir(process.env.REPOSITORY_STATE_FRAMES, { recursive: true })
      await page.locator('[data-popup-kind="wide-menu"]').screenshot({ path: `${process.env.REPOSITORY_STATE_FRAMES}/unborn-after-${theme}.png` })
    }
    await page.getByRole('button', { name: 'Commit', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Commit', exact: true })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('textbox').fill('Start the storefront')
    await dialog.getByRole('button', { name: /^Commit/ }).click()
    await expect(dialog).toHaveCount(0)
    await page.getByRole('button', { name: 'storefront', exact: true }).click()
    await expect(page.getByRole('menuitemradio', { name: /^New worktree/ })).toBeEnabled()
  })

  test(`committed card retires Undo and keeps Review in ${theme}`, async ({ page }) => {
    await page.goto(`/preview.html?repository-states=committed&theme=${theme}`)
    await expect(page.getByText('Committed c0ffee1', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Review', exact: true })).toBeVisible()
    if (process.env.REPOSITORY_STATE_FRAMES) {
      await mkdir(process.env.REPOSITORY_STATE_FRAMES, { recursive: true })
      await page.locator('[data-slot="card"]').screenshot({ path: `${process.env.REPOSITORY_STATE_FRAMES}/committed-after-${theme}.png` })
    }
    await page.goto(`/preview.html?repository-states=edited&theme=${theme}`)
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeVisible()
    await expect(page.getByText(/^Committed /)).toHaveCount(0)
  })
}
