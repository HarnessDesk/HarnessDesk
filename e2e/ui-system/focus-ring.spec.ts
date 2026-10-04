import { expect, test } from '@playwright/test'
import { mountFocusFixture, ringOf } from './focus-ring-fixture'

for (const theme of ['light', 'dark'] as const) {
  test.describe(theme, () => {
    test.use({ colorScheme: theme })
    test('the palette search keeps its caret without a focus ring', async ({ page }) => {
      await mountFocusFixture(page)
      const opener = page.getByRole('button', { name: 'Open palette', exact: true })
      await opener.click()
      const palette = page.getByRole('dialog', { name: 'Command palette' })
      const field = palette.getByRole('searchbox')
      await expect(field).toBeFocused()
      expect((await ringOf(page)).shadow).toBe('none')
      expect((await ringOf(page)).outline).toBe('none')
      await field.fill('appearance')
      await expect(palette.getByRole('option', { name: /Settings › Appearance/ })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(palette).toHaveCount(0)
      await opener.focus()
      await page.keyboard.press('Enter')
      await expect(field).toBeFocused()
      expect((await ringOf(page)).shadow).toBe('none')
      expect((await ringOf(page)).outline).toBe('none')
    })
  })
}
