import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) {
  for (const surface of ['preview', 'catalogue'] as const) {
    test(`the canonical ${surface} shows the committed review and publication approval in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 1000 })
      await page.emulateMedia({ colorScheme: theme })
      await page.goto(surface === 'preview' ? `/preview.html?team-start=fix-and-review&theme=${theme}` : `/design.html?view=team-start&theme=${theme}`)
      if (surface === 'catalogue') await page.getByRole('button', { name: 'Write and review', exact: true }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByRole('textbox', { name: 'What should they do?', exact: true }).fill('Repair checkout retry for review')
      await expect(dialog.getByRole('button', { name: 'Agent for Writes' })).toBeEnabled()
      await dialog.getByRole('button', { name: 'Details', exact: true }).click()
      await expect(dialog.getByText('Review the committed change', { exact: true })).toBeVisible()
      await expect(dialog.getByText(/Approve publishing the reviewed change/)).toBeVisible()
      await expect(dialog.getByText('Review the pull request', { exact: true })).toHaveCount(0)
      if (process.env.HD_1669_FRAMES) {
        await dialog.getByText(/Approve publishing the reviewed change/).scrollIntoViewIfNeeded()
        await mkdir(process.env.HD_1669_FRAMES, { recursive: true })
        await page.screenshot({ path: join(process.env.HD_1669_FRAMES, `canonical-${surface}-${theme}.png`), animations: 'disabled' })
      }
    })
  }
}
