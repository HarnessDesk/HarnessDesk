import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'

// A separate fixture entry keeps the shared preview frame and its stores untouched.
const open = async (page: Page, theme: 'light' | 'dark', query = '') => {
  await page.route('**/preview.html?first-run*', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, body: (await response.text()).replace('/src/preview/main.tsx', '/src/preview/first-run.tsx') })
  })
  await page.setViewportSize({ width: 1100, height: 800 })
  await page.emulateMedia({ colorScheme: theme })
  await page.goto(`/preview.html?first-run${query}`)
  await expect(page.getByText('What should we build?', { exact: true })).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
}

for (const theme of ['light', 'dark'] as const) {
  test(`first-run preview frame in ${theme}`, async ({ page }) => {
    await open(page, theme)
    if (process.env.FIRST_RUN_FRAMES_DIR) {
      if (process.env.FIRST_RUN_FRAME_PREFIX !== 'before') await expect(page.getByRole('button', { name: 'Add Beta', exact: true })).toBeVisible()
      await page.screenshot({ path: path.join(process.env.FIRST_RUN_FRAMES_DIR, `${process.env.FIRST_RUN_FRAME_PREFIX ?? 'after'}-${theme}.png`) })
    }
  })

  test(`installed runtimes add in one click and reach the composer in ${theme}`, async ({ page }) => {
    await open(page, theme)
    const offer = page.getByRole('group', { name: 'Installed on this Mac' })
    await expect(offer).toContainText('Beta')
    await expect(offer).toContainText('Gamma')
    await offer.getByRole('button', { name: 'Add Beta', exact: true }).click()
    await expect(offer).not.toContainText('Beta')
    await expect(page.getByText('Sessions you start in Alpha CLI and Beta CLI appear in the sidebar too.', { exact: false })).toBeVisible()
    await offer.getByRole('button', { name: 'Add Gamma', exact: true }).click()
    await expect(offer).toHaveCount(0)
    // The runtime chooser carries its question in its title; folded, the title also names the runtime.
    const chooser = page.getByRole('button').and(page.getByTitle(/Which agent starts this conversation$/))
    await expect(chooser).toHaveAccessibleName(/^Alpha/)
    await expect(chooser).toBeEnabled()
    await chooser.click()
    await expect(page.getByRole('menuitemradio', { name: /Beta/ })).toBeVisible()
    await expect(page.getByRole('menuitemradio', { name: /Gamma/ })).toBeVisible()
    await page.getByRole('menuitemradio', { name: /Beta/ }).click()
    await expect(chooser).toHaveAccessibleName(/^Beta/)
  })

  test(`nothing installed leaves no offer in ${theme}`, async ({ page }) => {
    await open(page, theme, '&none')
    await expect(page.getByRole('group', { name: 'Installed on this Mac' })).toHaveCount(0)
  })
}
