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
  test(`B11a reconcile missing Run facts use secondary 12px type on the key edge at ${width} in ${theme}`, async ({ page }, testInfo) => {
    await openFrame(page, 'frame-wall=team-run-recorded', theme, width)
    await selectFrameTab(page, 'run')
    const panel = await teamDetails(page.locator('[data-frame-id="frame-wall"]'))
    const note = panel.locator('[data-slot="tool-prose"]').filter({ hasText: 'Not recorded for this Run:' })
    await expect(note).toBeVisible()
    const geometry = await note.evaluate(node => {
      const text = node.querySelector<HTMLElement>('[data-slot="text"]')!, style = getComputedStyle(text)
      const key = node.parentElement!.querySelector('dt')!
      const probe = document.createElement('span'); probe.style.color = 'var(--hd-secondary-foreground)'; node.append(probe)
      const secondaryColor = getComputedStyle(probe).color; probe.remove()
      const range = document.createRange(); range.selectNodeContents(text)
      return { x: range.getBoundingClientRect().x, y: range.getBoundingClientRect().y, keyX: key.getBoundingClientRect().x,
        size: parseFloat(style.fontSize), color: style.color, secondaryColor }
    })
    await testInfo.attach('missing-facts-geometry', { body: JSON.stringify(geometry, null, 2), contentType: 'application/json' })
    expect(geometry.size).toBe(12)
    expect(geometry.color).toBe(geometry.secondaryColor)
    expect(geometry.x).toBe(geometry.keyX)
  })
}
