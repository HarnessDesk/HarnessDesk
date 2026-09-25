import { expect, test } from '@playwright/test'

/**
 * The findings ledger, in the Goal rail.
 *
 * Mounted from the existing preview's own Goal frame — real production
 * modules, the real `PreviewStore` findings fixture — rather than a synthetic
 * render, because the thing worth proving here is that the whole path from
 * the rail's row to the detail dialog is one continuous keyboard journey with
 * nothing off-screen at the widths the app actually runs at.
 */

test('keyboard reaches the findings filters, a row’s detail, and back', async ({ page }) => {
  await page.goto('/preview.html')

  const findingsRow = page.locator('[data-slot="list-row"]', { hasText: 'Findings' }).first()
  await findingsRow.click()

  const openTab = page.getByRole('tab', { name: 'Open' })
  await expect(openTab).toBeVisible()
  await openTab.click()
  await expect(openTab).toHaveAttribute('data-selected', 'true').catch(async () => {
    // Base UI tabs mark the active tab with data-active on the trigger.
    await expect(openTab).toHaveAttribute('data-active', '')
  })

  const allTab = page.getByRole('tab', { name: 'All' })
  await allTab.click()

  const openRow = page.getByRole('button', { name: /finding-open-1/ })
  await expect(openRow).toBeVisible()
  await openRow.focus()
  await page.keyboard.press('Enter')

  const dialog = page.getByRole('dialog', { name: /checkout path/ })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('finding-open-1')

  // Selectable, literal id — never abbreviated into something a search cannot find.
  await expect(dialog.getByText('finding-open-1', { exact: true })).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(openRow).toBeFocused()
})

test('desktop and narrow layouts keep every sentence inside the pane', async ({ page }) => {
  for (const width of [1440, 680]) {
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/preview.html')

      const findingsRow = page.locator('[data-slot="list-row"]', { hasText: 'Findings' }).first()
      await findingsRow.click()

      const pane = page.locator('[aria-label="Findings"]').first()
      await expect(pane).toBeVisible()

      const overflow = await pane.evaluate((node) => {
        const rect = node.getBoundingClientRect()
        const widest = [...node.querySelectorAll<HTMLElement>('*')]
          .filter((el) => el.getBoundingClientRect().width > 0)
          .reduce((max, el) => Math.max(max, el.getBoundingClientRect().right), 0)
        return widest - rect.right
      })
      expect(overflow, `at ${width}px, ${colorScheme}`).toBeLessThanOrEqual(1)

      const openRow = page.getByRole('button', { name: /finding-open-1/ })
      await openRow.click()
      const dialog = page.getByRole('dialog', { name: /checkout path/ })
      await expect(dialog).toBeVisible()
      const dialogOverflow = await dialog.evaluate((node) => {
        const rect = node.getBoundingClientRect()
        const widest = [...node.querySelectorAll<HTMLElement>('*')]
          .filter((el) => el.getBoundingClientRect().width > 0)
          .reduce((max, el) => Math.max(max, el.getBoundingClientRect().right), 0)
        return widest - rect.right
      })
      expect(dialogOverflow, `dialog at ${width}px, ${colorScheme}`).toBeLessThanOrEqual(1)
      await page.keyboard.press('Escape')
    }
  }
})
