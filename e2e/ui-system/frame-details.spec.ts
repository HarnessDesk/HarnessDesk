import { expect, test } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'
import { WALL_THEMES, WALL_TIME } from './frame-wall-destinations'

// Step 6 supplements the destination wall with real Details edge states.
for (const theme of WALL_THEMES) {
  for (const state of ['active', 'complete', 'cleared', 'asked', 'armed'] as const) {
    test(`Details preserves ${state} evidence in ${theme}`, async ({ page }) => {
      await page.clock.setFixedTime(WALL_TIME)
      await page.emulateMedia({ colorScheme: theme })
      const destination = state === 'armed' ? 'draft' : 'conversation'
      await page.goto(`/preview.html?frame-wall=${destination}&frame-details-case=${state}&theme=${theme}`)
      const toggle = page.getByRole('button', { name: 'Toggle rail', exact: true })
      if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
      const body = page.locator('[data-frame-region="rail"] [data-slot="tool-body"]:visible')
      await expect(body).toBeVisible()
      if (state === 'armed') {
        await expect(body).toContainText('Source folder; the worktree is made when the message goes')
        await expect(body).toContainText('harnessdesk/checkout-retry')
      } else {
        await expect(body).toContainText('Recovery reviewer')
        const plan = body.locator('[data-slot="checklist-item"]')
        if (state === 'cleared') {
          await expect(plan).toHaveCount(0)
          await expect(body).toContainText('No plan yet.')
        } else {
          await expect(plan).toHaveCount(3)
          expect(await plan.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-state'))))
            .toEqual(state === 'complete' ? ['done', 'done', 'done'] : ['done', 'active', 'pending'])
        }
        if (state === 'asked') await expect(body).toContainText('Asked, not held')
      }
      const keyWidths = await body.locator('[aria-label="Conversation facts"] dt').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width))
      if (state === 'armed') {
        // A draft has no reported permission ceiling. Its facts must not
        // invent one merely to match a conversation's row count.
        await expect(body.locator('[aria-label="Conversation facts"] dt')).toHaveText(['Agent', 'Folder', 'Branch', 'Context'])
      } else expect(keyWidths).toHaveLength(5)
      for (const width of keyWidths) expect(width).toBe(FRAME.summaryKey.panel)
      await page.evaluate(async () => { await document.fonts.ready })
      await page.screenshot({ path: `output/frame-wall/B3-details-${state}-1440-${theme}.png` })
      await page.setViewportSize({ width: 720, height: 900 })
      // Wait for the preview store's resize frame before reading its geometry.
      // D1 floats the card rail under the bar, eight from the window edge;
      // its own toggle leaves the conversation available beside the sheet.
      const main = page.locator('[data-slot="workbench-main"]')
      await expect(main).not.toHaveAttribute('inert')
      const rail = page.locator('[data-frame-region="rail"]:visible')
      await expect.poll(async () => (await rail.boundingBox())!.y).toBe(FRAME.bar.height + FRAME.rail.inset)
      const box = (await rail.boundingBox())!
      expect(box.x + box.width).toBe(720 - FRAME.rail.inset)
      expect(box.y + box.height).toBe(900 - FRAME.rail.inset)
      expect(box.width).toBe(FRAME.infoCard.width)
      expect(await main.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await expect(body).toBeVisible()
      await page.screenshot({ path: `output/frame-wall/B3-details-${state}-720-${theme}.png` })
      if (state === 'active') {
        await expect(body.locator('[data-slot="tool-scroll"]')).toHaveCount(1)
        const reviewer = body.getByText('Recovery reviewer', { exact: true })
        await reviewer.scrollIntoViewIfNeeded()
        await expect(reviewer).toBeInViewport()
        await page.screenshot({ path: `output/frame-wall/B3-details-subagents-720-${theme}.png` })
      }
    })
  }
  test(`ToolBody catalogue in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/design.html?view=tool-body&theme=${theme}`)
    await expect(page.locator('[data-slot="tool-body"]')).toHaveCount(2)
    await page.evaluate(async () => { await document.fonts.ready })
    await page.screenshot({ path: `output/frame-wall/B3-toolbody-catalogue-${theme}.png`, fullPage: true })
  })
}
