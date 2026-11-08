import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) test(`Dashboard numbers in ${theme}`, async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1080 })
  await page.emulateMedia({ colorScheme: theme })
  await page.goto('/preview.html')
  await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
  await page.evaluate(async () => {
    const { mountDashboardD10 } = await import('/src/preview/dashboard-d10-fixture.tsx' as string)
    const container = document.createElement('div')
    container.id = 'root'
    document.body.replaceChildren(container)
    mountDashboardD10(container)
  })
  const dashboard = page.locator('[data-page-destination="dashboard"]:visible')
  const remaining = dashboard.getByRole('region', { name: 'What is left', exact: true })
  await expect(remaining.getByText('dev@example.com', { exact: true })).toBeVisible()
  await expect(dashboard.locator('[aria-label="What it cost, in brief"]')).toContainText('$')
  await expect(remaining.getByText('analyst@example.com', { exact: true })).toBeVisible()
  await expect(remaining).toContainText('Business Pro Lite')
  await expect(remaining.locator('[title="self_serve_business_prolite"]')).toBeVisible()
  // Pace is said as a time under the bar, not a badge: one card lasts to its reset, the other runs out before it.
  await expect(remaining.locator('[data-slot="pace-badge"]')).toHaveCount(0)
  await expect(remaining).toContainText(/Lasts to its [^.]*\d:\d{2}\s?[AP]M reset/)
  await expect(remaining).toContainText(/Runs out ~[^,]*\d:\d{2}\s?[AP]M, before its [^.]*\d:\d{2}\s?[AP]M reset/)
  await expect(dashboard).toContainText('Usage cost')
  await expect(dashboard.locator('[aria-label="What it cost, in brief"]')).not.toContainText('Selected')
  await expect(page.getByText('From a cached read', { exact: true })).toBeVisible()
  await page.screenshot({ path: `/tmp/dashboard-d10/after-${theme}.png` })
})
