import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'

const open = async (page: Page, surface: string, theme: 'light' | 'dark') => {
  await page.route('**/preview.html?runtime-tiles*', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, body: (await response.text()).replace('/src/preview/main.tsx', '/src/preview/runtime-tiles.tsx') })
  })
  await page.setViewportSize({ width: 1100, height: 900 })
  await page.emulateMedia({ colorScheme: theme })
  if (surface.startsWith('usage-')) await page.clock.install({ time: Date.UTC(2026, 9, 16, 12) })
  await page.goto(`/preview.html?runtime-tiles&surface=${surface}`)
  if (surface.startsWith('usage-')) await expect(page.locator(surface === 'usage-plans' ? '[data-dashboard-table="plans"]' : '[data-dashboard-table="ranked"]')).toBeVisible()
  else await expect(page.getByText(surface === 'library' ? 'Shared review' : 'Alpha', { exact: true }).filter({ visible: true }).first()).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
}

for (const theme of ['light', 'dark'] as const) {
  for (const surface of ['add', 'runtimes', 'library', 'usage-plans', 'usage-spend', 'usage-overview']) test(`${surface} frame in ${theme}`, async ({ page }) => {
    await open(page, surface, theme)
    if (surface === 'usage-overview') await page.locator('[data-dashboard-table="ranked"]').scrollIntoViewIfNeeded()
    if (surface.startsWith('usage-')) {
      for (const [brand, tint] of [['codex', 'violet'], ['claudecode', 'amber'], ['cursor', 'green']] as const) {
        const faces = page.locator(`[data-dashboard-table] [data-slot="icon-tile"]:has(svg.brand-${brand})`)
        await expect(faces.first()).toBeVisible()
        for (const face of await faces.all()) await expect(face).toHaveAttribute('data-tint', tint)
      }
    }
    if (surface === 'usage-spend' || surface === 'usage-overview') {
      const segments = page.locator('[aria-label="Where it went, by share"] > span')
      const rows = page.locator('[data-dashboard-table="ranked"] tbody tr')
      await expect(segments).toHaveCount(3)
      const keys = page.locator('[data-slot="chart-key"]')
      const stacks = await page.locator('[data-slot="day-columns"] span[style*="height"]').evaluateAll(nodes =>
        [...new Set(nodes.map(node => node.parentElement!))]
          .map(column => [...column.children].map(node => getComputedStyle(node).backgroundColor))
          .filter(colours => colours.length === 3))
      expect(stacks.length).toBeGreaterThan(0)
      for (const name of ['Alpha', 'Beta', 'Gamma']) {
        const row = rows.filter({ hasText: name })
        const face = row.locator('[data-slot="icon-tile"]')
        const tint = await face.getAttribute('data-tint')
        const dot = keys.filter({ hasText: name }).locator('[data-slot="series-dot"]')
        await expect(dot).toHaveAttribute('data-tint', tint!)
        const colour = await face.evaluate(node => getComputedStyle(node).backgroundColor)
        await expect(dot).toHaveCSS('background-color', colour)
        const position = await rows.allTextContents().then(labels => labels.findIndex(label => label.includes(name)))
        await expect(segments.nth(position)).toHaveCSS('background-color', colour)
        const seriesIndex = await keys.allTextContents().then(labels => labels.indexOf(name))
        for (const stack of stacks) expect(stack[seriesIndex]).toBe(colour)
      }
    }
    if (process.env.RUNTIME_TILES_FRAMES_DIR) {
      const prefix = process.env.RUNTIME_TILES_FRAME_PREFIX ?? 'after'
      await page.screenshot({ path: path.join(process.env.RUNTIME_TILES_FRAMES_DIR, `${prefix}-${surface}-${theme}.png`) })
      if (surface === 'add' && prefix !== 'before') {
        await page.getByRole('button', { name: 'Browse more…', exact: true }).click()
        await expect(page.getByText('An optional third-party runtime.')).toBeVisible()
        await page.screenshot({ path: path.join(process.env.RUNTIME_TILES_FRAMES_DIR, `${prefix}-registry-${theme}.png`) })
      }
    }
  })

  test(`registry browsing and separate loading tiles in ${theme}`, async ({ page }) => {
    await open(page, 'add', theme)
    await expect(page.getByText('Delta', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Browse more…', exact: true }).click()
    await expect(page.getByText('Delta', { exact: true })).toBeVisible()
    await expect(page.getByText('Third-party entries from the ACP registry. HarnessDesk has not reviewed them.', { exact: true })).toHaveCount(1)
    await open(page, 'library', theme)
    const card = page.getByRole('button', { name: 'Shared review', exact: true })
    await expect(card.getByText('3 runtimes', { exact: true })).toHaveAttribute('title', 'Alpha, Beta, Gamma')
    await expect(card).toHaveAccessibleDescription(/3 runtimes Loaded by Alpha, Beta, Gamma/)
    await expect(card.getByRole('img')).toHaveCount(0)
    // The catalogue names its readers; the detail retains the measured states
    // and runtime marks for comparing those readers.
    await card.click()
    const loaded = page.locator('[data-slot="skill-page"] [data-slot="tool-section"][aria-label="Loaded by"]')
    const rows = loaded.locator('[data-slot="row"]')
    await expect(rows).toHaveCount(3)
    for (const [index, name] of ['Alpha', 'Beta', 'Gamma'].entries()) {
      await expect(rows.nth(index)).toHaveAttribute('title', `${name} — Loads it`)
    }
    const faces = rows.locator('[data-slot="row-face"]')
    await expect(faces).toHaveCount(3)
    // Each mark carries its brand's one-colour twin: the `[data-ink='mono']`
    // child is what paints it in the app's ink rather than the brand's own
    // palette. A mark drawn only in its colours has none and must fail here.
    // Gamma's brand ships ink alone, so it correctly has no twin at all.
    const twins = await faces.evaluateAll(nodes => nodes.map(node => {
      const svg = node.querySelector('svg')!
      return { mono: svg.querySelector('[data-ink="mono"]') !== null, colour: svg.querySelector('[data-ink="colour"]') !== null }
    }))
    expect(twins.some(twin => twin.mono)).toBe(true)
    for (const twin of twins) expect(twin.mono).toBe(twin.colour)
    const boxes = await faces.evaluateAll(nodes => nodes.map(node => { const { top, bottom } = node.getBoundingClientRect(); return { top, bottom } }))
    for (let index = 1; index < boxes.length; index++) expect(boxes[index]!.top - boxes[index - 1]!.bottom).toBeGreaterThan(0)
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`preview runtime accounts expose only supported gateway actions in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/preview.html?runtime-cost')
    if (theme === 'dark') await expect(page.locator('body')).toHaveAttribute('data-hd-dark-theme', '')
    else await expect(page.locator('body')).not.toHaveAttribute('data-hd-dark-theme')
    const row = (name: string) => page.locator('[data-slot="agent-row"]').filter({ has: page.locator('[data-slot="runtime-name"]', { hasText: name }) })
    await row('Codex').click()
    await expect(page.getByText('Not answered yet', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add gateway account…' })).toBeVisible()
    await page.getByRole('button', { name: 'Add gateway account…' }).click()
    await expect(page.getByRole('dialog', { name: 'Add a gateway account' })).toBeVisible()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: /Codex actions/ }).click()
    await expect(page.getByRole('menu')).toBeVisible()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Back to Runtimes' }).click()
    await row('Claude Code').click()
    await expect(page.getByRole('heading', { name: 'Accounts' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add gateway account…' })).toHaveCount(0)
  })
}
