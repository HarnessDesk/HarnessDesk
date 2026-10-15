import { mkdir } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

test.use({ viewport: { width: 900, height: 850 } })
for (const theme of ['light', 'dark']) for (const kind of ['unlisted', 'alias']) {
  test(`project menu reads ${kind} checkout facts in ${theme}`, async ({ page }) => {
    await page.goto(`/preview.html?repository-menu-repairs&theme=${theme}${kind === 'alias' ? '&alias' : ''}`)
    await expect(page.getByText('Make a first commit to work in a worktree', { exact: true })).toBeVisible()
    if (kind === 'unlisted' && process.env.REPOSITORY_MENU_FRAMES) {
      await mkdir(process.env.REPOSITORY_MENU_FRAMES, { recursive: true })
      await page.screenshot({ path: `${process.env.REPOSITORY_MENU_FRAMES}/project-${kind}-after-${theme}.png` })
    }
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Commit outside the dialog', exact: true }).click()
    await page.getByRole('button', { name: 'Project actions', exact: true }).click()
    await expect(page.getByText('Make a first commit to work in a worktree', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: /^New worktree/ })).toBeEnabled()
    if (kind === 'alias' && process.env.REPOSITORY_MENU_FRAMES) {
      await mkdir(process.env.REPOSITORY_MENU_FRAMES, { recursive: true })
      await page.screenshot({ path: `${process.env.REPOSITORY_MENU_FRAMES}/project-${kind}-after-${theme}.png` })
    }
  })
}
