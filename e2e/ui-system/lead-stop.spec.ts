import { expect, test } from '@playwright/test'

// Public frames use only the isolated synthetic preview facade.
for (const theme of ['light', 'dark'] as const) for (const reason of ['unavailable', 'unverifiable'] as const) {
  test(`Lead terminal predecessor ${reason} offers Stop goal in ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1280, height: 1000 })
    await page.goto(`/preview.html?lead-synthetic=predecessor-${reason}&theme=${theme}`)
    const notices = page.locator('[data-slot="composer-notices"]')
    const stop = notices.getByRole('button', { name: 'Stop goal', exact: true })
    await expect(stop).toBeVisible()
    await expect(notices).toContainText('Message Dex to change the plan, or stop this goal.')
    await expect(page.getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0)
    await page.evaluate(async () => { await document.fonts.ready })
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 1000 })
      await expect(stop).toBeInViewport()
      await page.screenshot({ path: info.outputPath(`lead-predecessor-${reason}-${width}-${theme}.png`) })
    }
    await stop.click()
    const confirm = page.getByRole('alertdialog', { name: 'Stop this goal?' })
    await expect(confirm).toContainText('Files and worktrees are left as they are.')
    await page.screenshot({ path: info.outputPath(`lead-stop-confirm-${reason}-${theme}.png`) })
    await confirm.getByRole('button', { name: 'Keep working', exact: true }).click()
    await expect(confirm).toHaveCount(0)
    await stop.click()
    await confirm.getByRole('button', { name: 'Stop goal', exact: true }).click()
    await expect(confirm).toHaveCount(0)
    await expect(stop).toHaveCount(0)
    await expect(page.getByRole('textbox', { name: 'Goal or message' })).toBeEnabled()
  })
}
