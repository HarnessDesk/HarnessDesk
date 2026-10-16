import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) {
  test(`final imported history shows its empty collection in ${theme}`, async ({ page }) => {
    await page.goto(`/preview.html?frame-wall=settings&frame-section=history&theme=${theme}`)
    await expect(page.getByText('Nothing imported yet', { exact: true })).toBeVisible()
    await expect(page.getByText('Import history from a runtime’s settings page.', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0)
  })
  test(`final preview dial retains each selected page in ${theme}`, async ({ page }) => {
    await page.goto(`/preview.html?capability-lists=stress&theme=${theme}`)
    const dial = page.getByRole('combobox', { name: 'settings page', exact: true })
    const frame = page.locator('[data-frame-id="settings-sheet"]')
    for (const [section, title] of [['library', 'Library'], ['plugins', 'Plugins'], ['extensions', 'Extensions'], ['skills', 'Skills'], ['general', 'General']] as const) {
      await dial.selectOption(section)
      await expect(frame.locator('[data-topbar-title]')).toHaveCount(0)
      await expect(frame.locator('[data-page-destination]:not([hidden]) h1')).toHaveText(title)
      await expect(dial).toHaveValue(section)
    }
  })
}
