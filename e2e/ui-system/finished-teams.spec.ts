import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) {
 test(`finished Teams stop asking for the person in ${theme}`, async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 760 })
  for (const stage of ['before', 'after'] as const) {
   await page.goto(`/preview.html?teams-page&finished=${stage}&theme=${theme}`)
   await page.locator('label').filter({hasText:/^theme/}).locator('select').first().selectOption(theme)
   await expect(page.locator('html')).toHaveCSS('color-scheme',theme)
   await page.evaluate(() => document.fonts.ready)
   const frame = page.locator('#teams-page-active')
   if (stage === 'before') {
    await expect(frame.getByRole('button', { name: 'Needs you', exact: true })).toBeVisible()
    await expect(frame.locator('[data-team-row]')).toHaveCount(2)
    await expect(frame.locator('[data-team-row]').filter({hasText:'Needs you'})).toHaveCount(2)
   } else {
    await expect(frame.getByRole('button', { name: 'Needs you', exact: true })).toBeVisible()
    await expect(frame.getByText('Stopped', { exact: true })).toBeVisible()
    await frame.getByRole('button', { name: 'Ready to wrap · 1', exact: true }).click()
    await expect(frame.locator('[data-team-row="team-0"]')).toBeVisible()
    await expect(frame.locator('[data-team-row="team-1"]')).toContainText('Stopped')
   }
   await frame.screenshot({ path: `output/playwright/finished-teams/${stage}-${theme}.png` })
  }
 })
}
