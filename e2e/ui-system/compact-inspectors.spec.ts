import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) {
  test(`compact inspectors keep their faces and readings centred in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.setViewportSize({ width: 412, height: 1000 })
    await page.goto('/preview.html?compact-panels')
    await page.evaluate(() => document.fonts.ready)
    const agents = page.locator('[data-frame-id="panel-agents"]')
    await expect(agents.locator('[data-slot="inspector-row"]')).toHaveCount(2)
    const panels = ['panel-activity', 'panel-agents', 'panel-trajectory', 'panel-changes', 'panel-background-tasks', 'panel-seat-attachments']
    for (const id of panels) {
      const frame = page.locator(`[data-frame-id="${id}"]`)
      const readings = await frame.locator('[data-slot="inspector-row"]').evaluateAll(rows => rows.map(row => {
        const box = row.getBoundingClientRect()
        const style = getComputedStyle(row)
        const mark = row.querySelector('[data-slot="inspector-row-mark"]')
        const title = row.querySelector('[data-role="row"]')
        const trailing = row.lastElementChild
        const middle = (node: Element) => { const rect = node.getBoundingClientRect(); return rect.y + rect.height / 2 }
        return {
          align: style.alignItems, inset: parseFloat(style.paddingLeft), height: box.height,
          minimum: title?.parentElement?.querySelector('[data-role=meta]') ? 40 : 32,
          markSize: mark?.getBoundingClientRect().width,
          markRadius: mark ? getComputedStyle(mark).borderRadius : undefined,
          nameSize: title ? getComputedStyle(title).fontSize : null,
          nameWeight: title ? getComputedStyle(title).fontWeight : null,
          markOffset: mark ? Math.abs(middle(mark) - middle(row)) : 0,
          trailingOffset: trailing && trailing !== title?.parentElement ? Math.abs(middle(trailing) - middle(row)) : 0,
        }
      }))
      expect(readings.length, id).toBeGreaterThan(0)
      for (const row of readings) {
        expect(row.align, id).toBe('center')
        expect(row.inset, id).toBe(12)
        expect(row.height, id).toBeGreaterThanOrEqual(row.minimum)
        if (row.markSize !== undefined) {
          expect(row.markSize, id).toBe(24)
          expect(row.markRadius, id).toBe('6px')
        }
        expect(row.nameSize, id).toBe('13px')
        expect(row.nameWeight, id).toBe('500')
        expect(row.markOffset, id).toBeLessThanOrEqual(1)
        expect(row.trailingOffset, id).toBeLessThanOrEqual(1)
      }
    }
    const bare = page.locator('[data-frame-id=panel-seat-attachments] [data-slot=inspector-row]').first()
    expect(await bare.evaluate(row => row.getBoundingClientRect().height)).toBe(32)
    const checks = page.locator('[data-frame-id="project-checks"] [data-slot="list-row"]')
    await expect(checks).toHaveCount(4)
    expect(await checks.locator('[data-slot="list-row-trail"]').allTextContents()).toEqual(['Approved', 'Changed', 'Not approved', 'Not offered'])
    const triggers = page.locator('[data-frame-id="project-triggers"]')
    await expect(triggers.locator('[role="switch"]')).toHaveCount(3)
    await expect(triggers.locator('[data-slot="chip"]')).toHaveCount(0)
    await expect(triggers.getByRole('button', { name: 'History', exact: true })).toHaveCount(3)
    const emptyCells = page.locator('[data-frame-id="plugin-panel-table"] tbody td').filter({ hasText: '—' })
    await expect(emptyCells).toHaveCount(2)
  })
}
