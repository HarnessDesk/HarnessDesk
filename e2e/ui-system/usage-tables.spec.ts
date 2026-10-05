import { expect, test, type Locator, type Page } from '@playwright/test'
import path from 'node:path'
import { COLLECT, textReasons, USER } from '../../script/shots/audit.mjs'

const capture = async (page: Page, frame: Locator, name: string) => {
  if (!process.env.USAGE_TABLES_FRAMES_DIR) return
  // Audit the photographed surface, including its tooltip and field values.
  const seen = await frame.evaluate((root, collect) => {
    const read = new Function('document', `return ${collect}`)
    return read({ body: root, title: document.title, querySelectorAll: root.querySelectorAll.bind(root) })
  }, COLLECT)
  expect(textReasons(seen, { user: USER })).toEqual([])
  await frame.screenshot({ path: path.join(process.env.USAGE_TABLES_FRAMES_DIR, name) })
}

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
      { id: '5-hour', label: '5-hour', usedPercent: 0, windowMinutes: 300, resetsAt: Date.now() + 23 * 3600000 + 59 * 60000 },
      { id: 'weekly-opus', label: 'Weekly · Opus', usedPercent: 100, windowMinutes: 10080, resetsAt: Date.now() + 6 * 86400000 + 23 * 3600000 },
    ]
    store.patch({
      runtimes: snapshot.runtimes.map(runtime => ({ ...runtime, capabilities: { ...runtime.capabilities, metered: true } })),
      limits: { windows },
      usage: snapshot.usage.map(report => ({ ...report, lanes: report.lanes.length ? windows : [] })),
    })
  })
}

const wholeMeterNames = async (rows: Locator) => {
  for (const row of await rows.all()) await row.locator(':scope > span').first().hover()
  const readings = await rows.evaluateAll(nodes => nodes.map(node => {
    const name = node.firstElementChild as HTMLElement
    const reset = node.lastElementChild as HTMLElement
    const hasBar = Boolean(node.querySelector('[data-slot="progress"]'))
    const reading = node.children[hasBar ? 2 : 1] as HTMLElement
    const range = document.createRange()
    range.selectNodeContents(reading)
    const lines = new Set([...range.getClientRects()].map(box => Math.round(box.top)))
    return { name: name.textContent, width: node.getBoundingClientRect().width,
      nameWidth: name.clientWidth, nameScroll: name.scrollWidth, title: name.getAttribute('title'), hasBar,
      resetTitle: reset.getAttribute('title'), resetWidth: reset.clientWidth, resetScroll: reset.scrollWidth, readingLines: lines.size }
  }))
  for (const reading of readings) {
    expect(reading.nameScroll, JSON.stringify(reading)).toBeLessThanOrEqual(reading.nameWidth)
    expect(reading.title).toBe(reading.nameScroll > reading.nameWidth ? reading.name : null)
    expect(reading.hasBar).toBe(false)
    expect(reading.resetTitle).toMatch(/^resets /)
    expect(reading.readingLines, JSON.stringify(reading)).toBe(1)
    expect(reading.resetScroll, JSON.stringify(reading)).toBeLessThanOrEqual(reading.resetWidth)
  }
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
      await route.fulfill({ response, body: (await response.text()).replaceAll('coverage: "partial"', 'coverage: "partial", quality: "estimate", basis: "mixed"') })
    })
    await page.goto('/preview.html')
    await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
    const frame = page.locator('[data-frame-id="insight-partial"]')
    await frame.evaluate(node => { (node as HTMLElement).style.width = '632px' })
    await expect(frame.getByText('Amounts are incomplete for this range', { exact: true })).toBeVisible()
    await expect(frame.getByText('Estimate', { exact: true }).first()).toBeVisible()
    await expect(frame.getByText('Known subtotal', { exact: true }).first()).toBeVisible()
    await expect(frame.getByText('Vendor- or list-price cost; another portion is unknown', { exact: true })).toHaveCount(0)
    await expect(frame.locator('[title*="Vendor- or list-price cost; another portion is unknown"]').first()).toHaveAttribute('title', expect.stringContaining('Vendor- or list-price cost; another portion is unknown'))
    const rowHeights = await frame.locator('tbody tr').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height))
    expect(rowHeights.length).toBeGreaterThan(0)
    expect(rowHeights.every(height => height <= 96), JSON.stringify(rowHeights)).toBe(true)
    const cells = await frame.locator('th, td').evaluateAll(nodes => nodes.map(node => ({
      text: node.textContent, width: node.clientWidth, scroll: node.scrollWidth,
    })))
    for (const cell of cells) expect(cell.scroll, JSON.stringify(cell)).toBeLessThanOrEqual(cell.width)
    const container = frame.locator('[data-slot="table-container"]')
    expect(await container.evaluate(node => node.scrollWidth)).toBe(await container.evaluate(node => node.clientWidth))
  })
}

