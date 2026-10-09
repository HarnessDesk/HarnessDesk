import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) {
  test(`Archive names the kept inventory and requires explicit Discard in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/preview.html')
    await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
    const archive = page.locator('[data-frame-id="settings-archive"]')
    const chip = archive.locator('[data-slot="chip"]').filter({ hasText: 'Worktree kept' })
    await expect(chip).toHaveAttribute('title', '1 modified, 1 untracked files; 2 ignored entries')
    await archive.getByRole('button', { name: 'Review the workspace settings actions', exact: true }).first().click()
    await page.getByRole('menuitem', { name: 'Discard worktree…', exact: true }).click()
    const dialog = page.getByRole('alertdialog', { name: 'Discard worktree?' })
    await expect(dialog).toContainText('src/settings.ts')
    await expect(dialog).toContainText('notes.txt')
    await expect(dialog).toContainText('.env')
    await expect(dialog).toContainText('build/')
    await expect(dialog).toContainText('The branch is kept')
    await dialog.getByRole('button', { name: 'Keep', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(chip).toBeVisible()
  })

  test(`Archive keeps a detached checkout after Discard is refused in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/preview.html')
    await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
    const archive = page.locator('[data-frame-id="settings-archive"]')
    await expect(archive.getByText('Worktree kept', { exact: true })).toBeVisible()
    await page.evaluate(() => {
      const { store } = (window as unknown as { __hdPreview: { store: { transport: { request: (method: string, params?: unknown) => Promise<unknown> } } } }).__hdPreview
      const request = store.transport.request
      store.transport.request = async (method, params) => {
        if (method === 'session/discardWorktree') throw new Error('The detached worktree has no branch retaining its commits. Create or check out a branch at its current commit before discarding it.')
        return request(method, params)
      }
    })
    await archive.getByRole('button', { name: 'Review the workspace settings actions', exact: true }).first().click()
    await page.getByRole('menuitem', { name: 'Discard worktree…', exact: true }).click()
    const dialog = page.getByRole('alertdialog', { name: 'Discard worktree?' })
    await dialog.getByRole('button', { name: 'Discard worktree', exact: true }).click()
    await expect(dialog).toContainText('Create or check out a branch at its current commit')
    await expect(dialog.getByRole('button', { name: 'Discard worktree', exact: true })).toBeDisabled()
    await expect(dialog.getByRole('button', { name: 'Review again', exact: true })).toBeVisible()
    if (process.env.HD_ARCHIVE_FRAME_DIR) await dialog.screenshot({ path: `${process.env.HD_ARCHIVE_FRAME_DIR}/discard-detached-${theme}.png` })
    await dialog.getByRole('button', { name: 'Keep', exact: true }).click()
    await expect(archive.getByText('Worktree kept', { exact: true })).toBeVisible()
  })
}
