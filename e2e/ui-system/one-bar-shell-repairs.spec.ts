import { expect, test } from '@playwright/test'
import { openFrame } from './frame-contract-helpers'
import { selectTeamPage } from './team-frame-actions'
import { selectRunView } from './run-frame-actions'

for (const theme of ['light', 'dark'] as const) {
  for (const width of [1100, 1800]) test(`Teams shares the page heading inset at ${width} in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=agents', theme, width)
    const agents = (await page.getByRole('heading', { level: 1 }).boundingBox())!
    await openFrame(page, 'frame-wall=teams', theme, width)
    const teams = (await page.getByRole('heading', { level: 1 }).boundingBox())!
    expect(teams.y).toBe(agents.y)
  })

  test(`the swapped pane keeps its resize seam on the shared boundary in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation', theme, 1800)
    await page.getByRole('button', { name: 'Browser', exact: true }).click()
    const pane = page.locator('[data-frame-region="right"]')
    const seam = page.getByRole('separator', { name: 'Resize the right panel', exact: true })
    await page.getByRole('button', { name: 'Swap pane into main', exact: true }).click()
    const boundary = async () => {
      const box = (await pane.boundingBox())!, handle = (await seam.boundingBox())!
      // Focus expands the seam's hit area symmetrically around its edge.
      expect(Math.abs(handle.x + handle.width / 2 - box.x - box.width)).toBeLessThanOrEqual(1)
    }
    await boundary()
    const subject = page.locator('[data-frame-region="main"]')
    const width = (await subject.boundingBox())!.width
    await seam.focus()
    await seam.press('ArrowLeft')
    await expect.poll(async () => (await subject.boundingBox())!.width).toBeGreaterThan(width)
    await boundary()
  })

  test(`embedded previews retain Flow through pushes without owning window commands in ${theme}`, async ({ page }) => {
    await openFrame(page, 'flow-overlay', theme)
    const frame = page.locator('#flow-overlay-live')
    await expect(page.locator('[data-slot="top-bar"]')).toHaveCount(1)
    await expect(page.getByRole('navigation', { name: 'Workspace actions', exact: true })).toHaveCount(0)
    await selectTeamPage(frame, 'run')
    await selectRunView(frame, 'Flow')
    const run = frame.locator('[data-slot="run-workspace"]')
    await expect(run).toHaveAttribute('data-view', 'flow')
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('flow-overlay-scene', { detail: 'review' })))
    await expect(frame).toHaveAttribute('data-scene', 'review')
    await expect(run).toHaveAttribute('data-view', 'flow')
    await page.keyboard.press('Meta+,')
    await page.evaluate(() => window.dispatchEvent(new Event('harnessdesk:review')))
    await expect(run).toHaveAttribute('data-view', 'flow')
    await expect(page.locator('[data-page-destination]:visible')).toHaveCount(0)
  })
}