test('Dashboard Project preview counts its retained Run through the batch history loader', async ({ page }) => {
  await page.goto('/preview.html?view=projects')
  const dashboard = page.getByRole('dialog', { name: 'Dashboard', exact: true })
  const row = dashboard.getByRole('row', { name: /Storefront/ })
  await expect(row.locator('td').nth(1)).toHaveText('1')
  await expect(dashboard.getByText('Run counts are unavailable for some Teams.')).toHaveCount(0)
})

for (const theme of ['light', 'dark'] as const) {
  test(`narrow Plans disclosure keeps its position and name in ${theme}`, async ({ page }) => {
    await page.goto('/preview.html?view=plans')
    await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
    const table = page.getByRole('dialog', { name: 'Dashboard', exact: true }).locator('[data-slot="plans-table"]')
    await table.locator('[data-slot="table-container"]').evaluate(node => { (node as HTMLElement).style.width = '480px' })
    const button = table.locator('button[aria-controls^="plans-row-body"]').first()
    const name = await button.locator('xpath=ancestor::tr').locator('td').first().locator('[data-role="subject"]').textContent()
    await expect(button).toHaveAttribute('aria-expanded', 'false')
    const resets = table.locator('[data-slot="table-head"][data-collapse-below="sm"]')
    expect(await resets.evaluate(node => node.getBoundingClientRect().width)).toBe(0)
    const closed = await button.boundingBox()
    await button.click()
    await expect(button).toHaveAttribute('aria-expanded', 'true')
    const opened = await button.boundingBox()
    expect(await resets.evaluate(node => node.getBoundingClientRect().width)).toBe(0)
    expect.soft(opened!.x).toBeCloseTo(closed!.x, 0)
    await expect.soft(button).toHaveAttribute('aria-label', `Details for ${name}`)
    await button.click()
    await expect(button).toHaveAttribute('aria-expanded', 'false')
    await expect.soft(button).toHaveAttribute('aria-label', `Details for ${name}`)
    expect((await button.boundingBox())!.x).toBeCloseTo(closed!.x, 0)
  })
}


for (const theme of ['light', 'dark'] as const) {
  for (const width of [360, 480, 720]) {
    test(`Receipt Cost keeps figure space with real host notes at ${width}px in ${theme}`, async ({ page }) => {
      await page.goto('/preview.html')
      await page.evaluate(async () => { await document.fonts.ready })
      await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
      const frame = page.locator('[data-frame-id="goal-accounting"]')
      await frame.evaluate((node, width) => { (node as HTMLElement).style.width = `${width}px` }, width)
      await expect(frame.getByText('Recorded corpus rows without a unique historical Seat remain unattributed.', { exact: true })).toBeVisible()
      await expect(frame.getByText('Recorded brief cohort', { exact: true })).toHaveCount(1)
      await expect(frame.getByText(/4 files/)).toBeVisible()
      const footerGap = await frame.locator('[data-footer]').evaluate(node => {
        const value = node.querySelector('dd')!.getBoundingClientRect()
        const note = node.querySelector('[data-slot="key-value-note"]')!.getBoundingClientRect()
        return note.top - value.bottom
      })
      expect(footerGap).toBe(2)
      const pairs = await frame.locator('[data-slot="key-value-row"]').evaluateAll(nodes => nodes.map(node => {
        const key = node.querySelector('dt')!; const value = node.querySelector('dd')!
        const note = node.querySelector('[data-slot="key-value-note"]')
        return { key: key.textContent, width: value.getBoundingClientRect().width, scroll: value.scrollWidth, client: value.clientWidth,
          noteLeft: note?.getBoundingClientRect().left, keyLeft: key.getBoundingClientRect().left, noteWidth: note?.getBoundingClientRect().width, pairWidth: key.getBoundingClientRect().width + value.getBoundingClientRect().width }
      }))
      for (const pair of pairs) {
        expect(pair.width, JSON.stringify(pair)).toBeGreaterThanOrEqual(pair.pairWidth / 2)
        expect(pair.scroll, JSON.stringify(pair)).toBeLessThanOrEqual(pair.client)
        if (pair.noteWidth) { expect(pair.noteWidth).toBeGreaterThan(pair.pairWidth); expect(pair.noteLeft).toBeCloseTo(pair.keyLeft, 0) }
      }
      expect(await frame.evaluate(node => node.scrollWidth)).toBe(await frame.evaluate(node => node.clientWidth))
    })
  }
}

