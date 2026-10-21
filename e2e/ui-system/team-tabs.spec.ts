import { selectTeamPage } from './team-frame-actions'
import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'

for (const theme of ['light', 'dark'] as const) {
  for (const width of [1440, 360]) {
    test(`Team tabs keep small gaps and View on their row at ${width} in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 })
      await page.emulateMedia({ colorScheme: theme })
      await page.goto(`/preview.html?comparison-verdict=combined&theme=${theme}`)
      const frame = page.locator('[data-frame-id="comparison-combined"]')
      const tabs = frame.getByRole('tablist', { name: 'Team views', exact: true })
      await selectTeamPage(frame, 'room')
      const view = frame.getByRole('button', { name: /^(Chat|Split)$/ })
      const tiles = frame.locator('[data-slot="side-by-side-tile"]')
      await expect(tiles).toHaveCount(2)
      await page.evaluate(() => document.fonts.ready)
      const bar = (await frame.locator('[data-slot="top-bar"]').locator('..').boundingBox())!
      const tabBox = (await tabs.boundingBox())!
      const viewBox = (await view.boundingBox())!
      const tileBox = (await tiles.first().boundingBox())!
      const step = await tabs.evaluate(node => parseFloat(getComputedStyle(node).getPropertyValue('--hd-space-2')))
      const body = (await frame.locator('[data-slot="room-body"]').boundingBox())!
      const gaps = { above: tabBox.y - bar.y - bar.height, below: tileBox.y - tabBox.y - tabBox.height, viewTop: viewBox.y - tabBox.y }
      expect.soft(gaps.above).toBe(step)
      expect.soft(body.y - tabBox.y - tabBox.height).toBe(step)
      // Narrow Side by side adds its decision and Seat picker before the tile.
      if (width === 1440) expect.soft(gaps.below).toBe(step)
      expect.soft(Math.abs(gaps.viewTop)).toBeLessThanOrEqual(1)
      expect.soft(viewBox.x).toBeGreaterThanOrEqual(tabBox.x + tabBox.width)
      const gutter = await tabs.evaluate(node => parseFloat(getComputedStyle(node).getPropertyValue('--hd-space-6')))
      const room = (await frame.locator('[data-slot="team-room"]').boundingBox())!
      expect.soft(tabBox.x - room.x).toBe(gutter)
      expect.soft(room.x + room.width - viewBox.x - viewBox.width).toBe(gutter)
      expect.soft(await tabs.evaluate(node => getComputedStyle(node).overflowX)).toBe('auto')
      await expect(tabs.getByRole('tab')).toHaveCount(3)
      // Every destination stays reachable even when the strip must scroll.
      await selectTeamPage(frame, 'findings')
      await expect(frame.locator('[data-slot="task-navigation"]').getByRole('button', { name: /^Findings(?:\s|$)/ })).toHaveAttribute('aria-pressed', 'true')
    })
  }

  test(`Team Chat and Work preview frames in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?comparison-verdict=combined&theme=${theme}`)
    const frame = page.locator('[data-frame-id="comparison-combined"]')
    await selectTeamPage(frame, 'room')
    await expect(frame.locator('[data-slot="side-by-side-tile"]')).toHaveCount(2)
    const directory = process.env.TEAM_TABS_SHOTS_DIR
    for (const tab of ['room', 'overview']) {
      if (tab === 'overview') await frame.locator('[data-team-page="overview"]').click()
      await expect(frame.locator(`[data-team-page="${tab}"]`)).toHaveAttribute('data-active', '')
      await page.evaluate(() => document.fonts.ready)
      if (directory) {
        mkdirSync(directory, { recursive: true })
        await frame.screenshot({ path: `${directory}/${tab}-${theme}.png` })
      }
    }
  })
}
