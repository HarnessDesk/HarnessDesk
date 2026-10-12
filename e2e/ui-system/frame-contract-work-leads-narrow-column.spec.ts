import { expect, test } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'
import { WALL_THEMES } from './frame-wall-destinations'
import { applyFrameActions } from './frame-actions'
import { openFrame, B6_WORK_DESTINATIONS } from './frame-contract-helpers'
import { useFrameContractEvidence } from './frame-contract-split-setup'
import { windowBar, expectLead } from './frame-contract-window-leads-helpers'

useFrameContractEvidence()

for (const theme of WALL_THEMES) {
  for (const width of [720]) for (let group = 10; group < Math.ceil(B6_WORK_DESTINATIONS.length / 9); group++) {
    test.describe(`B6 lead follows window state on work destinations group ${group + 1} at ${width} in ${theme}`, () => {
      test.describe.configure({ mode: 'default' }); const allOrigins: number[] = [];
      {

        for (const [item0, destination] of (B6_WORK_DESTINATIONS.slice(group * 9, (group + 1) * 9)).entries()) test(`B6 lead follows window state on work destinations group ${group + 1} at ${width} in ${theme} [item ${[item0].join('-')}]`, async ({ page }) => {
          await openFrame(page, 'frame-wall=conversation', theme, width)
          if (width === 1440) await page.getByRole('button', { name: 'Hide sidebar', exact: true }).click()
          await expectLead(windowBar(page), width, false, true)
          const referenceX = (await windowBar(page).locator('[data-topbar="place"]').boundingBox())!.x
          const titleXs: number[] = [referenceX]
          await openFrame(page, destination.query, theme, width)
          if (width === 1440) await page.getByRole('button', { name: 'Hide sidebar', exact: true }).click()
          await applyFrameActions(page, destination)
          const bar = windowBar(page)
          const lead = bar.locator('[data-topbar="lead"]')
          await expectLead(bar, width, false, true)
          await expect(lead.getByRole('button', { name: 'Show sidebar', exact: true })).toBeVisible()
          await expect.poll(async () => (await bar.locator('[data-topbar-title]').boundingBox())?.width ?? 0,
            { message: `${destination.id} title floor` }).toBeGreaterThanOrEqual(FRAME.bar.titleMin)
          titleXs.push((await bar.locator('[data-topbar="place"]').boundingBox())!.x)
          allOrigins.push(...titleXs);
          expect(Math.max(...titleXs) - Math.min(...titleXs), JSON.stringify({ referenceX, titleXs })).toBeLessThanOrEqual(1)
        })
      }
      test.afterAll(() => { expect(Math.max(...allOrigins) - Math.min(...allOrigins)).toBeLessThanOrEqual(1) })
    })
  }
}

