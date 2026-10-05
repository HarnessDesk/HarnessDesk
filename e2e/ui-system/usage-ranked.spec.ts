import { expect, test } from '@playwright/test'

for (const view of ['spend', 'overview'] as const) {
  test(`the model pivot keeps 8px dots in ${view === 'spend' ? 'comfortable' : 'compact'} table leads`, async ({ page }) => {
    await page.goto(`/preview.html?view=${view}`)
    const dashboard = page.getByRole('dialog', { name: 'Dashboard', exact: true })
    await dashboard.getByRole('radiogroup', { name: 'Group spend by' }).getByRole('radio', { name: 'by model', exact: true }).click()
    const dots = dashboard.locator('[data-slot="table-cell-lead"] [data-slot="series-dot"]')
    await expect(dots.first()).toBeVisible()
    const sizes = await dots.evaluateAll(nodes => nodes.map(node => {
      const style = getComputedStyle(node)
      const dot = node.getBoundingClientRect(); const lead = node.closest('[data-slot="table-cell-lead"]')!.getBoundingClientRect()
      return { width: style.width, height: style.height, lead: lead.width, dx: Math.abs((dot.left + dot.right - lead.left - lead.right) / 2), dy: Math.abs((dot.top + dot.bottom - lead.top - lead.bottom) / 2) }
    }))
    for (const size of sizes) {
      expect(size.width).toBe('8px'); expect(size.height).toBe('8px')
      expect(size.lead).toBe(view === 'spend' ? 32 : 24)
      expect(size.dx).toBeLessThan(1); expect(size.dy).toBeLessThan(1)
    }
  })
}
