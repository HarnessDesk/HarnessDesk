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
  if (actions.leftPopup === 'account') await column.locator('[data-left-seat] [data-slot="popover-trigger"]').click()
  if (actions.leftPopup === 'start') await column.getByRole('button', { name: 'More ways to start', exact: true }).click()
  if (actions.leftPopup) await expect(page.locator('[data-slot="popover-popup"]:visible')).toBeVisible()
}
