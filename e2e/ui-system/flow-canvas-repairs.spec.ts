import { expect, test, type Page, type Locator } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { COLLECT, textReasons } from '../../script/shots/audit.mjs'
import { minimapOverlaps, zoomOf } from './canvas-minimap'

const run = async (page: Page, theme: string) => {
  await page.goto(`/preview.html?flow-overlay&theme=${theme}`)
  const pane = page.locator('#flow-overlay-live')
  await pane.getByRole('tab', { name: /^Run/ }).first().click()
  await pane.getByRole('radio', { name: 'Flow', exact: true }).click()
  await expect(pane.locator('.react-flow__node')).toHaveCount(6)
  await expect.poll(() => page.locator('body').evaluate(el => el.hasAttribute('data-hd-dark-theme'))).toBe(theme === 'dark')
  return pane
}

const nodesInCanvas = async (pane: Locator) => {
  await expect.poll(() => pane.locator('[data-slot="flow-canvas"]').evaluate(canvas => {
    const clip = canvas.getBoundingClientRect()
    return [...canvas.querySelectorAll('.react-flow__node')].every(node => {
      const box = node.getBoundingClientRect()
      return box.top >= clip.top && box.bottom <= clip.bottom && box.left >= clip.left && box.right <= clip.right
    })
  })).toBe(true)
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

    test('a narrow Run reaches the last Step and Rules by wheel and restores the wide view', async ({ page }) => {
      const pane = await run(page, theme)
      await page.setViewportSize({ width: 390, height: 900 })
      await nodesInCanvas(pane)
      const scroll = pane.locator('[data-slot="run-scroll"]')
      const graph = pane.locator('[data-slot="flow-graph"]')
      const row = graph.locator('[data-step-row="you"]')
      await expect.poll(() => row.evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThan(200)
      const box = (await scroll.boundingBox())!
      await page.mouse.move(box.x + box.width / 2, box.y + box.height - 30)
      await page.mouse.wheel(0, 1600)
      await expect.poll(() => scroll.evaluate(el => el.scrollTop + el.clientHeight >= el.scrollHeight - 1)).toBe(true)
      await expect(graph.locator('section[aria-label="Rules"]')).toBeInViewport()
      // The Run header leaves a short scroll area, so the Rules can fill it at the end: the last Step is reached by wheeling back up.
      const above = await row.evaluate(el => el.closest('[data-slot="run-scroll"]')!.getBoundingClientRect().top - el.getBoundingClientRect().top)
      if (above > 0) await page.mouse.wheel(0, -(above + 16))
      await expect(row).toBeInViewport()
      await expect.poll(() => row.evaluate(el => {
        const rect = el.getBoundingClientRect(), clip = el.closest('[data-slot="run-scroll"]')!.getBoundingClientRect()
        return rect.top >= clip.top && rect.bottom <= clip.bottom
      })).toBe(true)
      expect(await row.evaluate(el => (el as HTMLButtonElement).tabIndex)).toBe(0)
      await row.click()
      await expect(row).toHaveAttribute('aria-current', 'true')
      await expect.poll(() => graph.locator('[data-slot="flow-drawing"]').evaluate(el => el.getBoundingClientRect().height)).toBeLessThan(260)
      await page.setViewportSize({ width: 1440, height: 900 })
      await expect.poll(() => row.evaluate(el => (el as HTMLButtonElement).tabIndex)).toBe(-1)
    })

    test('a narrow Run reserves room for its title and navigation tools', async ({ page }) => {
      const pane = await run(page, theme)
      await page.setViewportSize({ width: 390, height: 900 })
      await nodesInCanvas(pane)
      const overlaps = await pane.locator('[data-slot="flow-canvas"]').evaluate(canvas => {
        const nodes = [...canvas.querySelectorAll('.react-flow__node')].map(el => el.getBoundingClientRect())
        return [...canvas.querySelectorAll('.react-flow__panel.top')].some(panel => {
          const box = panel.getBoundingClientRect()
          return nodes.some(node => node.left < box.right && node.right > box.left && node.top < box.bottom && node.bottom > box.top)
        })
      })
      expect(overlaps).toBe(false)
    })

    test('a Run pane of 480 to 600px keeps its minimap off the title and the tools', async ({ page }) => {
      for (const width of [480, 520, 560, 600]) {
        await page.setViewportSize({ width, height: 900 })
        const pane = await run(page, theme)
        const canvas = pane.locator('[data-slot="flow-canvas"]')
        await nodesInCanvas(pane)
        await expect.poll(() => zoomOf(canvas)).toBeLessThan(0.6)
        const folder = process.env.FLOW_REPAIR_FRAMES_DIR
        if (folder && width === 520) {
          await mkdir(folder, { recursive: true })
          await page.evaluate(async () => { await document.fonts.ready })
          expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
          await pane.screenshot({ path: `${folder}/round5-run-${width}-${theme}-${process.env.FLOW_REPAIR_FRAME_PHASE ?? 'after'}.png` })
        }
        expect.soft(await minimapOverlaps(canvas), `minimap at ${width}px`).toEqual([])
      }
    })

    test('the poster ignores drags and pinch while allowing page swipes', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 900 })
      await page.goto(`/preview.html?site-run=poster&theme=${theme}`)
      const canvas = page.locator('[data-slot="site-poster"] [data-slot="flow-canvas"]')
      await expect(canvas.locator('.react-flow__node')).toHaveCount(6)
      const viewport = canvas.locator('.react-flow__viewport')
      await expect.poll(() => viewport.evaluate(el => new DOMMatrixReadOnly(getComputedStyle(el).transform).a)).toBeGreaterThan(0)
      const before = await viewport.getAttribute('style')
      const pane = canvas.locator('.react-flow__pane')
      const box = (await pane.boundingBox())!
      await page.mouse.move(box.x + 8, box.y + 80)
      await page.mouse.down()
      await page.mouse.move(box.x + 188, box.y + 360, { steps: 6 })
      await page.mouse.up()
      expect(await viewport.getAttribute('style')).toBe(before)
      expect(await pane.evaluate(el => getComputedStyle(el).touchAction)).toBe('pan-y')
      await page.keyboard.down('Control')
      await page.mouse.wheel(0, -300)
      await page.keyboard.up('Control')
      expect(await viewport.getAttribute('style')).toBe(before)
    })

    test('position-only shape graphs leave wheel and touch scrolling to the page', async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 })
      await page.goto(`/preview.html?shape-graph&theme=${theme}`)
      const canvas = page.locator('#shape-graph [data-slot="flow-canvas"]')
      await expect(canvas.locator('.react-flow__node')).toHaveCount(6)
      await expect.poll(() => canvas.locator('.react-flow__viewport').evaluate(el => new DOMMatrixReadOnly(getComputedStyle(el).transform).a)).toBeGreaterThanOrEqual(0.8)
      // The standalone board gets the same scrolling boundary as its editor dialog.
      const pageScroll = page.locator('#root')
      await pageScroll.evaluate(el => { (el as HTMLElement).style.overflowY = 'auto' })
      const before = await canvas.locator('.react-flow__viewport').getAttribute('style')
      const box = (await canvas.boundingBox())!
      await page.mouse.move(box.x + box.width / 2, box.y + 100)
      await page.mouse.wheel(0, 600)
      await expect.poll(() => pageScroll.evaluate(el => el.scrollTop)).toBeGreaterThan(0)
      expect(await canvas.locator('.react-flow__viewport').getAttribute('style')).toBe(before)
      expect(await canvas.locator('.react-flow__pane').evaluate(el => getComputedStyle(el).touchAction)).toBe('pan-y')
      await pageScroll.evaluate(el => el.scrollTo(0, 0))
      await canvas.getByRole('button', { name: 'Zoom out' }).click()
      await expect.poll(() => canvas.locator('.react-flow__viewport').getAttribute('style')).not.toBe(before)
    })

    test('Run cards share title and meta baselines despite different lead sizes', async ({ page }) => {
      const pane = await run(page, theme)
      const offsets = await pane.locator('[data-step="write"], [data-step="check"], [data-step="review"]').evaluateAll(steps => steps.map(step => {
        const card = step.querySelector('[data-slot="card"]:not([data-behind])')!.getBoundingClientRect()
        return ['row', 'meta'].map(role => step.querySelector(`[data-role="${role}"]`)!.getBoundingClientRect().top - card.top)
      }))
      for (const index of [0, 1]) expect(Math.max(...offsets.map(one => one[index]!)) - Math.min(...offsets.map(one => one[index]!))).toBeLessThan(1.5)
    })

    test('the need banner heads the Flow tab, above the drawing and on its left edge', async ({ page }) => {
      // The Flow tab lays its column out as a flex box for the drawing; the banner shares that column and was a second item beside it, 0px wide.
      for (const width of [1280, 720, 390]) {
        await page.setViewportSize({ width, height: 900 })
        await page.goto(`/preview.html?run-view&theme=${theme}`)
        const rig = page.locator('#run-view-team')
        await rig.getByRole('tab', { name: 'Run · 1', exact: true }).click()
        await rig.getByRole('radio', { name: 'Flow', exact: true }).click()
        const need = rig.locator('[data-slot="run-need"]')
        const canvas = rig.locator('[data-slot="flow-canvas"]')
        await expect(canvas.locator('.react-flow__node').first()).toBeVisible()
        if (process.env.FLOW_REPAIR_FRAMES_DIR) {
          await mkdir(process.env.FLOW_REPAIR_FRAMES_DIR, { recursive: true })
          await page.evaluate(async () => { await document.fonts.ready })
          expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
          await rig.screenshot({ path: `${process.env.FLOW_REPAIR_FRAMES_DIR}/round6-run-banner-${width}-${theme}-${process.env.FLOW_REPAIR_FRAME_PHASE ?? 'after'}.png` })
        }
        await expect.soft(need, `banner at ${width}px`).toContainText('Ended without a next step')
        const banner = (await need.boundingBox())!
        const card = (await need.locator('> *').first().boundingBox())!
        const drawn = (await canvas.boundingBox())!
        // It has the drawing's own width and left edge, so the page keeps one edge...
        expect.soft(card.width, `banner card at ${width}px`).toBeGreaterThan(200)
        expect.soft(Math.abs(banner.x - drawn.x), `banner left edge at ${width}px`).toBeLessThan(1.5)
        expect.soft(Math.abs(banner.width - drawn.width), `banner width at ${width}px`).toBeLessThan(1.5)
        // ...above the drawing, never beside it, which keeps the rest of the pane.
        expect.soft(banner.y + banner.height, `banner above the drawing at ${width}px`).toBeLessThanOrEqual(drawn.y + 0.5)
        // (A narrow pane fits the drawing to its width, so it is short there by design.)
        expect.soft(drawn.height, `drawing at ${width}px`).toBeGreaterThan(width < 600 ? 100 : 200)
        // Its actions are on screen to use.
        const door = need.getByRole('button').first()
        await expect.soft(door, `banner action at ${width}px`).toBeInViewport()
      }
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
      await nodesInCanvas(pane)
      await pane.screenshot({ path: `${folder}/run-narrow-${theme}.png` })
      const scroll = pane.locator('[data-slot="run-scroll"]')
      const box = (await scroll.boundingBox())!
      await page.mouse.move(box.x + box.width / 2, box.y + box.height - 30)
      await page.mouse.wheel(0, 1600)
      await expect(pane.locator('[data-step-row="you"]')).toBeInViewport()
      await pane.screenshot({ path: `${folder}/run-narrow-scrolled-${theme}.png` })
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
