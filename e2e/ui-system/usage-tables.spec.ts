import { expect, test, type Locator } from '@playwright/test'

const alignedMeters = async (rows: Locator) => {
  const boxes = await rows.locator('[data-slot="progress"]').evaluateAll(nodes => nodes.map(node => {
    const box = node.getBoundingClientRect()
    return { left: box.left, width: box.width }
  }))
  expect(boxes.length).toBeGreaterThan(1)
  for (const box of boxes.slice(1)) {
    expect(box.left).toBeCloseTo(boxes[0]!.left, 0)
    expect(box.width).toBeCloseTo(boxes[0]!.width, 0)
  }
  const heights = await rows.locator('[data-slot="progress-track"]').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height))
  expect(heights.every(height => height === 4)).toBe(true)
  const fills = await rows.locator('[data-slot="progress"]').evaluateAll(nodes => nodes.map(node => {
    const track = node.querySelector('[data-slot="progress-track"]')!.getBoundingClientRect()
    const fill = node.querySelector('[data-slot="progress-fill"]')!.getBoundingClientRect()
    return { width: fill.width, expected: track.width * Number(node.getAttribute('aria-valuenow')) / 100, height: fill.height }
  }))
  for (const fill of fills) { expect(fill.width).toBeCloseTo(fill.expected, 0); expect(fill.height).toBe(4) }
}

for (const theme of ['light', 'dark'] as const) {
  test(`meter tracks align in a card and a quota popover in ${theme}`, async ({ page }) => {
    await page.route('**/src/preview/sidebar-fixture.ts*', async route => {
      const response = await route.fetch()
      await route.fulfill({ response, body: `${await response.text()}
{
        for (const report of previewUsage) if (report.lanes.length) {
          report.lanes = [
            { ...report.lanes[0], id: 'session', label: '5 h', usedPercent: 90, resetsAt: Date.now() + 8040000 },
            { ...report.lanes[0], id: 'weekly', label: 'Weekly', usedPercent: 22, resetsAt: Date.now() + 259200000 },
            { ...report.lanes[0], id: 'monthly', label: 'Monthly', usedPercent: 8, resetsAt: null },
          ];
        }
      }` })
    })
    await page.goto('/preview.html')
    await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
    await page.evaluate(async () => { await document.fonts.ready })
    const dashboard = page.getByRole('dialog', { name: 'Dashboard', exact: true })
    const card = dashboard.locator('[data-slot="card"]').filter({ has: page.locator('[data-slot="usage-meter-row"]') }).first()
    await expect(card.locator('[data-slot="usage-meter-row"]')).toHaveCount(3)
    await alignedMeters(card.locator('[data-slot="usage-meter-row"]'))
    await page.getByRole('group', { name: 'Plan usage' }).locator('button').first().click()
    await alignedMeters(page.getByRole('menu').locator('[data-slot="usage-meter-row"]'))
  })
}
