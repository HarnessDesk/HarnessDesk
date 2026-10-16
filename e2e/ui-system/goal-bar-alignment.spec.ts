import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) {
  test(`standing goal parts share the bar centre in ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1408, height: 900 })
    await page.goto(`/preview.html?frame-wall=conversation&theme=${theme}`)
    const bar = page.locator('[data-slot="alert"]').filter({ has: page.getByRole('button', { name: 'Clear goal', exact: true }) })
    await expect(bar).toBeVisible()
    await page.evaluate(async () => { await document.fonts.ready })
    await expect(bar).toContainText('35% of budget')
    await expect(bar).toContainText('in progress')

    const frameDir = process.env.GOAL_BAR_FRAME_DIR
    if (frameDir) {
      await bar.screenshot({ path: `${frameDir}/${process.env.GOAL_BAR_FRAME_PREFIX ?? 'after'}-${theme}.png` })
    }

    const centres = await bar.evaluate(element => {
      const centre = (node: Element) => {
        const box = node.getBoundingClientRect()
        return box.top + box.height / 2
      }
      // Match the notice contract: text uses its cap-height glyph box,
      // independent of the font's asymmetric ascent/descent and line height.
      const capCentre = (node: Element) => {
        const range = document.createRange()
        range.selectNodeContents(node)
        const line = range.getBoundingClientRect()
        const style = getComputedStyle(node)
        const context = document.createElement('canvas').getContext('2d')!
        context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
        const font = context.measureText(node.textContent ?? '')
        const cap = context.measureText('H')
        const baseline = line.top + (line.height - font.fontBoundingBoxAscent - font.fontBoundingBoxDescent) / 2 + font.fontBoundingBoxAscent
        return baseline - cap.actualBoundingBoxAscent / 2
      }
      const clear = element.querySelector('button[aria-label="Clear goal"]')!
      const chip = element.querySelector('[data-slot="chip"]')!
      return {
        bar: centre(element),
        icon: centre(element.querySelector('[data-role="meta"] svg')!),
        objective: capCentre(element.querySelector('[data-role="row"]')!),
        budget: capCentre(element.querySelector('[data-role="meta"]:not(:has(svg))')!),
        chip: centre(chip),
        status: capCentre(chip),
        clear: centre(clear),
        clearGlyph: centre(clear.querySelector('svg')!),
      }
    })
    await testInfo.attach('vertical-centres', { body: JSON.stringify(centres, null, 2), contentType: 'application/json' })
    for (const [part, centre] of Object.entries(centres)) {
      expect.soft(Math.abs(centre - centres.bar), `${part} centre against bar`).toBeLessThanOrEqual(1)
    }
  })
}
