import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { COLLECT, textReasons } from '../../script/shots/audit.mjs'

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
      await write.hover()
      await write.locator('.react-flow__handle.source').click()
      await node(surface, 'ship').hover()
      await node(surface, 'ship').locator('.react-flow__handle.target').click()
      await expect(surface.locator('.react-flow__edge')).toHaveCount(8)
      await expect(surface).toContainText('next')
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
        for (const scene of ['editable', 'readonly', 'run']) {
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
