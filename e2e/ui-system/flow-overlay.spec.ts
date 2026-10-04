import { expect, test, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { COLLECT, textReasons } from '../../script/shots/audit.mjs'

const advance = (page: Page, scene: string) => page.evaluate(scene => window.dispatchEvent(new CustomEvent('flow-overlay-scene', { detail: scene })), scene)
const graph = (page: Page) => page.locator('#flow-overlay-live [data-slot="flow-graph"]')
const state = (page: Page, step: string) => graph(page).locator(`[data-slot="flow-step"][data-step="${step}"]`)
const tab = (page: Page, name: string) => page.locator('#flow-overlay-live').getByRole('radio', { name, exact: true })
const frame = async (page: Page, name: string, selector = '#flow-overlay-live [data-slot="flow-stage"]') => {
  const folder = process.env.RUN_FLOW_OVERLAY_FRAMES_DIR
  if (!folder) return
  expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
  await mkdir(folder, { recursive: true })
  await page.locator(selector).screenshot({ path: `${folder}/${name}.png` })
}

for (const theme of ['light', 'dark']) {
  test.describe(`Run overlay in ${theme}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
      await page.goto(`/preview.html?flow-overlay&theme=${theme}`)
      const live = page.locator('#flow-overlay-live')
      await live.getByRole('button', { name: /^Run/ }).first().click()
      await tab(page, 'Flow').click()
    })
    test('live rounds and person answers redraw the open Flow without a reload or a tab switch', async ({ page }) => {
      await expect(state(page, 'fix')).toHaveAttribute('data-state', 'working', { timeout: 5000 })
      await expect(state(page, 'review').locator('[data-shape="face"]')).toHaveCount(2)
      await expect(graph(page)).toContainText('request-changes ×1')
      await expect(state(page, 'fix')).toContainText('Edited src/checkout/retry.ts')
      await frame(page, `before-${theme}`, '#flow-overlay-blueprint [data-slot="flow-stage"]')
      await frame(page, `fix-${theme}`)
      await frame(page, `pane-${theme}`, '#flow-overlay-live')
      for (const [scene, step, expected] of [['check-again', 'check', 'working'], ['review', 'review', 'working'], ['you', 'you', 'waiting'], ['settled', 'you', 'done']]) {
        await advance(page, scene!)
        await expect(state(page, step!)).toHaveAttribute('data-state', expected!)
        await expect(tab(page, 'Flow')).toBeChecked()
        if (scene === 'check-again') await expect(state(page, 'check')).toContainText('×2')
        if (scene === 'review') {
          await expect(state(page, 'review')).toContainText('Read src/checkout/retry.ts')
          await expect(state(page, 'check')).toContainText('×3')
        }
        await frame(page, `${scene}-${theme}`)
      }
      await expect(graph(page).locator('[data-slot="flow-baton"]')).toHaveCount(0)
      await expect(graph(page).locator('[data-slot="flow-ring"]')).toHaveCount(0)
    })

    test('annotations stay on the canvas and Working does not cover a current name', async ({ page }) => {
      const fits = async () => graph(page).evaluate(root => {
        const stage = root.querySelector('[data-slot="flow-stage"]')!.getBoundingClientRect()
        return [...root.querySelectorAll('[data-slot="flow-doing"], [data-slot="flow-duration"], [data-slot="flow-word"]')].map(el => ({ name: el.textContent, box: el.getBoundingClientRect() }))
          .filter(({ box }) => box.left < stage.left || box.right > stage.right || box.top < stage.top || box.bottom > stage.bottom)
          .map(({ name }) => name)
      })
      expect(await fits()).toEqual([])
      await advance(page, 'review')
      await expect(state(page, 'review')).toHaveAttribute('data-state', 'working')
      await expect(state(page, 'review')).toContainText('Read src/checkout/retry.ts')
      const collisions = await graph(page).evaluate(root => {
        const annotations = [...root.querySelectorAll('[data-slot="flow-doing"], [data-slot="flow-duration"], [data-slot="flow-word"]')]
        return annotations.flatMap((one, i) => annotations.slice(i + 1).flatMap(two => {
          const a = one.getBoundingClientRect(), b = two.getBoundingClientRect()
          return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom ? [`${one.textContent} / ${two.textContent}`] : []
        }))
      })
      expect(collisions).toEqual([])
      const overlaps = await state(page, 'review').evaluate(root => {
        const name = root.querySelector('[data-slot="text"]')!.getBoundingClientRect()
        const chip = root.querySelector('[data-slot="flow-state"]')!.getBoundingClientRect()
        return name.left < chip.right && chip.left < name.right && name.top < chip.bottom && chip.top < name.bottom
      })
      expect(overlaps).toBe(false)
      expect(await fits()).toEqual([])
    })

    test('steps and all their timeline rows share selection, including repeated rounds', async ({ page }) => {
      await advance(page, 'review')
      await expect(state(page, 'check')).toHaveAttribute('data-state', 'done')
      await state(page, 'check').click()
      await expect(state(page, 'check')).toHaveAttribute('data-selected', 'true')
      await tab(page, 'Timeline').click()
      const timeline = page.locator('#flow-overlay-live [aria-label="Run timeline"]')
      const selected = timeline.locator('[aria-current="true"]')
      await expect(selected).toHaveCount(6)
      await timeline.locator('[data-row="card-3-31"]').click()
      await tab(page, 'Flow').click()
      await expect(state(page, 'review')).toHaveAttribute('data-selected', 'true')
    })

    test('reduced motion stops the baton and ring; the blueprint has no animation', async ({ page }) => {
      await expect(graph(page).locator('[data-slot="flow-baton"]')).toBeVisible()
      const reduced = await graph(page).evaluate(root => root.getAnimations({ subtree: true }).filter(one => one.playState === 'running').length)
      expect(reduced).toBe(0)
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      await expect.poll(() => graph(page).evaluate(root => root.getAnimations({ subtree: true }).filter(one => one.playState === 'running').length)).toBe(2)
      await page.goto(`/preview.html?flow-graph&theme=${theme}`)
      expect(await page.locator('#flow-graph-blueprint').evaluate(root => root.getAnimations({ subtree: true }).length)).toBe(0)
    })

    test('keeps the baton and its phase on unrelated snapshots, and finishes its curve before the next', async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      await expect(graph(page).locator('[data-slot="flow-baton"]')).toBeVisible()
      const glide = await graph(page).locator('[data-slot="flow-baton"]').evaluate(async el => {
        const animation = el.getAnimations()[0]!
        const duration = Number(animation.effect!.getComputedTiming().duration)
        const at = async (fraction: number) => {
          animation.currentTime = duration * fraction
          await new Promise(requestAnimationFrame)
          const box = el.getBoundingClientRect()
          return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
        }
        animation.pause()
        const from = await at(0.2)
        const to = await at(0.7)
        await at(0.2)
        animation.play()
        return Math.hypot(to.x - from.x, to.y - from.y)
      })
      expect(glide).toBeGreaterThan(20)
      await graph(page).locator('[data-slot="flow-baton"]').evaluate(el => { (window as any).__baton = el; (window as any).__batonAnimation = el.getAnimations()[0] })
      await advance(page, 'refresh')
      expect(await graph(page).locator('[data-slot="flow-baton"]').evaluate(el => el === (window as any).__baton && el.getAnimations()[0] === (window as any).__batonAnimation)).toBe(true)
      const old = await graph(page).locator('[data-slot="flow-baton"]').getAttribute('data-path')
      await advance(page, 'check-again')
      await expect(graph(page).locator('[data-slot="flow-baton"]')).toHaveAttribute('data-path', old!)
      // Finishing the current curve avoids a visible teleport on a host push.
      await expect(graph(page).locator('[data-slot="flow-baton"]')).not.toHaveAttribute('data-path', old!, { timeout: 7000 })
      expect(await graph(page).locator('[data-slot="flow-baton"]').evaluate(el => el === (window as any).__baton)).toBe(true)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      expect(await graph(page).evaluate(root => root.getAnimations({ subtree: true }).filter(one => one.playState === 'running').length)).toBe(0)
    })

    test('the accessible step list retains the live state and fits in a narrow pane', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 900 })
      await expect(graph(page).locator('[data-slot="flow-drawing"]')).toBeHidden()
      await expect(graph(page).locator('[data-step-row="fix"]')).toContainText('Working')
      expect(await graph(page).evaluate(root => root.scrollWidth <= root.clientWidth + 1)).toBe(true)
      await advance(page, 'you')
      await expect(graph(page).locator('[data-step-row="you"]')).toContainText('Needs you')
      await graph(page).locator('[data-step-row="you"]').click()
      await tab(page, 'Timeline').click()
      await expect(page.locator('#flow-overlay-live [data-row="round-8"]')).toHaveAttribute('aria-current', 'true')
    })
  })
}
