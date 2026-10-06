import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { COLLECT, textReasons } from '../../script/shots/audit.mjs'
import { FLOW_CANVAS_CARD_WIDTH, FLOW_CANVAS_RUN_CARD_HEIGHT } from '../../packages/ui/src/design/patterns/FlowCanvas/geometry'
import { FLOW_GAP, FLOW_ROW_GAP } from '../../packages/ui/src/lib/flow-layout'

const canvas = (page: Page, scene = 'editable') => page.locator(`#flow-canvas-${scene} [data-slot="flow-canvas"]`)
const node = (surface: Locator, id: string) => surface.locator(`.react-flow__node[data-id="${id}"]`)
const viewport = (surface: Locator) => surface.locator('.react-flow__viewport').evaluate(el => {
  const matrix = new DOMMatrixReadOnly(getComputedStyle(el).transform)
  return { x: matrix.m41, y: matrix.m42, zoom: matrix.a }
})
const position = (element: Locator) => element.evaluate(el => {
  const matrix = new DOMMatrixReadOnly(getComputedStyle(el).transform)
  return { x: matrix.m41, y: matrix.m42 }
})
const checkCanvasGeometry = async (surface: Locator) => surface.evaluate(root => {
  const cards = [...root.querySelectorAll<HTMLElement>('.react-flow__node')].map(el => ({ id: el.dataset.id ?? '', box: el.getBoundingClientRect() }))
  const pathHits: string[] = [], wordDistances: Array<{ word: string; distance: number }> = []
  for (const edge of root.querySelectorAll<SVGGElement>('.react-flow__edge')) {
    const route = edge.querySelector<SVGGElement>('[data-flow-source]')
    const path = edge.querySelector<SVGPathElement>('path.react-flow__edge-path')
    if (!route || !path) continue
    const source = route.dataset.flowSource, target = route.dataset.flowTarget
    const matrix = path.getScreenCTM()
    if (!matrix) continue
    const length = path.getTotalLength()
    for (let distance = 3; distance < length - 3; distance += 3) {
      const point = new DOMPoint(path.getPointAtLength(distance).x, path.getPointAtLength(distance).y).matrixTransform(matrix)
      const hit = cards.find(card => card.id !== source && card.id !== target
        && point.x >= card.box.left - 1 && point.x <= card.box.right + 1
        && point.y >= card.box.top - 1 && point.y <= card.box.bottom + 1)
      if (hit) { pathHits.push(`${source}->${target} crosses ${hit.id}`); break }
    }
  }
  for (const label of root.querySelectorAll<HTMLElement>('.react-flow__edgelabel-renderer > div')) {
    const box = label.getBoundingClientRect(), center = { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 }
    const edge = [...root.querySelectorAll<SVGGElement>('.react-flow__edge')].find(el => el.dataset.id === label.dataset.flowEdgeId)
    const path = edge?.querySelector<SVGPathElement>('path.react-flow__edge-path'), matrix = path?.getScreenCTM()
    let nearest = Infinity
    if (path && matrix) for (let distance = 0; distance <= path.getTotalLength(); distance += 2) {
      const point = new DOMPoint(path.getPointAtLength(distance).x, path.getPointAtLength(distance).y).matrixTransform(matrix)
      nearest = Math.min(nearest, Math.hypot(center.x - point.x, center.y - point.y))
    }
    wordDistances.push({ word: label.textContent ?? '', distance: nearest })
  }
  const rails = [...root.querySelectorAll<SVGGElement>('.react-flow__edge [data-flow-source]')].map(route => {
    const source = route.dataset.flowSource ?? ''
    const rail = route.dataset.flowRailY
    return { source, y: rail ? Number(rail) : Number.NaN }
  })
  const closeRails: string[] = []
  for (let first = 0; first < rails.length; first += 1) for (let second = first + 1; second < rails.length; second += 1) {
    const a = rails[first]!, b = rails[second]!
    if (a.source === b.source && (!Number.isFinite(a.y) || !Number.isFinite(b.y) || Math.abs(a.y - b.y) < 12)) {
      closeRails.push(`${a.source} outgoing rails ${a.y} and ${b.y}`)
    }
  }
  const labelHits: string[] = []
  for (const label of root.querySelectorAll<HTMLElement>('.react-flow__edgelabel-renderer > div')) {
    const labelBox = label.getBoundingClientRect()
    const hit = cards.find(card => labelBox.left < card.box.right && labelBox.right > card.box.left && labelBox.top < card.box.bottom && labelBox.bottom > card.box.top)
    if (hit) labelHits.push(`${label.textContent?.trim() ?? 'rule'} overlaps ${hit.id}`)
  }
  return { pathHits, closeRails, labelHits, wordDistances }
})
const checkRunCardPitch = async (surface: Locator) => surface.evaluate(root => {
  const cards = [...root.querySelectorAll<HTMLElement>('.react-flow__node')].map(el => el.getBoundingClientRect())
  const matrix = new DOMMatrixReadOnly(getComputedStyle(root.querySelector('.react-flow__viewport')!).transform)
  const zoom = matrix.a
  const horizontalGaps: number[] = [], verticalGaps: number[] = []
  for (let first = 0; first < cards.length; first += 1) for (let second = first + 1; second < cards.length; second += 1) {
    const a = cards[first]!, b = cards[second]!
    const centerY = Math.abs((a.top + a.bottom - b.top - b.bottom) / 2)
    const centerX = Math.abs((a.left + a.right - b.left - b.right) / 2)
    if (centerY < 2 * zoom) horizontalGaps.push((Math.max(a.left, b.left) - Math.min(a.right, b.right)) / zoom)
    if (centerX < 2 * zoom) verticalGaps.push((Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom)) / zoom)
  }
  const first = cards[0]
  return { width: first ? first.width / zoom : Number.NaN, height: first ? first.height / zoom : Number.NaN, horizontalGaps, verticalGaps }
})
const contrast = (foreground: string, background: string) => {
  const channels = (color: string) => color.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? []
  const luminance = (color: string) => {
    const [red, green, blue] = channels(color).map(value => {
      const channel = value / 255
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!
  }
  const a = luminance(foreground), b = luminance(background)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}
const drag = async (page: Page, element: Locator, dx: number, dy: number, blank = false) => {
  const box = (await element.boundingBox())!
  const x = box.x + (blank ? 80 : box.width / 2), y = box.y + (blank ? 30 : 20)
  await page.mouse.move(x, y); await page.mouse.down()
  // Cross the engine's drag threshold before measuring the requested movement.
  if (!blank) await page.mouse.move(x + 2, y)
  await page.mouse.move(x + dx + (blank ? 0 : 2), y + dy, { steps: 5 }); await page.mouse.up()
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`FlowCanvas in ${theme}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
      await page.goto(`/preview.html?flow-canvas&theme=${theme}`)
      await page.evaluate(theme => (window as unknown as { __hdPreview: { store: { setTheme: (theme: string) => void } } }).__hdPreview.store.setTheme(theme), theme)
      await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(theme)
      await expect(canvas(page).locator('.react-flow__node')).toHaveCount(5)
      await expect(canvas(page).locator('.react-flow__edge')).toHaveCount(7)
      await expect.poll(async () => (await viewport(canvas(page))).zoom).toBe(1)
    })
    test('opens centred at 100%, pans, zooms, and Fit only shrinks', async ({ page }) => {
      const surface = canvas(page)
      await expect.poll(() => surface.evaluate(root => {
        const box = root.getBoundingClientRect(), nodes = [...root.querySelectorAll('.react-flow__node')].map(el => el.getBoundingClientRect())
        return Math.abs((Math.min(...nodes.map(n => n.left)) + Math.max(...nodes.map(n => n.right))) / 2 - (box.left + box.right) / 2)
      })).toBeLessThan(1)
      await expect.poll(() => surface.evaluate(root => {
        const box = root.getBoundingClientRect(), nodes = [...root.querySelectorAll('.react-flow__node')].map(el => el.getBoundingClientRect())
        return Math.abs((Math.min(...nodes.map(n => n.top)) + Math.max(...nodes.map(n => n.bottom))) / 2 - (box.top + box.bottom) / 2)
      })).toBeLessThan(1)
      const before = await viewport(surface)
      await surface.getByRole('button', { name: 'Hand tool' }).click()
      await drag(page, surface, 80, 60, true)
      await expect.poll(async () => (await viewport(surface)).x).toBeCloseTo(before.x + 80, 0)
      await surface.getByRole('button', { name: 'Zoom in' }).click()
      await expect.poll(async () => (await viewport(surface)).zoom).toBeGreaterThan(1)
      await surface.getByRole('button', { name: 'Fit plan' }).click()
      await expect.poll(async () => (await viewport(surface)).zoom).toBeLessThanOrEqual(1)
      const fitted = (await viewport(surface)).zoom
      await surface.getByRole('button', { name: 'Zoom out' }).click()
      await expect.poll(async () => (await viewport(surface)).zoom).toBeLessThan(fitted)
      const small = (await viewport(surface)).zoom
      await surface.getByRole('button', { name: 'Fit plan' }).click()
      await expect.poll(async () => (await viewport(surface)).zoom).toBeCloseTo(small, 5)
      const previous = (await viewport(surface)).zoom
      await page.setViewportSize({ width: 720, height: 900 })
      await surface.getByRole('button', { name: 'Fit plan' }).click()
      await expect.poll(async () => (await viewport(surface)).zoom).toBeLessThan(previous)
    })
    test('Tab reaches nodes; Enter selects, arrows move and Delete removes nodes and their rules', async ({ page }) => {
      const surface = canvas(page), write = node(surface, 'write')
      await surface.focus()
      // Rules are focusable too; Tab walks them before the step cards.
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press('Tab')
        if (await write.evaluate(el => el === document.activeElement)) break
      }
      await expect(write).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(write).toHaveClass(/selected/)
      const before = await position(write)
      await page.keyboard.press('ArrowRight')
      await expect.poll(() => position(write)).toEqual({ x: before.x + 16, y: before.y })
      await page.keyboard.press('Delete')
      await expect(write).toHaveCount(0)
      await expect(surface.locator('.react-flow__edge')).toHaveCount(2)
    })
    test('drags steps and connects through the engine callbacks', async ({ page }) => {
      const surface = canvas(page), write = node(surface, 'write')
      const before = await position(write)
      await drag(page, write, 32, 16)
      await expect.poll(() => position(write)).toEqual({ x: before.x + 32, y: before.y + 16 })
      const dragState = page.locator('#flow-canvas-editable [data-position-drag-started]')
      await expect(dragState).toHaveAttribute('data-position-drag-started', 'true')
      await expect(dragState).toHaveAttribute('data-position-dragging', 'false')
      await write.hover()
      await write.locator('.react-flow__handle.source').click()
      await node(surface, 'ship').hover()
      await node(surface, 'ship').locator('.react-flow__handle.target').click()
      await expect(surface.locator('.react-flow__edge')).toHaveCount(8)
      await expect(surface).toContainText('next')
      const edgesAfterConnect = await surface.locator('.react-flow__edge').evaluateAll(elements => elements.map(element => ({ id: element.getAttribute('data-id') ?? '', label: element.getAttribute('aria-label') ?? '' })))
      const firstConnectionId = edgesAfterConnect.find(edge => edge.label.endsWith(': next'))?.id
      expect(firstConnectionId).toBeTruthy()
      const existingRule = surface.locator('.react-flow__edge[data-id="r6"]')
      await existingRule.focus()
      await page.keyboard.press('Enter')
      await expect(existingRule).toHaveClass(/selected/)
      await page.keyboard.press('Delete')
      await expect(surface.locator('.react-flow__edge')).toHaveCount(7)
      await write.hover()
      await write.locator('.react-flow__handle.source').click()
      await node(surface, 'ship').hover()
      await node(surface, 'ship').locator('.react-flow__handle.target').click()
      const finalEdges = await surface.locator('.react-flow__edge').evaluateAll(elements => elements.map(element => ({ id: element.getAttribute('data-id') ?? '', label: element.getAttribute('aria-label') ?? '' })))
      const connectionIds = finalEdges.filter(edge => edge.label.endsWith(': next')).map(edge => edge.id)
      const edgeIds = finalEdges.map(edge => edge.id)
      expect(connectionIds).toHaveLength(2)
      expect(connectionIds).toContain(firstConnectionId)
      expect(new Set(edgeIds).size).toBe(edgeIds.length)
    })
    test('routes every rule around cards and keeps same-side rails apart in every scene', async ({ page }) => {
      for (const scene of ['editable', 'readonly', 'run']) {
        const geometry = await checkCanvasGeometry(canvas(page, scene))
        expect(geometry.labelHits, `${scene} rule labels`).toEqual([])
        expect(geometry.pathHits, `${scene} rule paths`).toEqual([])
        expect(geometry.closeRails, `${scene} same-side rails`).toEqual([])
        for (const word of geometry.wordDistances) expect(word.distance, `${scene}: ${word.word}`).toBeLessThanOrEqual(12)
      }
    })
    for (const scene of ['skip', 'long-word', 'short-gap', 'cross-row']) test(`sampled routes in ${scene} keep words on paths and avoid steps`, async ({ page }) => {
      await page.goto(`/preview.html?flow-canvas&routes&theme=${theme}`)
      const surface = canvas(page, scene)
      await expect(surface.locator('.react-flow__edgelabel-renderer > div').first()).toBeVisible()
      const geometry = await checkCanvasGeometry(surface)
      expect(geometry.pathHits, scene).toEqual([])
      expect(geometry.labelHits, scene).toEqual([])
      for (const word of geometry.wordDistances) expect(word.distance, `${scene}: ${word.word}`).toBeLessThanOrEqual(12)
    })
    test('two return answers from one step have non-overlapping words', async ({ page }) => {
      await page.goto(`/preview.html?flow-canvas&routes&theme=${theme}`)
      const surface = canvas(page, 'return-lanes')
      await expect(surface).toContainText('rework')
      const boxes = await surface.locator('.react-flow__edgelabel-renderer > div').evaluateAll(elements => elements.map(el => el.getBoundingClientRect()))
      const [a, b] = boxes
      expect(a && b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom).toBe(false)
    })
    test('fitting the Run leaves every card clear of the minimap', async ({ page }) => {
      const surface = canvas(page, 'run')
      await surface.getByRole('button', { name: 'Fit plan' }).click()
      expect(await surface.evaluate(root => {
        const map = root.querySelector('.react-flow__minimap')?.getBoundingClientRect()
        if (!map || !map.width || !map.height) return []
        return [...root.querySelectorAll<HTMLElement>('.react-flow__node')].filter(el => {
          const box = el.getBoundingClientRect()
          return box.left < map.right && box.right > map.left && box.top < map.bottom && box.bottom > map.top
        }).map(el => el.dataset.id)
      })).toEqual([])
    })
    test('deleting one step keeps a zoomed and panned viewport', async ({ page }) => {
      const surface = canvas(page)
      await surface.getByRole('button', { name: 'Zoom out' }).click()
      await surface.getByRole('button', { name: 'Hand tool' }).click()
      await drag(page, surface, 64, 48, true)
      await surface.getByRole('button', { name: 'Select tool' }).click()
      const write = node(surface, 'write')
      await write.focus(); await page.keyboard.press('Enter')
      const before = await viewport(surface)
      await page.keyboard.press('Delete')
      await expect(write).toHaveCount(0)
      expect(await viewport(surface)).toEqual(before)
    })
    test('Run card pitch follows the rendered card box', async ({ page }) => {
      const pitch = await checkRunCardPitch(canvas(page, 'run'))
      expect(pitch.width).toBeCloseTo(FLOW_CANVAS_CARD_WIDTH, 0)
      expect(pitch.height).toBeCloseTo(FLOW_CANVAS_RUN_CARD_HEIGHT, 0)
      expect(pitch.horizontalGaps.length).toBeGreaterThan(0)
      expect(pitch.verticalGaps.length).toBeGreaterThan(0)
      expect(Math.min(...pitch.horizontalGaps)).toBeGreaterThanOrEqual(FLOW_GAP - 1)
      expect(Math.min(...pitch.verticalGaps)).toBeGreaterThanOrEqual(FLOW_ROW_GAP - 1)
    })
    test('parallel rules keep their words apart', async ({ page }) => {
      const surface = canvas(page)
      const boxes = await surface.locator('.react-flow__edgelabel-renderer').evaluate(root => [...root.children].map(el => ({ text: el.textContent, box: el.getBoundingClientRect() })))
      const ready = boxes.find(one => one.text === 'ready')!.box, back = boxes.find(one => one.text === 'request-changes')!.box
      expect(ready.left < back.right && back.left < ready.right && ready.top < back.bottom && back.top < ready.bottom).toBe(false)
    })
    test('the minimap, attribution and selected rules follow the canvas tokens', async ({ page }) => {
      const surface = canvas(page)
      const background = await surface.evaluate(el => getComputedStyle(el).backgroundColor)
      for (const part of ['.react-flow__minimap', '.react-flow__attribution']) {
        expect(await surface.locator(part).evaluate(el => getComputedStyle(el).backgroundColor)).toBe(background)
      }
      const mask = surface.locator('.react-flow__minimap-mask')
      const quietSurface = await surface.evaluate(el => {
        const probe = document.createElement('span')
        probe.style.backgroundColor = 'var(--hd-muted)'; el.append(probe)
        const color = getComputedStyle(probe).backgroundColor; probe.remove()
        return color
      })
      await expect.poll(() => mask.evaluate(el => getComputedStyle(el).fill)).toBe(quietSurface)
      const link = surface.locator('.react-flow__attribution a')
      await expect(link).toBeVisible()
      const linkColors = await link.evaluate(el => ({ foreground: getComputedStyle(el).color, background: getComputedStyle(el.closest('[data-slot="flow-canvas"]')!).backgroundColor }))
      expect(contrast(linkColors.foreground, linkColors.background)).toBeGreaterThanOrEqual(4.5)
      const edge = surface.locator('.react-flow__edge[data-id="r1"]')
      await edge.focus(); await page.keyboard.press('Enter')
      await expect(edge).toHaveClass(/selected/)
      const accent = await surface.evaluate(el => {
        const probe = document.createElement('span')
        probe.style.color = 'var(--hd-accent)'; el.append(probe)
        const color = getComputedStyle(probe).color; probe.remove()
        return color
      })
      await expect.poll(() => edge.locator('.react-flow__edge-path').evaluate(el => getComputedStyle(el).stroke)).toBe(accent)
    })
    test('marquee and selection borders use the canvas tokens', async ({ page }) => {
      const surface = canvas(page), box = (await canvas(page).boundingBox())!
      await page.mouse.move(box.x + 72, box.y + 44)
      await page.mouse.down()
      await page.mouse.move(box.x + 124, box.y + 92, { steps: 3 })
      const selection = surface.locator('.react-flow__selection')
      await expect(selection).toBeVisible()
      const style = await selection.evaluate(el => ({ fill: getComputedStyle(el).backgroundColor, border: getComputedStyle(el).borderColor, borderStyle: getComputedStyle(el).borderStyle }))
      const tokens = await surface.evaluate(el => {
        const probe = document.createElement('span')
        probe.style.backgroundColor = 'var(--hd-accent-dim)'; probe.style.borderColor = 'var(--hd-accent)'; el.append(probe)
        const result = { fill: getComputedStyle(probe).backgroundColor, border: getComputedStyle(probe).borderColor }
        probe.remove(); return result
      })
      expect(style.fill).toBe(tokens.fill)
      expect(style.border).toBe(tokens.border)
      expect(style.borderStyle).toBe('dotted')
      await page.mouse.up()
    })
    test('shows the token dot grid at 100 percent', async ({ page }) => {
      const surface = canvas(page)
      await expect.poll(async () => (await viewport(surface)).zoom).toBe(1)
      const dots = surface.locator('.react-flow__background circle')
      await expect(surface.locator('.react-flow__background')).toBeVisible()
      expect(await dots.count()).toBeGreaterThan(0)
      const dot = await dots.first().evaluate(el => ({ fill: getComputedStyle(el).fill, radius: getComputedStyle(el).r }))
      const border = await surface.evaluate(el => {
        const probe = document.createElement('span')
        probe.style.color = 'var(--hd-border-strong)'; el.append(probe)
        const color = getComputedStyle(probe).color; probe.remove()
        return color
      })
      expect(dot.fill).toBe(border)
      expect(dot.radius).toBe('0.75px')
    })
    test('read-only wheel input scrolls the page without zooming the plan', async ({ page }) => {
      const editable = canvas(page), editableBox = (await editable.boundingBox())!
      const editableZoom = (await viewport(editable)).zoom
      await page.mouse.move(editableBox.x + 120, editableBox.y + 200)
      await page.mouse.wheel(0, 220)
      await expect.poll(async () => (await viewport(editable)).zoom).toBeLessThan(editableZoom)
      const surface = canvas(page, 'readonly')
      await page.evaluate(() => {
        const canvas = document.querySelector<HTMLElement>('#flow-canvas-readonly [data-slot="flow-canvas"]')!
        const parent = canvas.parentElement!
        const scroller = document.createElement('div')
        scroller.id = 'flow-canvas-wheel-scroll'
        scroller.style.height = '180px'
        scroller.style.overflow = 'auto'
        parent.insertBefore(scroller, canvas)
        scroller.append(canvas)
        const spacer = document.createElement('div')
        spacer.style.height = '480px'
        scroller.append(spacer)
      })
      const readonlyBox = (await surface.boundingBox())!
      await page.mouse.move(readonlyBox.x + 120, readonlyBox.y + 80)
      const before = await viewport(surface)
      const scrollBefore = await page.locator('#flow-canvas-wheel-scroll').evaluate(el => el.scrollTop)
      await page.mouse.wheel(0, 220)
      await expect.poll(async () => (await viewport(surface)).zoom).toBe(before.zoom)
      await expect.poll(() => page.locator('#flow-canvas-wheel-scroll').evaluate(el => el.scrollTop)).toBeGreaterThan(scrollBefore)
    })
    test('hides the minimap at 390px while leaving the plan tools available', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 900 })
      const surface = canvas(page)
      await expect(surface.locator('.react-flow__minimap')).toBeHidden()
      expect(await surface.evaluate(root => {
        const box = root.getBoundingClientRect()
        return [...root.querySelectorAll('.react-flow__node')].every(el => {
          const card = el.getBoundingClientRect()
          return card.left >= box.left && card.right <= box.right && card.top >= box.top && card.bottom <= box.bottom
        })
      })).toBe(true)
      await expect(surface.getByRole('button', { name: 'Fit plan' })).toBeVisible()
      const fitBox = await surface.getByRole('button', { name: 'Fit plan' }).boundingBox()
      const canvasBox = await surface.boundingBox()
      expect(fitBox && canvasBox && fitBox.x >= canvasBox.x && fitBox.x + fitBox.width <= canvasBox.x + canvasBox.width).toBe(true)
    })
    test('read-only allows looking and selection, refuses every edit and shows Run state slots', async ({ page }) => {
      const surface = canvas(page, 'readonly'), write = node(surface, 'write')
      const before = await position(write)
      await write.click(); await expect(write).toHaveClass(/selected/)
      await write.focus(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('Delete')
      await drag(page, write, 30, 20)
      expect(await position(write)).toEqual(before)
      await expect(surface.locator('.react-flow__node')).toHaveCount(5)
      await expect(surface.locator('.react-flow__edge')).toHaveCount(7)
      await expect(surface.getByRole('button', { name: 'Select tool' })).toHaveCount(0)
      await expect(surface.locator('.react-flow__handle').first()).toBeHidden()
      await expect(surface.locator('.react-flow__attribution')).toBeVisible()
      const run = canvas(page, 'run')
      for (const word of ['Done', 'Running', 'Needs you', 'Failed', 'Skipped', 'Next']) await expect(run).toContainText(word)
      await expect(run).toContainText('approve')
    })
    test('the explorer mounts the same board; preview frames contain only synthetic plans', async ({ page }) => {
      const folder = process.env.FLOW_CANVAS_FRAMES_DIR
      if (folder) {
        expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
        await mkdir(folder, { recursive: true })
        await page.evaluate(async () => { await document.fonts.ready })
        const editableBox = await canvas(page).boundingBox()
        expect(editableBox).not.toBeNull()
        await page.screenshot({ path: `${folder}/grid-100-${theme}.png`, clip: { x: editableBox!.x + 12, y: editableBox!.y + 12, width: 180, height: 160 } })
        for (const scene of ['editable', 'readonly', 'run']) {
          await canvas(page, scene).getByRole('button', { name: 'Fit plan' }).click()
          await page.locator(`#flow-canvas-${scene}`).screenshot({ path: `${folder}/${scene}-${theme}.png` })
        }
        await page.setViewportSize({ width: 390, height: 900 })
        await expect(canvas(page).locator('.react-flow__minimap')).toBeHidden()
        await page.locator('#flow-canvas-editable').screenshot({ path: `${folder}/390-${theme}.png` })
        await page.setViewportSize({ width: 1440, height: 900 })
        await page.goto(`/preview.html?flow-canvas&routes&theme=${theme}`)
        await page.evaluate(async () => { await document.fonts.ready })
        for (const scene of ['skip', 'long-word', 'short-gap', 'cross-row', 'return-lanes']) {
          await expect(canvas(page, scene).locator('.react-flow__edgelabel-renderer > div').first()).toBeVisible()
          await canvas(page, scene).getByRole('button', { name: 'Fit plan' }).click()
          await page.locator(`#flow-canvas-${scene}`).screenshot({ path: `${folder}/${scene}-${theme}.png` })
        }
      }
      await page.goto('/design.html?view=flow-canvas')
      await expect(page.locator('[data-slot="flow-canvas"]')).toHaveCount(3)
      await expect(page.locator('#flow-canvas-run')).toContainText('Running')
    })
  })
}
