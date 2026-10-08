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
      // The settings entry is local. Keep the palette open until its debounced
      // file search has answered and rendered, rather than racing Escape.
      await expect(palette.getByRole('option', { name: 'appearance.ts', exact: true })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(palette).toHaveCount(0)
      await opener.focus()
      await page.keyboard.press('Enter')
      await expect(field).toBeFocused()
      expect((await ringOf(page)).shadow).toBe('none')
      expect((await ringOf(page)).outline).toBe('none')
    })
    test('sidebar rows show a ring for Tab and arrow navigation, never for a click', async ({ page }) => {
      await mountFocusFixture(page)
      const sidebar = page.locator('[data-frame-id="sidebar-column"]')
      const row = sidebar.getByRole('button', { name: 'Other projects', exact: true })
      await row.click()
      await expect(row).toBeFocused()
      expect((await ringOf(page)).outline).toBe('none')
      await page.keyboard.press('Tab')
      await page.keyboard.press('Shift+Tab')
      await expect(row).toBeFocused()
      expect((await ringOf(page)).outline).toBe('solid')
      await page.keyboard.press('ArrowUp')
      const current = sidebar.locator('[data-region="session-tree"] :focus')
      await expect(current).toHaveCount(1)
      expect((await ringOf(page)).outline).toBe('solid')
      await row.click()
      expect((await ringOf(page)).outline).toBe('none')
    })

    test('a pointer-opened row menu restores focus quietly; a keyboard-opened one keeps its ring', async ({ page }) => {
      await mountFocusFixture(page)
      const label = 'Draft the 2.5 migration notes after reviewing the sidebar target behavior'
      const sidebar = page.locator('[data-frame-id="sidebar-column"]')
      const row = sidebar.locator('[data-region="session-row"] [data-slot="sidebar-menu-item"]').filter({ has: page.getByRole('button', { name: `Actions for ${label}`, exact: true }) }).locator('[data-slot="sidebar-menu-button"]')
      await row.hover()
      await sidebar.getByRole('button', { name: `Actions for ${label}`, exact: true }).click()
      await expect(page.getByRole('menu')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(row).toBeFocused()
      expect((await ringOf(page)).outline).toBe('none')
      await page.keyboard.press('ContextMenu')
      await expect(page.getByRole('menu')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(row).toBeFocused()
      expect((await ringOf(page)).outline).toBe('solid')
    })

    for (const name of ['Open focus menu', 'Open dialog']) {
      test(`${name} returns pointer focus without a ring and keyboard focus with one`, async ({ page }) => {
        await mountFocusFixture(page)
        const opener = page.getByRole('button', { name, exact: true })
        const surface = page.getByRole(name === 'Open dialog' ? 'dialog' : 'menu')
        await opener.click()
        await expect(surface).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(surface).toHaveCount(0)
        await expect(opener).toBeFocused()
        expect((await ringOf(page)).outline).toBe('none')
        await page.keyboard.press('Enter')
        await expect(surface).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(opener).toBeFocused()
        expect((await ringOf(page)).outline).toBe('solid')
        await opener.click()
        await expect(surface).toBeVisible()
        if (name === 'Open dialog') await page.getByRole('button', { name: 'Done', exact: true }).click()
        else await surface.getByRole('menuitem', { name: 'Menu action' }).click()
        await expect(opener).toBeFocused()
        expect((await ringOf(page)).outline).toBe('none')
      })
    }
    for (const look of ['desk', 'studio']) {
      test(`Input and Search use a focus border without an offset ring under ${look}`, async ({ page }) => {
        await mountFocusFixture(page)
        await page.evaluate((look) => (window as any).__hdPreview.store.patch({ look }), look)
        for (const label of ['Your name', 'Shared field', 'Shared search']) {
          const field = page.getByRole(label === 'Shared search' ? 'searchbox' : 'textbox', { name: label, exact: true })
          const resting = await field.evaluate((node) => getComputedStyle(node).boxShadow)
          await field.click()
          await expect(field).toBeFocused()
          await expect.poll(async () => (await ringOf(page)).border).toBe((await ringOf(page)).ring)
          expect((await ringOf(page)).outline).toBe('none')
          await expect.poll(async () => (await ringOf(page)).shadow).toBe(resting)
          await page.keyboard.press('Tab')
          await page.keyboard.press('Shift+Tab')
          await expect(field).toBeFocused()
          expect((await ringOf(page)).border).toBe((await ringOf(page)).ring)
          expect((await ringOf(page)).outline).toBe('none')
          expect((await ringOf(page)).shadow).toBe(resting)
        }
      })
    }
  })
}
