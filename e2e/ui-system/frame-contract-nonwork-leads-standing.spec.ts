import { expect, test } from '@playwright/test'
import { WALL_THEMES } from './frame-wall-destinations'
import { openFrame } from './frame-contract-helpers'
import { useFrameContractEvidence } from './frame-contract-split-setup'
import { windowBar, expectLead, expectQuietSettings, nonworkGroups } from './frame-contract-window-leads-helpers'

useFrameContractEvidence()

for (const theme of WALL_THEMES) for (const [group, destinations] of nonworkGroups.entries()) {
  {

for (const [item0, destination] of (destinations).entries()) test((`B10 standing-column place origin stays common in ${theme}${group === 0 ? '' : ` group ${group + 1}`}`) + ' [item ' + [item0].join('-') + ']', async ({ page }) => {
await openFrame(page, 'frame-wall=conversation', theme)
const referenceX = (await windowBar(page).locator('[data-topbar="place"]').boundingBox())!.x
await openFrame(page, destination.query, theme)
const bar = windowBar(page)
if (destination.id === 'e4-agent-detail') await expect(bar.locator('[data-topbar-title] > [data-slot="text"]')).toHaveText('Code reviewer')
const settings = await page.locator('[data-page-destination="settings"]:visible').count() === 1
await expectLead(bar, 1440, settings, false)
if (settings) await expectQuietSettings(page, bar)
      else {
        const origin = (await bar.locator('[data-topbar="place"]').boundingBox())!.x
        expect(Math.abs(origin - referenceX), `${destination.id}: origin ${origin}, work ${referenceX}`).toBeLessThanOrEqual(1)
      }


})
}
}
