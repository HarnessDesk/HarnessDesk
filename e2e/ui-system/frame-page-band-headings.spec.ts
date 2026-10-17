import { mkdir } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { openFrame } from './frame-contract-helpers'
import { applyFrameActions } from './frame-actions'
import { WALL_TIME } from './frame-wall-destinations'

const families = [
  { id: 'teams', query: 'frame-wall=teams' },
  { id: 'agents', query: 'frame-wall=agents' },
  // The Library's only section band is on its Changes page; the plain page is checked to have none.
  { id: 'library', query: 'frame-wall=library', bands: 'frame-wall=library&frame-kind=changes' },
  { id: 'plugins', query: 'frame-wall=plugins&frame-plugin-page=capabilities' },
  { id: 'dashboard', query: 'frame-wall=dashboard&frame-view=overview' },
  { id: 'flow', query: 'flow-graph', frame: '#flow-graph-straight' },
  { id: 'run', query: 'frame-wall=team-receipt', tab: 'receipt' },
] as const

for (const theme of ['light', 'dark'] as const) for (const family of families) {
  test(`page band frame ${family.id} ${theme}`, async ({ page }) => {
    await page.clock.setFixedTime(WALL_TIME)
    await openFrame(page, 'bands' in family ? family.bands : family.query, theme)
    if ('tab' in family) await applyFrameActions(page, { tab: family.tab })
    await expect(page.locator('h1, h2').first()).toBeVisible()
    if ('frame' in family) await expect(page.locator(`${family.frame} .react-flow__node`).first()).toBeVisible()
    await mkdir('output/frames/s2', { recursive: true })
    await ('frame' in family ? page.locator(family.frame) : page).screenshot({ path: `output/frames/s2/${process.env.S2_FRAME_PHASE ?? 'after'}-${family.id}-${theme}.png` })
  })
}

// The section role is the existing semibold token; foundations own its weight.
for (const theme of ['light', 'dark'] as const) for (const family of families) {
  test(`page bands use the section role: ${family.id} ${theme}`, async ({ page }) => {
    await page.clock.setFixedTime(WALL_TIME)
    await openFrame(page, 'bands' in family ? family.bands : family.query, theme)
    if ('tab' in family) await applyFrameActions(page, { tab: family.tab })
    const scope = 'frame' in family ? page.locator(family.frame) : page.locator('body')
    const bands = scope.locator('h2[data-role="section"], h2 [data-role="section"], h3 [data-role="section"]')
    await expect(bands.first()).toBeAttached()
    const measured = await bands.evaluateAll(nodes => nodes.map(node => {
      const css = getComputedStyle(node)
      return { text: node.textContent, size: css.fontSize, weight: css.fontWeight,
        headingSize: getComputedStyle(node.closest('h2, h3')!).fontSize,
        semibold: css.getPropertyValue('--hd-weight-semibold').trim() }
    }))
    expect(measured.length).toBeGreaterThan(0)
    for (const band of measured) {
      expect(band.size, band.text ?? '').toBe('16px')
      expect(band.headingSize, `${band.text} wrapper`).toBe('16px')
      expect(band.semibold).toMatch(/^\d+$/)
      expect(band.weight, band.text ?? '').toBe(band.semibold)
    }
    if (family.id === 'teams') {
      const counts = page.locator('[data-slot="teams-board-column"] h2 [data-role="meta"]')
      expect(await counts.count()).toBeGreaterThan(0)
      await expect(counts.first()).toHaveCSS('font-size', '12px')
    }
  })
}

