import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) {
  test(`the table family shares row centres, density and selection in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/preview.html?tables')
    await page.evaluate(async () => { await document.fonts.ready })
    for (const density of ['comfortable', 'compact'] as const) {
      const section = page.locator(`section[data-hd-table="${density}"]`)
      const geometry = await section.evaluate(root => {
        const centre = (el: Element) => { const r = el.getBoundingClientRect(); return (r.top + r.bottom) / 2 }
        const firstCell = root.querySelector('[data-slot="table-cell"]')!
        const lead = firstCell.querySelector('[data-slot="table-cell-lead"]')!
        const list = root.querySelector('[data-slot="list-row"]')!
        const settings = root.querySelector('[data-slot="row"]')!
        const action = root.querySelector('[data-slot="row-folding"]')!
        const rule = action.querySelector('button')!
        const stack=root.querySelector('[data-slot="table-cell-lead"] [data-slot="face-stack"]')!
        const stackLead=stack.parentElement!.getBoundingClientRect()
        return {
          head: root.querySelector('[data-slot="table-head"]')!.getBoundingClientRect().height,
          row: firstCell.getBoundingClientRect().height,
          face: lead.getBoundingClientRect().width,
          radius: getComputedStyle(lead).borderTopLeftRadius,
          centreAlign: getComputedStyle(root.querySelector('[data-slot="table-cell"][data-align="center"]')!).textAlign,
          cellCentre: Math.abs(centre(firstCell) - centre(lead)),
          listFace: list.querySelector('[data-shape="face"]')!.getBoundingClientRect().width,
          listRadius: getComputedStyle(list.querySelector('[data-shape="face"]')!).borderTopLeftRadius,
          listCentre: Math.abs(centre(list) - centre(list.querySelector('[data-slot="list-row-lead"]')!)),
          controlCentre: Math.abs(centre(settings) - centre(settings.querySelector('[data-slot="row-ctl"]')!)),
          divider: getComputedStyle(action).borderBottomWidth,
          innerDivider: getComputedStyle(rule, '::after').display,
          description: getComputedStyle(settings.querySelector('[data-slot="row-desc"]')!).fontSize,
          name: getComputedStyle(list.querySelector('[data-slot="list-row-title"]')!).fontSize,
          numeric: getComputedStyle(root.querySelector('[data-slot="table-cell"][data-align="end"]')!).textAlign,
          stackFits:[...stack.querySelectorAll('[data-shape="face"]'),stack.lastElementChild!].every(el=>{
            const box=el.getBoundingClientRect();return box.left>=stackLead.left-1&&box.right<=stackLead.right+1
          }),
        }
      })
      expect(geometry.head).toBe(density === 'compact' ? 32 : 40)
      expect(geometry.row).toBeGreaterThanOrEqual(density === 'compact' ? 40 : 56)
      expect(geometry.face).toBe(density === 'compact' ? 24 : 32)
      expect(geometry.listFace).toBe(density === 'compact' ? 24 : 32)
      expect(geometry.listRadius).toBe(density === 'compact' ? '6px' : '8px')
      expect(geometry.radius).toBe(density === 'compact' ? '6px' : '8px')
      expect(geometry.centreAlign).toBe('center')
      expect(geometry.description).toBe('13px')
      expect(geometry.name).toBe(density === 'compact' ? '13px' : '14px')
      for (const delta of [geometry.cellCentre, geometry.listCentre, geometry.controlCentre]) expect(delta).toBeLessThan(1)
      expect(geometry.divider).toBe('1px')
      expect(geometry.innerDivider).toBe('none')
      expect(geometry.numeric).toBe('right')
      expect(geometry.stackFits).toBe(true)

      const interactive = section.locator('[data-interactive]').first()
      const reading = section.locator('[data-slot="table-row"]').nth(3)
      const resting = await reading.evaluate(el => getComputedStyle(el).backgroundColor)
      await reading.hover()
      expect(await reading.evaluate(el => getComputedStyle(el).backgroundColor)).toBe(resting)
      await interactive.hover()
      expect(await interactive.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(resting)
      const selected = section.locator('[data-slot="table-row"][data-state="selected"]').first()
      const fill = await selected.evaluate(el => getComputedStyle(el).backgroundColor)
      await selected.hover()
      expect(await selected.evaluate(el => getComputedStyle(el).backgroundColor)).toBe(fill)
      const pinned = section.locator('[data-slot="table-head"][data-pinned]')
      const selectedGround = await pinned.evaluate(el => getComputedStyle(el).backgroundImage)
      await pinned.hover()
      expect(await pinned.evaluate(el => getComputedStyle(el).backgroundImage)).toBe(selectedGround)
    }
  })
}

test('the preview and Tables catalogue mount the same family, including a narrow pane', async ({ page }) => {
  await page.goto('/design.html?view=tables')
  await expect(page.locator('[data-slot="tables-family"]')).toHaveCount(1)
  await expect(page.locator('[data-slot="table"]')).toHaveCount(4)
  await page.setViewportSize({ width: 600, height: 900 })
  await page.goto('/preview.html?tables')
  await expect(page.locator('[data-slot="tables-family"]')).toHaveCount(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(600)
})
