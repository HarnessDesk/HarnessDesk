import { closeRunInspector, selectRunView } from './run-frame-actions'
import { selectTeamDestination, selectTeamPage } from './team-frame-actions'
import { closeFloatingTeamRail } from './team-frame-actions'
import { expect, test, type Page, type Locator } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { COLLECT, textReasons } from '../../script/shots/audit.mjs'
import { minimapOverlaps, zoomOf } from './canvas-minimap'

const run = async (page: Page, theme: string) => {
  await page.goto(`/preview.html?flow-overlay&theme=${theme}`)
  const pane = page.locator('#flow-overlay-live')
  await selectTeamDestination(pane, 'run')
  await selectRunView(pane, 'Flow')
  await expect(pane.locator('.react-flow__node')).toHaveCount(6)
  await expect.poll(() => page.locator('body').evaluate(el => el.hasAttribute('data-hd-dark-theme'))).toBe(theme === 'dark')
  return pane
}

const nodesInCanvas = async (pane: Locator) => {
  await expect(pane.locator('[data-slot="flow-canvas"] .react-flow__panel.top.left')).toHaveText('The path this Run took')
  await expect.poll(() => pane.locator('[data-slot="flow-canvas"]').evaluate(canvas => {
    const clip = canvas.getBoundingClientRect()
    const title = canvas.querySelector('.react-flow__panel.top.left')!.getBoundingClientRect()
    return [...canvas.querySelectorAll('.react-flow__node')].every(node => {
      const box = node.getBoundingClientRect()
      const overlapsTitle = box.left < title.right && box.right > title.left && box.top < title.bottom && box.bottom > title.top
      return !overlapsTitle && box.top >= clip.top && box.bottom <= clip.bottom && box.left >= clip.left && box.right <= clip.right
    })
  })).toBe(true)
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`canvas repair contracts in ${theme}`, () => {
    test('keeps the whole working role name clear of its state badge', async ({ page }) => {
      await page.route('**/lib/flow-model.ts', async route => {
        const response = await route.fetch()
        const body = (await response.text()).replace(/const name = stepName\(role.id\);?/, 'const name = role.id === "fix" ? "Competitor" : stepName(role.id);')
        await route.fulfill({ response, body })
      })
      const pane = await run(page, theme)
      const step = pane.locator('[data-step="fix"]')
      const name = step.locator('[title="Competitor"]')
      await expect(name).toHaveText('Competitor')
      await page.evaluate(async () => { await document.fonts.ready })
      expect(await name.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(false)
      expect(await step.evaluate(el => {
        const name = el.querySelector('[title="Competitor"]')!.getBoundingClientRect()
        const state = el.querySelector('[data-slot="flow-state"]')!.getBoundingClientRect()
        return name.left < state.right && name.right > state.left && name.top < state.bottom && name.bottom > state.top
      })).toBe(false)
    })
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
        const lead = card.querySelector('[data-slot="flow-node-mark"]')!.getBoundingClientRect()
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

    {

      for (const [item0, width] of ([1280, 640, 390]).entries()) test(`poster tools yield to the plan while attribution remains [item ${[item0].join('-')}]`, async ({ page }) => {

        await page.setViewportSize({ width, height: 900 })
        await page.goto(`/preview.html?site-run=poster&theme=${theme}`)
        const poster = page.locator('[data-slot="site-poster"]')
        await expect(poster.locator('.react-flow__node')).toHaveCount(6)
        await expect(poster.getByRole('button', { name: 'Fit plan' })).toHaveCount(0)
        await expect(poster.locator('.react-flow__minimap')).toHaveCount(0)
        await expect(poster.locator('.react-flow__attribution a')).toBeVisible()


      })
    }

    {

      for (const [item0, width] of ([1440, 1024, 700, 390]).entries()) test(`the shape column opens at a readable scale [item ${[item0].join('-')}]`, async ({ page }) => {

        await page.setViewportSize({ width, height: 900 })
        await page.goto(`/preview.html?shape-graph&theme=${theme}`)
        const canvas = page.locator('#shape-graph [data-slot="flow-canvas"]')
        await expect(canvas.locator('.react-flow__node')).toHaveCount(6)
        await expect.poll(() => canvas.locator('.react-flow__viewport').evaluate(el => new DOMMatrixReadOnly(getComputedStyle(el).transform).a)).toBeGreaterThanOrEqual(0.8)


      })
    }

    test('a narrow Work view reaches the full record and last Step by wheel and Fit restores the wide drawing', async ({ page }) => {
      const pane = await run(page, theme)
      await pane.scrollIntoViewIfNeeded()
      const graph = pane.locator('[data-slot="flow-graph"]')
      const canvas = graph.locator('[data-slot="flow-canvas"]')
      await nodesInCanvas(pane)
      const wideWidth = await canvas.evaluate(el => el.getBoundingClientRect().width)
      const wideZoom = await zoomOf(canvas)
      await page.setViewportSize({ width: 390, height: 900 })
      await expect.poll(() => canvas.evaluate(el => el.getBoundingClientRect().width)).toBeLessThan(wideWidth)
      await nodesInCanvas(pane)
      await closeFloatingTeamRail(pane)
      const scroll = pane.locator('[data-slot="run-scroll"]')
      const narrowWidth = await canvas.evaluate(el => el.getBoundingClientRect().width)
      const narrowZoom = await zoomOf(canvas)
      expect(narrowZoom).toBeLessThan(wideZoom)
      // Work keeps one finite drawing; its Steps and Rules remain the text
      // alternative rather than a second visible record below the graph.
      await expect(graph.locator('[data-slot="flow-list"]')).toHaveAttribute('data-placement', 'dock')
      await expect(graph.locator('section[aria-label="Rules"]')).toHaveCount(1)
      expect(await graph.locator('[data-slot="flow-list"] button').evaluateAll(buttons => buttons.filter(button => (button as HTMLButtonElement).tabIndex >= 0).length)).toBe(0)
      await pane.getByRole('button', { name: 'Full record', exact: true }).click()
      const record = pane.getByRole('list', { name: 'Run timeline', exact: true })
      await expect(record).toBeVisible()
      const row = record.locator('[data-step-row="you"]')
      await expect.poll(() => row.evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThan(200)
      const box = (await scroll.boundingBox())!
      await page.mouse.move(box.x + box.width / 2, box.y + box.height - 30)
      await page.mouse.wheel(0, 1600)
      await expect.poll(() => scroll.evaluate(el => el.scrollTop + el.clientHeight >= el.scrollHeight - 1)).toBe(true)
      // The final recorded/future step must be reached through the page's
      // actual scroll owner, rather than the clipped text alternative.
      const above = await row.evaluate(el => el.closest('[data-slot="run-scroll"]')!.getBoundingClientRect().top - el.getBoundingClientRect().top)
      if (above > 0) await page.mouse.wheel(0, -(above + 16))
      await expect(row).toBeInViewport()
      await expect.poll(() => row.evaluate(el => {
        const rect = el.getBoundingClientRect(), clip = el.closest('[data-slot="run-scroll"]')!.getBoundingClientRect()
        return rect.top >= clip.top && rect.bottom <= clip.bottom
      })).toBe(true)
      const select = row.getByRole('button')
      await select.focus()
      await expect(select).toBeFocused()
      await select.press('Enter')
      const inspection = pane.locator('[data-slot="run-inspector"]')
      await expect(inspection.getByRole('region', { name: 'You', exact: true })).toBeVisible()
      // Narrow Details makes Work inert. Its accessible timeline returns when
      // the pane closes, with the keyboard selection retained.
      await expect(record).toHaveCount(0)
      await expect(inspection).toContainText('Not reached')
      await expect(inspection).toContainText('This step has not opened a round.')
      await expect(inspection).toContainText('Merged · Dropped')
      await expect(inspection.getByRole('region', { name: 'Your answer', exact: true })).toHaveCount(0)
      await closeRunInspector(pane)
      await expect(record).toBeVisible()
      await expect(row).toHaveAttribute('aria-current', 'true')
      await expect(graph.locator('[data-slot="flow-list"]')).toHaveAttribute('data-placement', 'dock')
      await expect.poll(() => graph.locator('[data-slot="flow-drawing"]').evaluate(el => el.getBoundingClientRect().height)).toBe(360)
      await nodesInCanvas(pane)
      await page.setViewportSize({ width: 1440, height: 900 })
      await expect.poll(() => canvas.evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThan(narrowWidth)
      // Resize preserves the person's scale; Fit explicitly restores the
      // readable wide view instead of relying on an incidental canvas remount.
      await canvas.getByRole('button', { name: 'Fit plan', exact: true }).click()
      await expect.poll(() => zoomOf(canvas)).toBeGreaterThan(narrowZoom)
      await nodesInCanvas(pane)
      expect(await graph.locator('[data-slot="flow-list"] button').evaluateAll(buttons => buttons.filter(button => (button as HTMLButtonElement).tabIndex >= 0).length)).toBe(0)
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
        await expect(canvas.locator('.react-flow__minimap')).toHaveCount(0)
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

    {

      for (const [item0, width] of ([1280, 720, 390]).entries()) test(`the need banner follows Flow, aligns with the activity column, and its action is reachable by wheel [item ${[item0].join('-')}]`, async ({ page }) => {

        await page.setViewportSize({ width, height: 900 })
        await page.goto(`/preview.html?run-view&theme=${theme}`)
        const rig = page.locator('#run-view-team')
        if (width === 390) await selectTeamDestination(rig, 'run')
        else await selectTeamPage(rig, 'run')
        await selectRunView(rig, 'Flow')
        await rig.scrollIntoViewIfNeeded()
        await closeFloatingTeamRail(rig)
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
        const activity = (await rig.locator('[data-slot="run-reading"]').boundingBox())!
        expect.soft(card.width, `banner card at ${width}px`).toBeGreaterThan(200)
        expect.soft(Math.abs(banner.x - activity.x), `banner left edge at ${width}px`).toBeLessThan(1.5)
        expect.soft(Math.abs(banner.width - activity.width), `banner width at ${width}px`).toBeLessThan(1.5)
        expect.soft(drawn.y + drawn.height, `Flow above the banner at ${width}px`).toBeLessThanOrEqual(banner.y + 0.5)
        expect.soft(banner.y + banner.height, `banner before activity at ${width}px`).toBeLessThanOrEqual(activity.y + 0.5)
        expect.soft(drawn.height, `drawing at ${width}px`).toBeGreaterThan(width < 600 ? 100 : 200)
        const scroll = rig.locator('[data-slot="run-scroll"]')
        const box = (await scroll.boundingBox())!
        await page.mouse.move(box.x + box.width / 2, box.y + box.height - 30)
        await page.mouse.wheel(0, 1600)
        await expect.poll(() => scroll.evaluate(el => el.scrollTop + el.clientHeight >= el.scrollHeight - 1)).toBe(true)
        const door = need.getByRole('button').first()
        await expect.soft(door, `banner action at ${width}px`).toBeInViewport()


      })
    }

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
      await closeFloatingTeamRail(pane)
      await pane.screenshot({ path: `${folder}/run-narrow-${theme}.png` })
      await pane.getByRole('button', { name: 'Full record', exact: true }).click()
      const record = pane.getByRole('list', { name: 'Run timeline', exact: true })
      await expect(record).toBeVisible()
      const scroll = pane.locator('[data-slot="run-scroll"]')
      const box = (await scroll.boundingBox())!
      await page.mouse.move(box.x + box.width / 2, box.y + box.height - 30)
      await page.mouse.wheel(0, 1600)
      await expect(record.locator('[data-step-row="you"]')).toBeInViewport()
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

for (const theme of ['light', 'dark'] as const) {
  test(`recent activity keeps one text column across retained faces and check glyphs in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
    await page.goto(`/preview.html?frame-wall=team-run-recorded&theme=${theme}`)
    const rows = page.locator('[data-presentation="activity"]')
    await expect(rows).toHaveCount(3)
    for (const width of [1440, 720]) {
      await page.setViewportSize({ width, height: 900 })
      const columns = await rows.evaluateAll(nodes => nodes.map(row => {
        const content = row.querySelector('[data-slot="list-row-content"]')!.getBoundingClientRect()
        const title = row.querySelector('[data-slot="list-row-title"]')!.getBoundingClientRect()
        const subtitle = row.querySelector('[data-slot="list-row-subtitle"]')!.getBoundingClientRect()
        const mark = row.querySelector('[data-slot="flow-activity-mark"]')!.getBoundingClientRect()
        const glyph = row.querySelector('[data-slot="flow-activity-mark"] svg')!.getBoundingClientRect()
        return { left: content.left, title: title.left, subtitle: subtitle.left, markWidth: mark.width,
          glyphWidth: glyph.width, vertical: Math.abs((glyph.top + glyph.bottom - content.top - content.bottom) / 2) }
      }))
      expect(Math.max(...columns.map(one => one.left)) - Math.min(...columns.map(one => one.left)), `${width}px activity text column`).toBeLessThan(1.5)
      expect(columns.map(one => one.markWidth)).toEqual([16, 16, 16])
      expect(new Set(columns.map(one => one.glyphWidth))).toEqual(new Set([13, 16]))
      for (const column of columns) {
        expect(column.title).toBe(column.subtitle)
        expect(column.vertical).toBeLessThan(1.5)
      }
    }
  })
  test(`route chips retain their compact plate and show every outcome without clipping in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
    for (const scene of ['equivalent', 'not-reached', 'repeated']) {
      await page.goto(`/preview.html?frame-wall=team-run-${scene}&theme=${theme}`)
      const labels = page.locator('[data-slot="flow-word"] [data-slot="chip-words"]')
      await expect(labels).toHaveCount(3)
      await page.evaluate(() => document.fonts.ready)
      const measured = await labels.evaluateAll(nodes => nodes.map(words => {
        const chip = words.closest('[data-slot="chip"]')!, style = getComputedStyle(words)
        return { text: words.textContent, height: parseFloat(getComputedStyle(chip).height),
          line: parseFloat(style.lineHeight), expectedLine: parseFloat(style.getPropertyValue('--hd-line-xs')),
          width: words.clientWidth, scrollWidth: words.scrollWidth, wordsHeight: words.clientHeight, scrollHeight: words.scrollHeight }
      }))
      expect(measured.map(one => one.text).sort(), scene).toEqual(['approve', 'pass', 'request-changes'])
      for (const label of measured) {
        expect(label.height, `${scene}: ${label.text} keeps its compact plate`).toBe(18)
        expect(label.line).toBe(label.expectedLine)
        expect(label.scrollHeight, `${scene}: ${label.text} has no vertical clip`).toBeLessThanOrEqual(label.wordsHeight)
        expect(label.scrollWidth, `${scene}: ${label.text} stays whole`).toBeLessThanOrEqual(label.width)
      }
    }
  })
}
