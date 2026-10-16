import { expect, test } from '@playwright/test'
import { openFrame } from './frame-contract-helpers'

// The existing synthetic defaults fixture supplies the same refusing adapter
// to General, runtime details and Permissions as the person navigates.
for (const theme of ['light', 'dark'] as const) {
  test(`Settings keeps runtime and approval recovery controls in ${theme}`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await openFrame(page, 'conversation-defaults=1&defaults-refused=1', theme)
    await page.setViewportSize({ width: 1440, height: 1100 })
    await page.getByRole('button', { name: 'Permissions', exact: true }).click()
    const warning = page.getByText('The runtime did not accept its recommended Permissions. Choose a default in Settings and try again.', { exact: true })
    await expect(warning.first()).toBeVisible()
    const permissions = page.getByRole('combobox', { name: 'Permissions', exact: true })
    await expect(permissions.first()).toBeVisible()
    await warning.first().scrollIntoViewIfNeeded()
    await page.screenshot({ path: `/tmp/hdv-defaults-d2/approvals-refused-${theme}.png` })
    await permissions.first().selectOption('workspace')
    await expect(warning.first()).toBeVisible()
    await permissions.first().selectOption('full')
    await expect(warning).toHaveCount((await permissions.count()) - 1)
    await page.getByRole('button', { name: 'Runtimes', exact: true }).click()
    await page.getByRole('button', { name: /^Beta / }).click()
    await expect(page.getByText('New sessions', { exact: true })).toBeVisible()
    await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toBeVisible()
    await expect(warning).toBeVisible()
    await page.getByText('New sessions', { exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: `/tmp/hdv-defaults-d2/runtime-refused-${theme}.png` })
    expect(errors).toEqual([])
  })
}
