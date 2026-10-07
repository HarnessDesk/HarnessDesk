import { expect, test, type Page } from '@playwright/test'

const SCENES = ['blueprint', 'straight', 'loop', 'fan-out', 'person', 'positions', 'long', 'legacy'] as const

interface Rect { readonly id: string; readonly x: number; readonly y: number; readonly w: number; readonly h: number }

/** Every step, outcome word and arrowhead tip of one drawing, in the stage's own coordinates. */
const measure = (page: Page, scene: string) => page.evaluate((scene) => {
  const root = document.querySelector(`#flow-graph-${scene}`)!
  const stage = root.querySelector('[data-slot="flow-canvas"]')!
  const origin = stage.getBoundingClientRect()
  const rect = (id: string, el: Element): Rect => {
    const box = el.getBoundingClientRect()
    return { id, x: box.left - origin.left, y: box.top - origin.top, w: box.width, h: box.height }
  }
  return {
    stage: { w: origin.width, h: origin.height },
    steps: [...root.querySelectorAll('[data-slot="flow-step"]')].map((el) => rect(el.getAttribute('data-step')!, el)),
    words: [...root.querySelectorAll('[data-slot="flow-word"]')].map((el) => rect(el.textContent ?? '', el)),
    tips: [...root.querySelectorAll('[data-slot="flow-edge"]')].map((edge) => {
      const path = edge.querySelector('path')! as SVGPathElement
      const tip = path.getPointAtLength(path.getTotalLength()).matrixTransform(path.getScreenCTM()!)
      const [from, to] = (edge.getAttribute('data-edge') ?? '').split('>')
      return { edge: edge.getAttribute('data-edge')!, from: from!, to: to!, x: tip.x - origin.left, y: tip.y - origin.top }
    }),
  }
}, scene)

const hit = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

