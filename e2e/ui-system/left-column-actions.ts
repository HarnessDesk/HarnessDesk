import { expect, type Page } from '@playwright/test'

/** Left-column probes use the current shell and popup APIs until B/C land. */
export const applyLeftColumnActions = async (page: Page, actions: {
  readonly leftOpen?: boolean
  readonly leftPopup?: string
}) => {
  if (!actions.leftOpen) return
  const column = page.locator('[data-left-column]:visible')
  if (!await column.count()) await page.getByRole('button', { name: 'Show sidebar', exact: true }).click()
  await expect(column).toHaveCount(1)
  if (actions.leftPopup === 'inbox') await column.locator('[data-slot="inbox-button"]').locator('..').click()
  if (actions.leftPopup === 'account' || actions.leftPopup === 'usage') await column.locator('[data-left-seat] [data-slot="popover-trigger"]').click()
  if (actions.leftPopup === 'usage') await page.getByRole('menu').getByRole('menuitem', { name: /^Usage remaining/ }).click()
  if (actions.leftPopup === 'start') await column.getByRole('button', { name: 'More ways to start', exact: true }).click()
  if (actions.leftPopup === 'project') {
    await column.locator('[data-project-root] button[data-draggable]').first().focus()
    await page.keyboard.press('Shift+F10')
    await expect(page.getByRole('menu')).toBeVisible()
  }
  if (actions.leftPopup === 'session') {
    await column.locator('[data-region="session-row"] [data-slot="sidebar-menu-button"]').first().focus()
    await page.keyboard.press('ContextMenu')
    await expect(page.getByRole('menu')).toBeVisible()
  }
  if (actions.leftPopup === 'card') {
    await column.locator('[data-region="session-row"] [data-slot="hover-card-trigger"]').first().hover()
    await expect(page.locator('[data-slot="hover-card-content"]:visible')).toBeVisible()
  }
  if (actions.leftPopup && ['inbox', 'account', 'start'].includes(actions.leftPopup)) await expect(page.locator('[data-slot="popover-popup"]:visible')).toBeVisible()
}

/** Exercise the actual controlled Settings search in its visual wall. */
export const applySettingsNavigationActions = async (page: Page, actions: {
  readonly settingsQuery?: string
  readonly query?: string
}) => {
  if (actions.settingsQuery !== undefined) {
    await page.locator('[data-left-settings]').getByRole('searchbox', { name: 'Search settings' }).fill(actions.settingsQuery)
  }
}
