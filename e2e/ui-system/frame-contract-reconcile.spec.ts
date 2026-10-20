import { selectRunView } from './run-frame-actions'
import { expect, test } from '@playwright/test'
import { WALL_THEMES, WALL_WIDTHS } from './frame-wall-destinations'
import { selectFrameTab } from './frame-actions'
import { openFrame } from './frame-contract-helpers'
import { teamDetails } from './team-frame-actions'


// Contract runs measure the preview; the final wall owns images and recordings.
test.use({ screenshot: 'off', trace: 'off', video: 'off' })


for (const theme of WALL_THEMES) for (const width of WALL_WIDTHS) {
  test(`B11a reconcile step rails stay below dots and stop at group ends at ${width} in ${theme}`, async ({ page }, testInfo) => {
    await openFrame(page, 'frame-wall=team-run-recorded', theme, width)
    await selectFrameTab(page, 'run')
    await selectRunView(page.locator('[data-frame-id="frame-wall"]'), 'Timeline')
    const timeline = page.locator('[aria-label="Run timeline"]')
    await expect(timeline.locator('[data-slot="timeline-item"]')).toHaveCount(5)
    const geometry = await timeline.evaluate(node => [...node.children].map(item => {
      const rect = item.getBoundingClientRect(), rail = item.querySelector<HTMLElement>(':scope > [data-slot="timeline-rail"]')!
      const line = rail.getBoundingClientRect()
      return { slot: item.getAttribute('data-slot'), x: rect.x, y: rect.y, height: rect.height,
        rail: { display: getComputedStyle(rail).display, x: line.x, y: line.y, bottom: line.bottom, width: line.width },
        last: item.nextElementSibling?.getAttribute('data-slot') !== 'timeline-item' }
    }))
    await testInfo.attach('step-rail-geometry', { body: JSON.stringify(geometry, null, 2), contentType: 'application/json' })
    for (const item of geometry) {
      if (item.slot === 'timeline-section' || item.last) expect(item.rail.display).toBe('none')
      else {
        expect(item.rail.y - item.y).toBe(22)
        expect(item.rail.x - item.x).toBe(9)
        expect(item.rail.bottom).toBe(item.y + item.height)
        expect(item.rail.width).toBe(1)
      }
    }
  })
  test(`B11a older Run facts stay aligned and unknown cost is explicit in details at ${width} in ${theme}`, async ({ page }, testInfo) => {
    await openFrame(page, 'run-dock&older', theme, width)
    await selectFrameTab(page, 'run')
    const panel = await teamDetails(page.locator('#run-dock-frame'))
    const facts = panel.locator('[aria-label="Team Run facts"]')
    for (const key of ['State', 'Flow', 'Progress', 'Elapsed']) await expect(facts.locator('dt').filter({ hasText: new RegExp(`^${key}$`) })).toHaveCount(1)
    await expect(facts).toContainText('Running')
    await expect(panel).not.toContainText('Not recorded for this Run:')
    const geometry = await facts.locator('[data-slot="summary-item"]').evaluateAll(nodes => nodes.map(node => {
      const key = node.querySelector('dt')!, value = node.querySelector<HTMLElement>('[data-slot="summary-value"]')!
      return { keyX: key.getBoundingClientRect().x, valueX: value.getBoundingClientRect().x,
        size: parseFloat(getComputedStyle(value).fontSize), token: parseFloat(getComputedStyle(value).getPropertyValue('--hd-text-sm')) }
    }))
    await testInfo.attach('run-facts-geometry', { body: JSON.stringify(geometry, null, 2), contentType: 'application/json' })
    expect(new Set(geometry.map(row => Math.round(row.valueX))).size).toBe(1)
    expect(geometry.every(row => row.valueX > row.keyX && row.size === row.token)).toBe(true)
    await panel.getByRole('button', { name: 'Record details', exact: true }).click()
    const cost = panel.locator('[aria-label="Run record details"] [data-slot="summary-item"]').filter({ hasText: /^Seat cost/ })
    await expect(cost).toHaveText('Seat costNot recorded')
    await expect(cost).not.toContainText('$0')
  })
}
