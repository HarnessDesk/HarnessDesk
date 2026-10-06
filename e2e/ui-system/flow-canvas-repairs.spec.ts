import { expect, test, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { COLLECT, textReasons } from '../../script/shots/audit.mjs'

const run = async (page: Page, theme: string) => {
  await page.goto(`/preview.html?flow-overlay&theme=${theme}`)
  const pane = page.locator('#flow-overlay-live')
  await pane.getByRole('button', { name: /^Run/ }).first().click()
  await pane.getByRole('radio', { name: 'Flow', exact: true }).click()
  await expect(pane.locator('.react-flow__node')).toHaveCount(6)
  await expect.poll(() => page.locator('body').evaluate(el => el.hasAttribute('data-hd-dark-theme'))).toBe(theme === 'dark')
  return pane
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`canvas repair contracts in ${theme}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
    })
    test('agent steps follow Faces while check steps keep square tiles', async ({ page }) => {
      await page.goto(`/preview.html?shape-graph&theme=${theme}`)
      const nodes = page.locator('#shape-graph .react-flow__node')
      await expect(nodes).toHaveCount(6)
      const agents = nodes.locator('[data-kind="agent"] [data-slot="icon-tile"]')
      for (const tile of await agents.all()) await expect(tile).toHaveAttribute('data-shape', 'face')
      for (const tile of await nodes.locator('[data-kind="check"] [data-slot="icon-tile"]').all()) await expect(tile).toHaveAttribute('data-shape', 'square')
    })

    test('Run leads align with the first title line', async ({ page }) => {
      const pane = await run(page, theme)
      const deltas = await pane.locator('[data-slot="flow-step"]').evaluateAll(steps => steps.map(step => {
        const card = step.querySelector('[data-slot="card"]:not([data-behind])')!
        const lead = card.firstElementChild!.getBoundingClientRect()
        const title = card.querySelector('[data-role="row"]')!
        const range = document.createRange()
        range.selectNodeContents(title)
        const line = range.getBoundingClientRect()
        return { step: step.getAttribute('data-step'), delta: Math.abs((lead.top + lead.bottom - line.top - line.bottom) / 2) }
      }))
      for (const one of deltas) expect(one.delta, one.step!).toBeLessThan(1.5)
    })

    test('the attribution has a full target hit area', async ({ page }) => {
      await page.goto(`/preview.html?shape-graph&theme=${theme}`)
      const link = page.locator('#shape-graph .react-flow__attribution a')
      await expect(link).toBeVisible()
      const box = (await link.boundingBox())!
      expect(box.width).toBeGreaterThanOrEqual(24)
      expect(box.height).toBeGreaterThanOrEqual(24)
    })

    test('keyboard Run focus paints a ring and the clipped list adds no tab stops', async ({ page }) => {
      const pane = await run(page, theme)
      const node = pane.locator('.react-flow__node[data-id="check"]')
      const card = node.locator('[data-slot="card"]:not([data-behind])')
      const normal = await card.evaluate(el => getComputedStyle(el).boxShadow)
      await page.keyboard.press('Tab')
      await node.focus()
      await expect(node).toBeFocused()
      await expect.poll(() => node.evaluate(el => el.matches(':focus-visible'))).toBe(true)
      expect(await card.evaluate(el => getComputedStyle(el).boxShadow)).not.toBe(normal)
      const stops = await pane.locator('[data-slot="flow-list"] button').evaluateAll(buttons => buttons.filter(button => (button as HTMLButtonElement).tabIndex >= 0).length)
      expect(stops).toBe(0)
    })

    test('poster tools yield to the plan while attribution remains', async ({ page }) => {
      for (const width of [1280, 640, 390]) {
        await page.setViewportSize({ width, height: 900 })
        await page.goto(`/preview.html?site-run=poster&theme=${theme}`)
        const poster = page.locator('[data-slot="site-poster"]')
        await expect(poster.locator('.react-flow__node')).toHaveCount(6)
        await expect(poster.getByRole('button', { name: 'Fit plan' })).toHaveCount(0)
        await expect(poster.locator('.react-flow__minimap')).toHaveCount(0)
        await expect(poster.locator('.react-flow__attribution a')).toBeVisible()
      }
    })

    test('the shape column opens at a readable scale', async ({ page }) => {
      for (const width of [1440, 1024, 700, 390]) {
        await page.setViewportSize({ width, height: 900 })
        await page.goto(`/preview.html?shape-graph&theme=${theme}`)
        const canvas = page.locator('#shape-graph [data-slot="flow-canvas"]')
        await expect(canvas.locator('.react-flow__node')).toHaveCount(6)
        await expect.poll(() => canvas.locator('.react-flow__viewport').evaluate(el => new DOMMatrixReadOnly(getComputedStyle(el).transform).a)).toBeGreaterThanOrEqual(0.8)
      }
    })

    test('a narrow Run keeps a visible selectable Steps list and restores the wide view', async ({ page }) => {
      const pane = await run(page, theme)
      const graph = pane.locator('[data-slot="flow-graph"]')
      // Measure the pane, rather than changing the browser's screen width.
      await graph.evaluate(el => { (el as HTMLElement).style.width = '320px' })
      const row = graph.locator('[data-step-row="check"]')
      await expect.poll(() => row.evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThan(200)
      await row.scrollIntoViewIfNeeded()
      await expect(row).toBeInViewport()
      expect(await row.evaluate(el => (el as HTMLButtonElement).tabIndex)).toBe(0)
      await row.click()
      await expect(row).toHaveAttribute('aria-current', 'true')
      await graph.evaluate(el => { (el as HTMLElement).style.width = '' })
      await expect.poll(() => row.evaluate(el => (el as HTMLButtonElement).tabIndex)).toBe(-1)
    })

    test('repair frames contain only the synthetic desk and poster', async ({ page }) => {
      const folder = process.env.FLOW_REPAIR_FRAMES_DIR
      if (!folder) return
      await mkdir(folder, { recursive: true })
      const pane = await run(page, theme)
      await page.evaluate(async () => { await document.fonts.ready })
      expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
      await pane.screenshot({ path: `${folder}/run-${theme}.png` })
      await page.setViewportSize({ width: 390, height: 900 })
      await pane.screenshot({ path: `${folder}/run-narrow-${theme}.png` })
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.goto(`/preview.html?shape-graph&theme=${theme}`)
      await expect(page.locator('#shape-graph .react-flow__node')).toHaveCount(6)
      await page.evaluate(async () => { await document.fonts.ready })
      expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
      await page.locator('#shape-graph').screenshot({ path: `${folder}/shape-${theme}.png` })
      await page.setViewportSize({ width: 1280, height: 900 })
      await page.goto(`/preview.html?site-run=poster&theme=${theme}`)
      await expect(page.locator('.react-flow__node')).toHaveCount(6)
      await page.evaluate(async () => { await document.fonts.ready })
      expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
      await page.locator('[data-slot="site-run-demo"]').screenshot({ path: `${folder}/poster-${theme}.png` })
    })
  })
}
