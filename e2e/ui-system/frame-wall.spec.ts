import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { WALL_DESTINATIONS, WALL_THEMES, WALL_TIME, WALL_WIDTHS } from './frame-wall-destinations'

/**
 * The frame wall: every destination at three widths in both themes.
 *
 * A capture, not a verdict on looks — a reviewer reads these frames against
 * the look checklist. It runs only when asked:
 *   FRAME_WALL_DIR=output/frame-wall/after pnpm test:ui-system frame-wall.spec.ts
 *   FRAME_WALL_COMPARE=1 pnpm test:ui-system frame-wall.spec.ts            (against the approved frames)
 *   FRAME_WALL_COMPARE=1 pnpm test:ui-system frame-wall.spec.ts --update-snapshots   (record the owner's approval)
 * Approved frames live under output/ (gitignored): CI's fonts differ from
 * macOS, so a committed baseline would fail on smoothing, not design.
 */
const DIRECTORY = process.env.FRAME_WALL_DIR
const COMPARE = process.env.FRAME_WALL_COMPARE === '1'
test.skip(!DIRECTORY && !COMPARE, 'set FRAME_WALL_DIR or FRAME_WALL_COMPARE=1 to capture the wall')

for (const destination of WALL_DESTINATIONS) {
  for (const theme of WALL_THEMES) {
    test(`frame wall: ${destination.id} in ${theme}`, async ({ page }) => {
      await page.clock.setFixedTime(WALL_TIME)
      await page.emulateMedia({ colorScheme: theme })
      for (const width of WALL_WIDTHS) {
        await page.setViewportSize({ width, height: 900 })
        await page.goto(`/preview.html?${destination.query}&theme=${theme}`)
        await expect(page.locator('[data-frame-id="frame-wall"]')).toBeVisible()
        if (theme === 'dark') await expect(page.locator('body')).toHaveAttribute('data-hd-dark-theme', '')
        if ('tab' in destination) await page.locator(`[data-team-page="${destination.tab}"]`).first().click()
        await page.evaluate(async () => { await document.fonts.ready })
        const name = `${destination.id}-${width}-${theme}.png`
        if (DIRECTORY) {
          mkdirSync(DIRECTORY, { recursive: true })
          await page.screenshot({ path: path.join(DIRECTORY, name) })
        }
        if (COMPARE) await expect(page).toHaveScreenshot(name, { maxDiffPixelRatio: 0.002, animations: 'disabled' })
      }
    })
  }
}
