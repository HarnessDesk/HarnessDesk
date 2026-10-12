import { expect, test } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'
import { WALL_THEMES } from './frame-wall-destinations'
import { applyFrameActions, selectFrameTab } from './frame-actions'
import { openFrame, B6_WORK_DESTINATIONS, B10_NONWORK_DESTINATIONS } from './frame-contract-helpers'


// Contract runs measure the preview; the final wall owns images and recordings.
test.use({ screenshot: 'off', trace: 'off', video: 'off' })

for (const theme of WALL_THEMES) for (const width of [720, 1440]) {
  test(`B10 nonwork place hierarchy and lead follow window state at ${width} in ${theme}`, async ({ page }) => {
    const hidden = width === 1440 ? '&frame-sidebar-hidden=1' : ''
    await openFrame(page, `frame-wall=conversation${hidden}`, theme, width)
    const referenceX = (await page.locator('[data-slot="top-bar"] [data-topbar="place"]').boundingBox())!.x
    const measured: { destination: string; origin: number; childX: number; titleWidth: number }[] = []
    for (const destination of B10_NONWORK_DESTINATIONS) {
      await openFrame(page, `${destination.query}${hidden}`, theme, width)
      const bar = page.locator('[data-slot="top-bar"]:visible')
      if (destination.id === 'agent') await expect(bar.locator('[data-topbar-title]')).toContainText('Implementer')
      await expect(bar.locator('[data-topbar="lead"]').getByRole('button')).toHaveCount(width === 720 ? 1 : 3)
      await expect(bar.locator('[data-topbar="lead"]').getByRole('button', { name: 'Show sidebar', exact: true })).toBeVisible()
      await expect(bar.locator('[data-work-tool]')).toHaveCount(0)
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
for (const theme of WALL_THEMES) {
  test(`B10 standing-column place origin stays common in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation', theme)
    const referenceX = (await page.locator('[data-slot="top-bar"] [data-topbar="place"]').boundingBox())!.x
    for (const destination of B10_NONWORK_DESTINATIONS) {
      await openFrame(page, destination.query, theme)
      const bar = page.locator('[data-slot="top-bar"]:visible')
      if (destination.id === 'agent') await expect(bar.locator('[data-topbar-title]')).toContainText('Implementer')
      await expect(bar.locator('[data-topbar="lead"]').getByRole('button')).toHaveCount(0)
      const origin = (await bar.locator('[data-topbar="place"]').boundingBox())!.x
      expect(Math.abs(origin - referenceX), `${destination.id}: origin ${origin}, work ${referenceX}`).toBeLessThanOrEqual(1)
    }
  })
}
for (const theme of WALL_THEMES) {
  for (const width of [720, 1440]) for (let group = 0; group < Math.ceil(B6_WORK_DESTINATIONS.length / 9); group++) {
    test(`B6 lead follows window state on work destinations group ${group + 1} at ${width} in ${theme}`, async ({ page }) => {
      await openFrame(page, 'frame-wall=conversation', theme, width)
      if (width === 1440) await page.getByRole('button', { name: 'Hide sidebar', exact: true }).click()
      const referenceX = (await page.locator('[data-slot="top-bar"] [data-topbar-title]').boundingBox())!.x
      const titleXs: number[] = [referenceX]
      for (const destination of B6_WORK_DESTINATIONS.slice(group * 9, (group + 1) * 9)) {
        await openFrame(page, destination.query, theme, width)
        if (width === 1440) await page.getByRole('button', { name: 'Hide sidebar', exact: true }).click()
        await applyFrameActions(page, destination)
        const bar = page.locator('[data-slot="top-bar"]:visible').first()
        const lead = bar.locator('[data-topbar="lead"]')
        await expect(lead.getByRole('button')).toHaveCount(width === 720 ? 1 : 3)
        await expect(lead.getByRole('button', { name: 'Show sidebar', exact: true })).toBeVisible()
        await expect.poll(async () => (await bar.locator('[data-topbar-title]').boundingBox())?.width ?? 0,
          { message: `${destination.id} title floor` }).toBeGreaterThanOrEqual(FRAME.bar.titleMin)
        titleXs.push((await bar.locator('[data-topbar-title]').boundingBox())!.x)
      }
      expect(Math.max(...titleXs) - Math.min(...titleXs)).toBeLessThanOrEqual(1)
    })
  }
  test(`B6 one visible tile keeps its own draft and the room Holding chip in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=team', theme)
    await selectFrameTab(page, 'room')
    await page.getByRole('button', { name: 'Send to', exact: true }).click()
    await page.getByRole('switch', { name: 'Hold messages', exact: true }).click()
    const roomChip = page.locator('[data-slot="room-body"] [data-slot="composer-chip"]').filter({ hasText: 'Holding messages' })
    const title = await roomChip.getAttribute('title')
    await page.getByRole('button', { name: 'View', exact: true }).click()
    await page.getByRole('menuitemradio', { name: 'Side by side', exact: true }).click()
    await page.locator('[data-slot="side-by-side-tile"]:visible').first().getByRole('button', { name: / actions$/ }).click()
    await page.getByRole('menuitem', { name: /^Expand / }).click()
    await expect(page.locator('[data-slot="side-by-side-tile"]:visible')).toHaveCount(1)
    await expect(page.locator('[data-shared-composer]:visible')).toHaveCount(0)
    const own = page.locator('[data-slot="side-by-side-tile"]:visible [data-slot="composer"]')
    const chip = own.locator('[data-slot="composer-chip"]').filter({ hasText: 'Holding messages' })
    await expect(chip).toBeVisible()
    await expect(chip).toHaveAttribute('title', title!)
    await own.locator('textarea').fill('Keep this member draft')
    await expect(own.locator('textarea')).toBeEnabled()
    await expect(own.getByRole('button', { name: 'Send to', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'View', exact: true }).click()
    await page.getByRole('menuitemradio', { name: 'Thread', exact: true }).click()
    await page.getByRole('button', { name: 'Send to', exact: true }).click()
    await expect(page.getByRole('switch', { name: 'Hold messages', exact: true })).toHaveAttribute('aria-checked', 'true')
    await page.getByRole('switch', { name: 'Hold messages', exact: true }).click()
    await page.getByRole('button', { name: 'View', exact: true }).click()
    await page.getByRole('menuitemradio', { name: 'Side by side', exact: true }).click()
    await expect(own.locator('textarea')).toHaveValue('Keep this member draft')
    await expect(chip).toHaveCount(0)
  })
}
