import { expect, test } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'
import { WALL_THEMES } from './frame-wall-destinations'
import { openFrame } from './frame-contract-helpers'
import { useFrameContractEvidence } from './frame-contract-split-setup'
import { windowBar, expectLead, expectQuietSettings, nonworkGroups } from './frame-contract-window-leads-helpers'

useFrameContractEvidence()

for (const theme of WALL_THEMES) for (const width of [1440]) for (const [group, destinations] of nonworkGroups.entries()) {
  {

for (const [item0, destination] of (destinations).entries()) test((`B10 nonwork place hierarchy and lead follow window state at ${width} in ${theme}${group === 0 ? '' : ` group ${group + 1}`}`) + ' [item ' + [item0].join('-') + ']', async ({ page }) => {
const hidden = width === 1440 ? '&frame-sidebar-hidden=1' : ''
await openFrame(page, `frame-wall=conversation${hidden}`, theme, width)
const referenceX = (await windowBar(page).locator('[data-topbar="place"]').boundingBox())!.x
const measured: { destination: string; origin: number; childX: number; titleWidth: number }[] = []
await openFrame(page, `${destination.query}${hidden}`, theme, width)
const bar = windowBar(page)
if (destination.id === 'e4-agent-detail') await expect(bar.locator('[data-topbar-title] > [data-slot="text"]')).toHaveText('Code reviewer')
const settings = await page.locator('[data-page-destination="settings"]:visible').count() === 1
await expectLead(bar, width, settings, true)
await expect(bar.locator('[data-work-tool]')).toHaveCount(0)
if (settings) await expectQuietSettings(page, bar)
      else {
        await expect.poll(async () => (await bar.locator('[data-topbar-title]').boundingBox())?.width ?? 0,
          { message: `${destination.id} child title floor` }).toBeGreaterThanOrEqual(FRAME.bar.titleMin)
        const title = (await bar.locator('[data-topbar-title]').boundingBox())!
        const origin = (await bar.locator('[data-topbar="place"]').boundingBox())!.x
        // Bars slot 2 and the approved Agent/Settings drawing put the parent
        // before the child. Pin that entire place origin, and separately keep
        // the child title's unchanged 180px floor; work title-x stays in B6.
        expect(Math.abs(origin - referenceX), `${destination.id} place origin`).toBeLessThanOrEqual(1)
        measured.push({ destination: destination.id, origin, childX: title.x, titleWidth: title.width })
      }

await test.info().attach('nonwork-place-measurements', { body: JSON.stringify(measured, null, 2), contentType: 'application/json' })
})
}
}
