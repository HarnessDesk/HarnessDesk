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
    const faces = page.locator('[data-slot="avatar-stack"] [data-slot="avatar"]')
    await expect(faces).toHaveCount(3)
    const boxes = await faces.evaluateAll(nodes => nodes.map(node => { const { left, right } = node.getBoundingClientRect(); return { left, right } }))
    for (let index = 1; index < boxes.length; index++) expect(boxes[index]!.left - boxes[index - 1]!.right).toBeGreaterThan(0)
  })
}