// The Library's plain page keeps no band: its one band is on the Changes page,
// so a section role here is a leftover rather than a page band.
for (const theme of ['light', 'dark'] as const) {
  test(`the plain Library page has no section band ${theme}`, async ({ page }) => {
    await page.clock.setFixedTime(WALL_TIME)
    await openFrame(page, 'frame-wall=library', theme)
    await expect(page.locator('h1').first()).toBeVisible()
    await expect(page.locator('body').locator('h2[data-role="section"], h2 [data-role="section"], h3 [data-role="section"]')).toHaveCount(0)
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`Settings groups and right-rail cards stay small ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=settings-general', theme)
    const heads = page.locator('[data-slot="section-name"]')
    expect(await heads.count()).toBeGreaterThan(0)
    for (const head of await heads.all()) {
      await expect(head).toHaveAttribute('data-level', 'label')
      await expect(head).toHaveCSS('font-size', '13px')
    }
    await openFrame(page, 'frame-wall=team', theme)
    const railLabels = page.locator('[data-slot="tool-section"] > [data-slot="group-label"]')
    expect(await railLabels.count()).toBeGreaterThan(0)
    for (const label of await railLabels.all()) await expect(label).toHaveCSS('font-size', '13px')
  })
}

// Canonical Section and SectionHead both occur in Settings; neither is a page band here.
for (const theme of ['light', 'dark'] as const) {
  test(`Settings section headings stay labels across pages ${theme}`, async ({ page }) => {
    let measured = 0
    for (const section of ['general', 'appearance', 'notifications', 'shortcuts', 'workspaces', 'archive', 'history', 'storage', 'runtimes', 'models', 'permissions', 'browser', 'profile']) {
      await openFrame(page, `frame-wall=settings&frame-section=${section}`, theme)
      const heads = page.locator('[data-slot="section-name"], [data-section-name]')
      for (const head of await heads.all()) {
        await expect(head, section).toHaveCSS('font-size', '13px')
        measured++
      }
      if (section === 'archive') expect(await heads.count()).toBeGreaterThan(0)
    }
    expect(measured).toBeGreaterThan(20)
  })
}

// The Flow page's rail labels stay small; dashboard compositions name page bands.
for (const theme of ['light', 'dark'] as const) {
  test(`Flow Steps keeps its Rules rail label ${theme}`, async ({ page }) => {
    await openFrame(page, 'flows-page=draft', theme)
    await page.getByRole('group', { name: 'Flow tools', exact: true }).getByRole('tab', { name: 'Steps', exact: true }).click()
    // Development's canvas page keeps Rules in its rail. The older editor's
    // SectionHead belongs to the dialog form, where either level is a legend.
    const rules = page.getByRole('complementary', { name: 'Flow details', exact: true }).getByRole('region', { name: 'Rules', exact: true })
    const label = rules.locator('[data-slot="group-label"]')
    await expect(label).toHaveCSS('font-size', '13px')
    await expect(rules.getByRole('heading')).toHaveCount(0)
    await mkdir('output/frames/s2', { recursive: true })
    await page.screenshot({ path: `output/frames/s2/after-flow-steps-${theme}.png` })
  })

  test(`dashboard-bands composition uses page headings ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/design.html?view=dashboard-bands')
    const board = page.locator('[data-catalog-variants]').filter({ has: page.getByRole('heading', { name: 'Recorded readings', exact: true }) }).last()
    await expect(board.getByRole('heading', { name: 'Recorded readings', exact: true })).toBeVisible()
    await page.evaluate(() => document.fonts.ready)
    for (const name of ['Recorded readings', 'No records yet']) {
      const head = board.getByRole('heading', { name, exact: true })
      await expect(head).toHaveCSS('font-size', '16px')
      await expect(head).toHaveCSS('font-weight', await head.evaluate(node => getComputedStyle(node).getPropertyValue('--hd-weight-semibold').trim()))
    }
    await mkdir('output/frames/s2', { recursive: true })
    await page.screenshot({ path: `output/frames/s2/after-dashboard-bands-${theme}.png` })
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`receipt bands keep one column-sized line ${theme}`, async ({ page }) => {
    await openFrame(page, '', theme)
    await mkdir('output/frames/s2', { recursive: true })
    for (const [id, name] of [['goal-receipt', 'Record'], ['goal-accounting', 'Cost']] as const) {
      const frame = page.locator(`[data-frame-id="${id}"]`)
      const head = frame.getByRole('heading', { name, exact: true })
      await expect(head).toHaveAttribute('data-level', 'heading')
      await expect(head).toHaveCSS('font-size', '16px')
      const line = await head.evaluate(node => {
        const range = document.createRange()
        range.selectNodeContents(node)
        const tops = new Set([...range.getClientRects()].filter(rect => rect.width > 1 && rect.height > 4).map(rect => Math.round(rect.top / 4)))
        return { lines: tops.size, clipped: node.scrollWidth > node.clientWidth }
      })
      expect(line).toEqual({ lines: 1, clipped: false })
      await head.scrollIntoViewIfNeeded()
      await frame.screenshot({ path: `output/frames/s2/after-${id}-${theme}.png` })
    }
  })
}
