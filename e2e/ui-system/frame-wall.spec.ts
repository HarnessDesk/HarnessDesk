import { installFramePreviewFixture } from './frame-preview-fixture'
import { applyFrameActions, settleFrameBar } from './frame-actions'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'
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
      await installFramePreviewFixture(page)
      await page.clock.setFixedTime(WALL_TIME)
      await page.emulateMedia({ colorScheme: theme })
      for (const width of WALL_WIDTHS) {
        await page.setViewportSize({ width, height: 900 })
        await page.goto(`/preview.html?${destination.query}&theme=${theme}`)
        await expect(page.locator('[data-frame-id="frame-wall"]')).toBeVisible()
        if (theme === 'dark') await expect(page.locator('body')).toHaveAttribute('data-hd-dark-theme', '')
        await applyFrameActions(page, destination)
        if (destination.id === 'agent') {
          // The selected Agent reads its real authoring document asynchronously.
          await expect(page.locator('[data-slot="top-bar"]:visible [data-topbar-title]')).toContainText('Implementer')
          await expect(page.locator('[data-slot="top-bar"]:visible').getByRole('button', { name: 'Start a conversation as Implementer', exact: true })).toBeVisible()
        }
        if (destination.id === 'conversation-file') {
          // The native editor loads after the shell; a blank box is not File evidence.
          await expect(page.locator('[data-slot="work-tools"] .cm-content')).toContainText('Storefront')
        }
        if (destination.id === 'conversation-preview') {
          // The opaque fixture guest must load its actual document before evidence.
          await expect(page.locator('[data-slot="work-tools"] iframe').contentFrame().getByRole('heading', { name: 'Storefront preview' })).toBeVisible()
        }
        if (destination.id === 'conversation-plugin') {
          // Show the actual contribution, rather than the earlier Details sections.
          const facts = page.locator('[data-slot="work-tools"]').getByText('Synthetic work facts · 長い記録', { exact: true })
          await facts.scrollIntoViewIfNeeded()
          await expect(facts).toBeInViewport()
        }
        if (destination.viewChoice === 'Flow') {
          // The native Flow engine is lazy. Its outer Run is visible while
          // Suspense still shows loading text; capture the recorded drawing.
          await expect(page.locator('[data-slot="workbench-main"] [data-slot="flow-canvas"] .react-flow__node')).toHaveCount(4)
        }
        await page.evaluate(async () => { await document.fonts.ready })
        // TopBar measures its two folds over animation frames. Capture the
        // measured contract, rather than its initial unmeasured tab row.
        for (const bar of await page.locator('[data-slot="top-bar"]:visible').all()) {
          await settleFrameBar(bar)
          const title = bar.locator('[data-topbar-title]')
          await expect.poll(async () => (await title.boundingBox())?.width ?? 0)
            .toBeGreaterThanOrEqual(FRAME.bar.titleMin)
          const ink = (await title.boundingBox())!, place = (await bar.locator('[data-topbar="place"]').boundingBox())!
          expect(ink.x + ink.width).toBeLessThanOrEqual(place.x + place.width)
        }
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
