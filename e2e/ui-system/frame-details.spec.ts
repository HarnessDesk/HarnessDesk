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
        const facts = body.getByRole('region', { name: 'Starts in', exact: true })
        const details = facts.getByRole('button', { name: 'Details', exact: true })
        await expect(details).toHaveAttribute('aria-expanded', 'false')
        await details.click()
        await expect(details).toHaveAttribute('aria-expanded', 'true')
        await expect(body).toContainText('Source folder; the worktree is made when the message goes')
        await expect(body).toContainText('harnessdesk/checkout-retry')
      } else {
        await expect(body).toContainText('Recovery reviewer')
        const plan = body.locator('[data-slot="checklist-item"]')
        if (state === 'cleared') {
          await expect(plan).toHaveCount(0)
          await expect(body.getByRole('region', { name: 'Plan', exact: true })).toHaveCount(0)
          await expect(body).not.toContainText('No plan yet.')
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
        await expect(body.locator('[aria-label="Conversation facts"] dt')).toHaveText(['Runtime', 'Folder', 'Branch', 'Context'])
      } else expect(keyWidths).toHaveLength(5)
      // The facts are icon rows: each key is its glyph's width.
      for (const width of keyWidths) expect(width).toBe(FRAME.summaryKey.icon)
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
      const limit = await rail.evaluate((node, inset) => {
        const main = node.closest('[data-slot="fixed-shell"]')!.querySelector('[data-frame-region="main"]')!.getBoundingClientRect()
        const clearance = Number.parseFloat(getComputedStyle(node).getPropertyValue('--hd-composer-clearance')) || 0
        return main.bottom - Math.max(clearance, inset)
      }, FRAME.rail.inset)
      // The sheet fits its content and caps its bottom above the measured
      // composer; short cards do not stretch down to the window edge.
      expect(box.y + box.height).toBeLessThanOrEqual(limit)
      expect(box.height).toBeGreaterThan(0)
      expect(box.width).toBe(FRAME.infoCard.width)
      expect(await main.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await expect(body).toBeVisible()
      await page.screenshot({ path: `output/frame-wall/B3-details-${state}-720-${theme}.png` })
      if (state === 'active') {
        await expect(body.locator('[data-slot="tool-scroll"]')).toHaveCount(1)
        const subagents = body.getByRole('region', { name: 'Sub-agents', exact: true })
        const reveal = subagents.getByRole('button', { name: 'Sub-agents', exact: true })
        await expect(reveal).toHaveAttribute('aria-expanded', 'false')
        await reveal.click()
        await expect(reveal).toHaveAttribute('aria-expanded', 'true')
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
    // Icon-row facts, then the two keyed bodies.
    await expect(page.locator('[data-slot="tool-body"]')).toHaveCount(3)
    await page.evaluate(async () => { await document.fonts.ready })
    await page.screenshot({ path: `output/frame-wall/B3-toolbody-catalogue-${theme}.png`, fullPage: true })
  })
}
