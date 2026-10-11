import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) {
  test(`final preview dial retains each selected page in ${theme}`, async ({ page }) => {
    await page.goto(`/preview.html?capability-lists=stress&theme=${theme}`)
    const dial = page.getByRole('combobox', { name: 'settings page', exact: true })
    const frame = page.locator('[data-frame-id="settings-sheet"]')
    for (const [section, title] of [['library', 'Library'], ['plugins', 'Plugins'], ['extensions', 'Extensions'], ['skills', 'Skills'], ['general', 'General']] as const) {
      await dial.selectOption(section)
      if (section === 'library' || section === 'plugins') await expect(frame.locator('[data-topbar-title]')).toHaveText(title)
      else await expect(frame.locator('[data-page-destination="settings"]:not([hidden]) h1')).toHaveText(title)
      await expect(dial).toHaveValue(section)
    }
  })
}
