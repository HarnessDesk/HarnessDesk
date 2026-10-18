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


for (const theme of ['light', 'dark'] as const) for (const scene of ['running', 'running-message'] as const) {
  test(`Lead ${scene} keeps Stop in the composer corner in ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1280, height: 1000 })
    await page.goto(`/preview.html?lead-synthetic=${scene}&theme=${theme}`)
    const track = page.locator('[data-composer-track="send"]')
    const stop = track.getByRole('button', { name: 'Stop', exact: true })
    await expect(stop).toBeVisible()
    await expect(page.locator('[data-slot="top-bar"]')).not.toContainText('Stop goal')
    await expect(track.locator('button')).toHaveCount(scene === 'running-message' ? 2 : 1)
    await page.evaluate(async () => { await document.fonts.ready })
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 1000 })
      await expect(stop).toBeInViewport()
      const stopBox = await stop.boundingBox(), trackBox = await track.boundingBox()
      expect(stopBox).not.toBeNull(); expect(trackBox).not.toBeNull()
      expect(stopBox!.x).toBeGreaterThanOrEqual(trackBox!.x)
      expect(stopBox!.x + stopBox!.width).toBeLessThanOrEqual(trackBox!.x + trackBox!.width)
      await page.screenshot({ path: info.outputPath(`lead-${scene}-${width}-${theme}.png`) })
    }
    await stop.click()
    const confirm = page.getByRole('alertdialog', { name: 'Stop this goal?' })
    await expect(confirm).toContainText('Files and worktrees are left as they are.')
    await confirm.getByRole('button', { name: 'Keep working', exact: true }).click()
    await expect(confirm).toHaveCount(0)
    await expect(stop).toBeFocused()
    await stop.click()
    await confirm.getByRole('button', { name: 'Stop goal', exact: true }).click()
    await expect(confirm).toHaveCount(0)
    await expect(stop).toHaveCount(0)
    await expect(page.getByRole('textbox', { name: 'Goal or message' })).toBeEnabled()
  })
}