for (const theme of ['light', 'dark'] as const) {
  test.describe(`FlowGraph in ${theme}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme })
      await page.goto(`/preview.html?flow-graph&theme=${theme}`)
      for (const scene of SCENES) await expect(page.locator(`#flow-graph-${scene} .react-flow__node`).first()).toBeVisible()
      if (theme === 'dark') await expect(page.locator('body')).toHaveAttribute('data-hd-dark-theme', '')
      else await expect(page.locator('body')).not.toHaveAttribute('data-hd-dark-theme', '')
    })

    test('no label sits on a card or on another label, and no card on another, in any Flow', async ({ page }) => {
      for (const scene of SCENES) {
        await expect(page.locator(`#flow-graph-${scene} .react-flow__edge`)).not.toHaveCount(0)
        const drawn = await measure(page, scene)
        expect(drawn.steps.length, scene).toBeGreaterThan(1)
        const clashes: string[] = []
        for (const word of drawn.words) for (const step of drawn.steps) if (hit(word, step)) clashes.push(`${word.id} on ${step.id}`)
        drawn.words.forEach((word, index) => drawn.words.slice(index + 1).forEach((other) => { if (hit(word, other)) clashes.push(`${word.id} on ${other.id}`) }))
        drawn.steps.forEach((step, index) => drawn.steps.slice(index + 1).forEach((other) => { if (hit(step, other)) clashes.push(`${step.id} on ${other.id}`) }))
        expect(clashes, scene).toEqual([])
        const outside = [...drawn.steps, ...drawn.words].filter((one) => one.x < 0 || one.y < 0 || one.x + one.w > drawn.stage.w + 0.5 || one.y + one.h > drawn.stage.h + 0.5)
        expect(outside.map((one) => one.id), `${scene} stays on its canvas`).toEqual([])
      }
    })

    test('every arrowhead lands on the card its rule goes to', async ({ page }) => {
      for (const scene of SCENES) {
        await expect(page.locator(`#flow-graph-${scene} .react-flow__edge`)).not.toHaveCount(0)
        const drawn = await measure(page, scene)
        const card = new Map(drawn.steps.map((step) => [step.id, step]))
        for (const tip of drawn.tips) {
          const to = card.get(tip.to)!
          const outsideX = Math.max(to.x - tip.x, 0, tip.x - (to.x + to.w))
          const outsideY = Math.max(to.y - tip.y, 0, tip.y - (to.y + to.h))
          const inside = Math.min(tip.x - to.x, to.x + to.w - tip.x, tip.y - to.y, to.y + to.h - tip.y)
          // On the border, to a pixel and a half: neither floating clear of it nor buried in the card.
          expect(Math.hypot(outsideX, outsideY), `${scene} ${tip.edge} stops short`).toBeLessThanOrEqual(1.5)
          expect(Math.max(inside, 0), `${scene} ${tip.edge} runs into the card`).toBeLessThanOrEqual(1.5)
        }
      }
    })

    test('reads left to right, with a loop under the line, and a person closing the line under what handed it over', async ({ page }) => {
      const { steps } = await measure(page, 'blueprint')
      const at = new Map(steps.map((step) => [step.id, step]))
      const x = (id: string) => at.get(id)!.x
      const y = (id: string) => at.get(id)!.y
      expect([x('write'), x('check'), x('review'), x('land')]).toEqual([...[x('write'), x('check'), x('review'), x('land')]].sort((a, b) => a - b))
      expect(new Set([y('write'), y('check'), y('review'), y('land')]).size, 'the main line is one row').toBe(1)
      expect(y('fix'), 'the fix loop falls below the line').toBeGreaterThan(y('review'))
      expect(y('you')).toBeGreaterThan(y('land'))
    })

    test('a Flow’s own positions win over the drawing’s', async ({ page }) => {
      const { steps } = await measure(page, 'positions')
      const at = new Map(steps.map((step) => [step.id, step]))
      const from = at.get('write')!
      const offset = (id: string) => [at.get(id)!.x - from.x, at.get(id)!.y - from.y]
      expect(offset('check')[0]).toBeCloseTo(260 * 296 / 240)
      expect(offset('check')[1]).toBeCloseTo(90 * 218 / 156)
      expect(offset('review')[0]).toBeCloseTo(520 * 296 / 240)
      expect(offset('review')[1]).toBeCloseTo(0)
      expect(offset('you')[0]).toBeCloseTo(780 * 296 / 240)
      expect(offset('you')[1]).toBeCloseTo(90 * 218 / 156)
    })

    test('a step that opens several seats is a fanned stack, and one seat is a single card', async ({ page }) => {
      expect(await page.locator('#flow-graph-blueprint [data-step="review"] [data-behind]').count()).toBe(1)
      expect(await page.locator('#flow-graph-fan-out [data-step="review"] [data-behind]').count()).toBe(2)
      expect(await page.locator('#flow-graph-blueprint [data-step="write"] [data-behind]').count()).toBe(0)
    })

    test('the kinds keep their own tint, and an Agent is a square tile', async ({ page }) => {
      const tiles = await page.locator('#flow-graph-blueprint [data-slot="flow-step"]').evaluateAll((steps) => steps.map((step) => {
        const tile = step.querySelector('[data-slot="icon-tile"]')!
        return { kind: step.getAttribute('data-kind'), tint: tile.getAttribute('data-tint'), shape: tile.getAttribute('data-shape'), ground: getComputedStyle(tile).backgroundColor }
      }))
      expect(Object.fromEntries(tiles.map((tile) => [tile.kind, tile.tint]))).toEqual({ agent: 'violet', check: 'sky', person: 'amber' })
      expect(new Set(tiles.map((tile) => tile.shape))).toEqual(new Set(['square']))
      expect(new Set(tiles.map((tile) => tile.ground)).size, 'three kinds, three grounds').toBe(3)
    })

    test('cards stand off the canvas, and the blueprint’s lines are not lost on it', async ({ page }) => {
      const read = await page.locator('#flow-graph-blueprint').evaluate((root) => {
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 1
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!
        const rgba = (color: string) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return Array.from(ctx.getImageData(0, 0, 1, 1).data) }
        const over = (front: number[], back: number[]) => front.slice(0, 3).map((v, i) => v * front[3]! / 255 + back[i]! * (1 - front[3]! / 255))
        const ground = (el: Element) => {
          const chain: Element[] = []
          for (let parent: Element | null = el; parent; parent = parent.parentElement) chain.unshift(parent)
          return chain.reduce((bg, one) => over(rgba(getComputedStyle(one).backgroundColor), bg), [255, 255, 255])
        }
        const luminance = (rgb: number[]) => rgb.map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0)
        const contrast = (a: number[], b: number[]) => { const hi = Math.max(luminance(a), luminance(b)); const lo = Math.min(luminance(a), luminance(b)); return (hi + 0.05) / (lo + 0.05) }
        const stage = root.querySelector('[data-slot="flow-canvas"]')!
        const base = ground(stage)
        const line = getComputedStyle(stage.querySelector('[data-slot="flow-edge"] path')!)
        const stroke = rgba(line.stroke)
        const inked = over([stroke[0]!, stroke[1]!, stroke[2]!, 255 * Number(line.strokeOpacity)], base)
        const card = getComputedStyle(root.querySelector('[data-step="write"] [data-slot="card"]')!)
        // The computed shadow always lists Tailwind's empty ring layers; a card is lifted only if one layer is drawn.
        const layers = card.boxShadow.match(/rgba?\([^)]*\)\s+-?[\d.]+px\s+-?[\d.]+px\s+[\d.]+px/g) ?? []
        const lifted = layers.some((layer) => Number(/rgba\(\d+, \d+, \d+, ([\d.]+)\)/.exec(layer)?.[1] ?? 1) > 0 && Number(layer.split(/\s+/).at(-1)!.replace('px', '')) > 0)
        return { line: contrast(inked, base), lifted, edge: card.borderTopWidth }
      })
      // The lines are graphics a person has to follow: the 3:1 WCAG asks of them.
      expect(read.line).toBeGreaterThanOrEqual(3)
      expect(read.lifted, 'the raised card casts a shadow').toBe(true)
      expect(read.edge).toBe('1px')
    })

    test('an earned line arrives whole on the blueprint, and a long one gives way to an ellipsis', async ({ page }) => {
      const clipped = await page.locator('#flow-graph-blueprint [data-slot="flow-step"] [data-slot="text"]')
        .evaluateAll((texts) => texts.filter((text) => text.scrollWidth > text.clientWidth + 1).map((text) => text.textContent))
      expect(clipped).toEqual([])
      const names = await page.locator('#flow-graph-blueprint [data-slot="flow-step"]').evaluateAll((steps) => steps.map((step) => step.textContent))
      expect(names.join('|')).toContain('Edit · asked, not enforced')
      expect(names.join('|')).toContain('Read only · asked, not enforced')
      expect(names.join('|')).toContain('pnpm verify')
      // A Run whose seats were held to their ceiling says so, in the same line.
      const held = await page.locator('#flow-graph-loop [data-slot="flow-step"]').evaluateAll((steps) => steps.map((step) => step.textContent))
      expect(held.join('|')).toContain('Edit')
      expect(held.join('|')).toContain('Read only')
    })

    test('the canvas and accessible lists remain available at wide and narrow widths', async ({ page }) => {
      const wide = page.locator('#flow-graph-blueprint')
      await expect(wide.locator('[data-slot="flow-drawing"]')).toBeVisible()
      await expect(wide.locator('section[aria-label="Steps"] [data-slot="list-row"]')).toHaveCount(6)
      await expect(wide.locator('section[aria-label="Rules"] [data-slot="row"]')).toHaveCount(6)

      // The container decides, not the window: a narrow column in a wide window.
      const narrow = page.locator('#flow-graph-narrow')
      await expect(narrow.locator('[data-slot="flow-drawing"]')).toBeVisible()
      await expect(narrow.locator('section[aria-label="Steps"] [data-slot="list-row"]')).toHaveCount(6)
      await expect(narrow.locator('section[aria-label="Rules"] [data-slot="row"]')).toHaveCount(6)
      const fits = await narrow.locator('[data-slot="flow-graph"]').evaluate((el) => el.scrollWidth <= el.clientWidth + 1)
      expect(fits).toBe(true)
    })

    test('a window as narrow as a phone keeps the canvas navigable without page overflow', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 900 })
      for (const scene of SCENES) {
        const graph = page.locator(`#flow-graph-${scene} [data-slot="flow-graph"]`)
        await expect(graph.locator('[data-slot="flow-drawing"]'), scene).toBeVisible()
        await expect(graph.locator('section[aria-label="Steps"]'), scene).toBeVisible()
        expect(await graph.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), `${scene} fits`).toBe(true)
      }
      const run = page.locator('#flow-graph-run-narrow [data-slot="run-view"]')
      await expect(run.locator('[data-slot="run-flow"]')).toBeVisible()
      expect(await run.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    })

    test('opens centred at 100%, Fit never enlarges, and the Run refuses node edits', async ({ page }) => {
      const canvas = page.locator('#flow-graph-straight [data-slot="flow-canvas"]')
      const viewport = () => canvas.locator('.react-flow__viewport').evaluate(el => {
        const matrix = new DOMMatrix(getComputedStyle(el).transform)
        return { x: matrix.m41, y: matrix.m42, zoom: matrix.a }
      })
      await expect.poll(async () => (await viewport()).zoom).toBe(1)
      const centre = await canvas.evaluate(root => {
        const surface = root.getBoundingClientRect()
        const boxes = [...root.querySelectorAll('.react-flow__node')].map(el => el.getBoundingClientRect())
        return { x: (Math.min(...boxes.map(box => box.left)) + Math.max(...boxes.map(box => box.right))) / 2 - (surface.left + surface.width / 2),
          y: (Math.min(...boxes.map(box => box.top)) + Math.max(...boxes.map(box => box.bottom))) / 2 - (surface.top + surface.height / 2) }
      })
      expect(Math.abs(centre.x)).toBeLessThan(1)
      expect(Math.abs(centre.y)).toBeLessThan(1)
      await canvas.getByRole('button', { name: 'Zoom out' }).click()
      await expect.poll(async () => (await viewport()).zoom).toBeLessThan(1)
      const smaller = (await viewport()).zoom
      await canvas.getByRole('button', { name: 'Fit plan' }).click()
      expect((await viewport()).zoom).toBeLessThanOrEqual(smaller)
      const step = canvas.locator('.react-flow__node').first()
      const before = await step.getAttribute('style')
      await step.focus()
      await page.keyboard.press('ArrowRight')
      await page.keyboard.press('Delete')
      await expect(step).toHaveAttribute('style', before!)
      await expect(canvas.locator('.react-flow__node.draggable, .react-flow__handle.connectable')).toHaveCount(0)
    })

    test('the Run’s header offers the Flow beside the timeline, and opens its file to read', async ({ page }) => {
      const run = page.locator('#flow-graph-run [data-slot="run-view"]')
      const choice = (name: string) => run.locator('[role="radiogroup"][aria-label="Show the Run as"]').getByRole('radio', { name, exact: true })
      await expect(choice('Flow')).toBeChecked()
      const head = run.locator('[data-slot="run-flow-head"]')
      await expect(head).toContainText('Build and review')
      await expect(head).toContainText('revision 3f9a1c')
      await expect(head).toContainText('frozen when this Run started')
      await expect(run.locator('[data-slot="flow-step"]')).toHaveCount(4)

      // The Flow has the whole pane, so the drawing shows at an ordinary width; the inspector returns with the timeline.
      const workspace = page.locator('#flow-graph-run [data-slot="run-workspace"]')
      await expect(workspace.locator('[data-slot="run-inspector"]')).toHaveCount(0)
      await expect(workspace.locator('[data-slot="flow-drawing"]')).toBeVisible()
      const pane = (await workspace.boundingBox())!
      const drawing = (await workspace.locator('[data-slot="flow-drawing"]').boundingBox())!
      expect(drawing.width).toBeGreaterThan(pane.width * 0.9)

      await choice('Timeline').click()
      await expect(run.locator('[aria-label="Run timeline"]')).toBeVisible()
      await expect(run.locator('[data-slot="run-flow"]')).toHaveCount(0)
      await expect(workspace.locator('[data-slot="run-inspector"]')).toBeVisible()
      await choice('Flow').click()
      await expect(run.locator('[data-slot="run-flow"]')).toBeVisible()
      await expect(workspace.locator('[data-slot="run-inspector"]')).toHaveCount(0)

      const open = run.getByRole('button', { name: 'Open the file' })
      await open.click()
      const dialog = page.getByRole('dialog', { name: 'Build and review' })
      await expect(dialog).toContainText('.harnessdesk/flows/build-and-review.yml')
      await expect(dialog).toContainText('keeps the revision it started with')
      await expect(dialog).toContainText('name: "Build and review"')
      await expect(dialog.locator('textarea, input')).toHaveCount(0)
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
      await expect(open).toBeFocused()
    })
  })
}
