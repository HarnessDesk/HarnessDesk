import { expect, test } from '@playwright/test'

/**
 * The Sign in specimen is a specimen, not a modal over the catalogue.
 *
 * Mounted as the app mounts it, the dialog hid the design page's navigation
 * from a screen reader (`aria-hidden` on everything outside it) and pulled
 * focus into its paste field the moment the tab opened. Embedded, it is
 * neither modal nor a taker of focus — as `AppWindow` is not.
 */
test('the Sign in specimen leaves the page readable and takes no focus', async ({ page }) => {
  await page.goto('/design.html?view=signin')
  await expect(page.getByText('Mounting the screen…')).toHaveCount(0)
  await expect(page.locator('[data-slot="sign-in-paste-code"] input')).toBeVisible()
  await expect(page.locator('nav').first()).not.toHaveAttribute('aria-hidden', 'true')
  expect(await page.locator('[aria-hidden="true"]:has(nav)').count()).toBe(0)
  const focused = await page.evaluate(() => document.activeElement?.closest('[data-slot="dialog-content"]') !== null)
  expect(focused).toBe(false)
  // And the page around it still answers: another tab opens from the nav.
  await page.getByRole('link', { name: 'Foundation' }).or(page.getByRole('button', { name: 'Foundation' })).first().click()
  await expect(page.locator('[data-slot="sign-in-paste-code"]')).toHaveCount(0)
})
