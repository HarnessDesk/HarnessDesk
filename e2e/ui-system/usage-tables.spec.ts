import { expect, test, type Locator, type Page } from '@playwright/test'

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

const stageWindows = async (page: Page) => {
  await page.evaluate(() => {
    const { store } = (window as unknown as { __hdPreview: {
      store: import('../../packages/ui/src/state/store').AppStore & { patch(value: object): void }
    } }).__hdPreview
    const snapshot = store.getSnapshot()
    const windows = [
      { id: 'session', label: 'Session', usedPercent: 50, windowMinutes: 300, resetsAt: Date.now() + 23 * 3600000 + 59 * 60000 },
      { id: 'weekly', label: 'Weekly', usedPercent: 100, windowMinutes: 10080, resetsAt: Date.now() + 6 * 86400000 + 23 * 3600000 },
    ]
    store.patch({
      runtimes: snapshot.runtimes.map(runtime => ({ ...runtime, capabilities: { ...runtime.capabilities, metered: true } })),
      limits: { windows },
      usage: snapshot.usage.map(report => ({ ...report, lanes: report.lanes.length ? windows : [] })),
    })
  })
}

const wholeMeterNames = async (rows: Locator) => {
  const readings = await rows.evaluateAll(nodes => nodes.map(node => {
    const name = node.firstElementChild as HTMLElement
    const reset = node.lastElementChild as HTMLElement
    return { name: name.textContent, width: node.getBoundingClientRect().width,
      nameWidth: name.clientWidth, nameScroll: name.scrollWidth, title: name.title,
      resetWidth: reset.clientWidth, resetScroll: reset.scrollWidth }
  }))
  for (const reading of readings) {
    expect(reading.nameScroll, JSON.stringify(reading)).toBeLessThanOrEqual(reading.nameWidth)
    expect(reading.title).toBe(reading.name)
    expect(reading.resetScroll, JSON.stringify(reading)).toBeLessThanOrEqual(reading.resetWidth)
  }
  await alignedMeters(rows)
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

for (const theme of ['light', 'dark'] as const) {
  test(`account usage keeps whole names at its real menu width in ${theme}`, async ({ page }) => {
    await page.goto('/preview.html')
    await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
    await stageWindows(page)
    await page.locator('[data-frame-id="sidebar-column"] button[class*="accountRow"]').click()
    await page.getByText('Usage remaining', { exact: true }).click()
    const rows = page.locator('[data-usage-details] [data-slot="usage-meter-row"]')
    await expect(rows).toHaveCount(2)
    expect(await rows.first().evaluate(node => node.getBoundingClientRect().width)).toBe(272)
    await wholeMeterNames(rows)
  })

  test(`context usage keeps whole names and the caller inset in ${theme}`, async ({ page }) => {
    await page.goto('/preview.html')
    await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
    await stageWindows(page)
    await page.locator('[data-frame-id="conversation-composer"]').getByRole('button', { name: /^Context window/ }).click()
    const panel = page.getByRole('menu').filter({ hasText: 'Last turn' })
    const rows = panel.locator('[data-slot="usage-meter-row"]')
    await expect(rows).toHaveCount(2)
    const inset = await rows.first().evaluate(node => {
      const panel = node.closest('[class*="panel"]')!.getBoundingClientRect()
      const row = node.getBoundingClientRect()
      return { width: panel.width, left: row.left - panel.left, right: panel.right - row.right }
    })
    expect(inset).toEqual({ width: 272, left: 8, right: 8 })
    await wholeMeterNames(rows)
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`partial cost qualifiers stay inside narrow cells in ${theme}`, async ({ page }) => {
    await page.route('**/src/preview/frames-goals.tsx*', async route => {
      const response = await route.fetch()
      // Exercise the longest real qualifier, with both cost bases and an
      // unknown portion, while retaining the preview's known figures.
      await route.fulfill({ response, body: (await response.text()).replaceAll('coverage: "partial"', 'coverage: "partial", basis: "mixed"') })
    })
    await page.goto('/preview.html')
    await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
    const frame = page.locator('[data-frame-id="insight-partial"]')
    await frame.evaluate(node => { (node as HTMLElement).style.width = '632px' })
    await expect(frame.getByText('Amounts are incomplete for this range', { exact: true })).toBeVisible()
    await expect(frame.getByText('Vendor- or list-price cost; another portion is unknown', { exact: true }).first()).toBeVisible()
    await expect(frame.getByText('Estimated known subtotal', { exact: true }).first()).toBeVisible()
    const cells = await frame.locator('th, td').evaluateAll(nodes => nodes.map(node => ({
      text: node.textContent, width: node.clientWidth, scroll: node.scrollWidth,
    })))
    for (const cell of cells) expect(cell.scroll, JSON.stringify(cell)).toBeLessThanOrEqual(cell.width)
    const container = frame.locator('[data-slot="table-container"]')
    expect(await container.evaluate(node => node.scrollWidth)).toBe(await container.evaluate(node => node.clientWidth))
  })
}
