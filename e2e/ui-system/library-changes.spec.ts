import { mkdir } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { openFrame } from './frame-contract-helpers'
const capture = async (page: Page, scene: string, theme: string) => {
  if (!process.env.HD_LIBRARY_CHANGES_FRAMES) return
  await mkdir(process.env.HD_LIBRARY_CHANGES_FRAMES, { recursive: true })
  await page.screenshot({ path: `${process.env.HD_LIBRARY_CHANGES_FRAMES}/${scene}-${theme}.png` })
}
for (const theme of ['light', 'dark'] as const) {
  test(`Library changes groups, filters, search, restore and Back ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=library', theme)
    const library = page.locator('[data-page-destination="library"]:visible')
    await expect(library.getByRole('heading', { name: 'Changes made from here', exact: true })).toHaveCount(0)
    await page.locator('[data-slot="top-bar"]:visible').getByRole('button', { name: 'More', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Changes made here…', exact: true }).click()
    await expect(library.getByRole('heading', { name: 'Changes made here', exact: true })).toBeVisible()
    // Navigation from More uses the ordinary fixture's audit entries.
    await page.keyboard.press('Meta+[')
    await expect(library.getByRole('heading', { name: 'Library', exact: true })).toBeVisible()
    await openFrame(page, 'frame-wall=library&frame-kind=changes', theme)
    await expect(library.getByRole('listitem')).toHaveCount(7)
    await expect(library.getByRole('heading', { level: 2 })).toHaveText(['Today 3', 'Yesterday 2', 'Earlier 2'])
    await expect(library.getByRole('button', { name: 'Restore…', exact: true })).toHaveCount(4)
    await capture(page, 'changes-all', theme)
    await page.getByRole('radio', { name: 'Can restore', exact: true }).click()
    await expect(library.getByRole('listitem')).toHaveCount(4)
    await capture(page, 'changes-can-restore', theme)
    await page.getByRole('radio', { name: 'Failed', exact: true }).click()
    await expect(library.getByRole('listitem')).toHaveCount(1)
    await expect(library.getByRole('button', { name: 'Restore…', exact: true })).toHaveCount(0)
    await capture(page, 'changes-failed', theme)
    await page.getByRole('searchbox', { name: 'Search changes' }).fill('missing')
    await expect(library.getByText('Nothing matches', { exact: true })).toBeVisible()
    await capture(page, 'changes-no-matches', theme)
    await library.getByRole('button', { name: 'Clear', exact: true }).click()
    await expect(library.getByRole('listitem')).toHaveCount(7)
    await page.getByRole('searchbox', { name: 'Search changes' }).fill('/skills/benchmark')
    await expect(library.getByRole('listitem')).toHaveCount(1)
    await library.getByRole('button', { name: 'Restore…', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Restore benchmark' })).toBeVisible()
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
    await library.getByRole('button', { name: 'Back to Library', exact: true }).click()
    await expect(library.getByRole('heading', { name: 'Library', exact: true })).toBeVisible()
  })
  test(`Library changes empty ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=library&frame-kind=changes&frame-changes-empty=1', theme)
    await expect(page.getByText('Nothing has been changed from here.', { exact: true })).toBeVisible()
    await capture(page, 'changes-empty', theme)
  })
  for (const [shape, title] of [ ['one', 'Updated code-review'], ['several', 'Made 2 changes to the Library'], ['installs', 'Added 2 skills to the Library'], ['failed', "Couldn't update code-review"], ['failures', "2 changes didn't go through"] ]) {
    test(`Library write toast ${shape} opens changes without Undo ${theme}`, async ({ page }) => {
      await openFrame(page, `frame-wall=library&frame-write-toast=${shape}`, theme)
      const toast = page.locator('[data-sonner-toast]').filter({ hasText: title! })
      await expect(toast).toBeVisible()
      await expect(toast.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0)
      if (shape!.startsWith('fail')) {
        await expect(toast).toContainText('Permission denied')
        await page.waitForTimeout(5200)
        await expect(toast).toBeVisible()
        await expect(toast.getByRole('button', { name: /Close toast/ })).toBeVisible()
      }
      await capture(page, `toast-${shape}`, theme)
      await toast.getByRole('button', { name: 'View changes', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Changes made here', exact: true })).toBeVisible()
    })
  }
}