test('partial Project preview has available Team counts through the default loader', async ({ page }) => {
  await page.goto('/preview.html')
  const frame = page.locator('[data-frame-id="insight-partial"]')
  await expect(frame.getByText('Run counts are unavailable for some Teams.')).toHaveCount(0)
  await expect(frame.locator('tbody tr')).toHaveCount(1)
  for (const cell of await frame.locator('tbody td:nth-child(2)').all()) await expect(cell).toHaveText(/^[0-9]+$/)
})

for (const theme of ['light', 'dark'] as const) {
  test(`blocked plan popover names the gate clock in ${theme}`, async ({ page }) => {
    await page.goto('/preview.html')
    await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
    const gate = await page.evaluate(() => {
      const { store } = (window as unknown as { __hdPreview: { store: import('../../packages/ui/src/state/store').AppStore & { patch(value: object): void } } }).__hdPreview
      const until = Date.now() + 3 * 86400000
      store.patch({ usage: store.getSnapshot().usage.map(report => ({ ...report, lanes: report.lanes.length ? [
        { id: 'session', label: 'Session', usedPercent: 50, windowMinutes: 300, resetsAt: Date.now() + 3600000 },
        { id: 'weekly', label: 'Weekly', usedPercent: 100, windowMinutes: 10080, resetsAt: until },
      ] : [] })) })
      return until
    })
    await page.getByRole('group', { name: 'Plan usage' }).locator('button').first().click()
    const menu = page.getByRole('menu').filter({ has: page.getByText('blocked 3d', { exact: true }) })
    const row = menu.locator('[data-slot="usage-meter-row"]').filter({ hasText: 'Session' })
    await expect(row).toContainText('blocked 3d')
    const clock = await page.evaluate(async gate => {
      const { formatReset } = await import('/src/lib/limits.ts' as string)
      return formatReset(gate)
    }, gate)
    await expect(row.locator(':scope > :last-child')).toHaveAttribute('title', `blocked until ${clock}`)
    await page.evaluate(async () => { await document.fonts.ready })
    await capture(page, menu, `blocked-plan-${theme}.png`)
  })

  test(`By Goal retries refused history and wraps its recovery action in ${theme}`, async ({ page }) => {
    await page.route('**/src/preview/usage-fixture.ts*', async route => {
      const response = await route.fetch()
      const body = (await response.text())
        .replace(/=> \(\{\s*loaded:/, '=> (await new Promise(resolve => { if (window.__historyHold) window.__historyFinish = resolve; else resolve(); }), { loaded:')
        .replace('loaded: new Set(teams)', 'loaded: new Set(window.__historyRecovered ? teams : [])')
        .replace('unavailable: new Set()', 'unavailable: new Set(window.__historyRecovered ? [] : teams)')
      await route.fulfill({ response, body })
    })
    await page.goto('/preview.html?view=projects')
    await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
    const dashboard = page.getByRole('dialog', { name: 'Dashboard', exact: true })
    const project = dashboard.locator('[aria-label="Project usage"]')
    const note = project.locator('[data-slot="note"]').filter({ hasText: 'Run counts are unavailable for some Teams.' })
    await expect(note.getByRole('button', { name: 'Try again', exact: true })).toBeVisible()
    await expect(project.locator('tbody td').nth(1)).toHaveText('—')
    await note.evaluate(node => { (node as HTMLElement).style.width = '260px' })
    const geometry = await note.evaluate(node => {
      const text = node.querySelector('[data-slot="note-text"]')!.getBoundingClientRect()
      const action = node.querySelector('button')!.getBoundingClientRect()
      return { textBottom: text.bottom, actionTop: action.top, actionLeft: action.left, noteLeft: node.getBoundingClientRect().left, client: node.clientWidth, scroll: node.scrollWidth }
    })
    expect(geometry.actionTop).toBeGreaterThan(geometry.textBottom)
    expect(geometry.actionLeft).toBe(geometry.noteLeft)
    expect(geometry.scroll).toBe(geometry.client)
    await page.evaluate(async () => { await document.fonts.ready })
    await capture(page, dashboard, `by-goal-refused-${theme}.png`)
    await page.evaluate(() => { (window as unknown as { __historyHold: boolean }).__historyHold = true })
    const retry = note.getByRole('button', { name: 'Try again', exact: true })
    await retry.focus()
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => Boolean((window as unknown as { __historyFinish?: () => void }).__historyFinish))
    const pending = await project.evaluate(node => {
      const button = node.querySelector('[data-slot="note-action"] button')
      return { label: button?.textContent, disabled: button?.getAttribute('aria-disabled'), focused: button === document.activeElement,
        warning: node.textContent?.includes('Run counts are unavailable for some Teams.') }
    })
    await capture(page, dashboard, `by-goal-pending-${theme}.png`)
    await page.evaluate(() => { (window as unknown as { __historyFinish: () => void }).__historyFinish() })
    await expect(note.getByRole('button', { name: 'Try again', exact: true })).toBeEnabled()
    await capture(page, dashboard, `by-goal-repeated-${theme}.png`)
    const focusedAfterRefusal = await retry.evaluate(button => button === document.activeElement)
    await page.evaluate(() => {
      const rig = window as unknown as { __historyRecovered: boolean; __historyHold: boolean }
      rig.__historyRecovered = true; rig.__historyHold = false
    })
    await retry.click()
    await expect(note).toHaveCount(0)
    expect(pending).toEqual({ label: 'Trying again…', disabled: 'true', focused: true, warning: true })
    expect(focusedAfterRefusal).toBe(true)
    await expect(project.locator('tbody td').nth(1)).toHaveText('1')
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`Receipt Cost shares an all-missing cohort in ${theme}`, async ({ page }) => {
    await page.route('**/src/preview/harness.tsx*', async route => {
      const response = await route.fetch()
      await route.fulfill({ response, body: (await response.text()).replaceAll("note: \"Recorded brief cohort\"", "note: \"Brief cohort unavailable\"") })
    })
    await page.goto('/preview.html')
    await page.evaluate(async () => { await document.fonts.ready })
    await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
    const frame = page.locator('[data-frame-id="goal-accounting"]')
    await frame.evaluate(node => { (node as HTMLElement).style.width = '480px' })
    await expect(frame.getByRole('heading', { name: 'Cost', exact: true })).toBeVisible()
    await capture(page, frame, `receipt-missing-cohort-${theme}.png`)
    await expect(frame.getByText('Brief cohort unavailable', { exact: true })).toHaveCount(1)
    await expect(frame.locator('dl')).not.toContainText('Brief cohort unavailable')
  })

  test(`Cost keeps its retry separate from the sentence in ${theme}`, async ({ page }) => {
    await page.route('**/src/preview/frames-goals.tsx*', async route => {
      const response = await route.fetch()
      await route.fulfill({ response, body: (await response.text()).replace(/report: INSIGHT_REPORT,\s*loading: false,\s*problem: null/, 'report: null, loading: false, problem: "The source is temporarily unavailable."') })
    })
    await page.goto('/preview.html')
    await page.evaluate(async () => { await document.fonts.ready })
    await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
    const frame = page.locator('[data-frame-id="insight-loaded"]')
    await frame.evaluate(node => { (node as HTMLElement).style.width = '360px' })
    await expect(frame.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
    await capture(page, frame, `cost-retry-${theme}.png`)
    await expect(frame.locator('[data-slot="note-text"]')).toHaveText('Recorded usage could not be read. The source is temporarily unavailable.')
    const geometry = await frame.locator('[data-slot="note"]').evaluate(node => {
      const text = node.querySelector('[data-slot="note-text"]')!.getBoundingClientRect()
      const action = node.querySelector('button')!.getBoundingClientRect()
      return { textBottom: text.bottom, actionTop: action.top, actionLeft: action.left, noteLeft: node.getBoundingClientRect().left,
        fits: node.scrollWidth === node.clientWidth }
    })
    expect(geometry.actionTop).toBeGreaterThan(geometry.textBottom)
    expect(geometry.actionLeft).toBe(geometry.noteLeft)
    expect(geometry.fits).toBe(true)
  })
}
