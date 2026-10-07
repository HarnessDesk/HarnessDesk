import { test, expect } from '@playwright/test'
import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { COLLECT, textReasons } from '../../script/shots/audit.mjs'
const scenes = ['shapes', 'comparison', 'independent-review', 'alignment', 'investigation'] as const
for (const theme of ['light', 'dark'] as const) {
  test(`Run flow shapes and synthetic frames in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.setViewportSize({ width: 1440, height: 1440 })
    for (const scene of scenes) {
      await page.goto(`/preview.html?run-shapes=${scene}&theme=${theme}`)
      const frame = page.locator('#run-shapes-frame')
      await expect(frame.locator('[data-slot="run-header"]')).toBeVisible()
      await page.evaluate(async () => { await document.fonts.ready })
      if (process.env.SHAPES_PHASE !== 'before') {
        if (scene === 'comparison') {
          const a = frame.locator('[data-row="card-1-1"]'); const b = frame.locator('[data-row="card-1-2"]')
          expect((await a.boundingBox())!.y).toBe((await b.boundingBox())!.y)
          await expect(frame.getByText('on Attempt A', { exact: true })).toBeVisible()
          await expect(frame.getByText('on Attempt B', { exact: true })).toBeVisible()
          await expect(frame.locator('[data-row="card-3-5"]')).toContainText('aaaaaaa')
          await expect(a).toHaveAttribute('data-keep', 'kept'); await expect(b).toHaveAttribute('data-keep', 'not-kept')
          await a.getByRole('button', { name: 'Attempt A', exact: true }).click()
          await expect(a).toHaveAttribute('data-selected', 'true')
          await expect(frame.locator('[data-slot="run-inspector"]')).toContainText('Recorded the result')
          // Return the inspector to Run details for the frame.
          await frame.getByRole('button', { name: 'Run details', exact: true }).click()
          await expect(frame.locator('[data-slot="run-inspector"]')).toContainText('Not kept')
        }
        if (scene === 'independent-review' || scene === 'shapes') {
          const cards = frame.locator('[data-slot="timeline-card-grid"][data-count="3"] [data-slot="timeline-card"]')
          await expect(cards).toHaveCount(3)
          expect((await cards.nth(0).boundingBox())!.y).toBe((await cards.nth(2).boundingBox())!.y)
          await expect(frame.getByText('Blind until the round closes', { exact: true })).toHaveCount(1)
        }
        if (scene === 'alignment') {
          await expect(frame.locator('[data-kind="person"][data-slot="timeline-card"]')).toContainText('You')
          await expect(frame.locator('[data-slot="timeline-item"]:has([data-kind="ahead"])').first()).toHaveAttribute('data-state', 'pending')
        }
        if (scene === 'investigation') {
          await expect(frame.locator('[data-slot="timeline-document"]')).toContainText('docs/answer.md')
          await expect(frame.locator('[data-slot="timeline-document-body"]')).toContainText('Investigation answer')
          await expect(frame.locator('[data-slot="run-header"]')).toContainText('Answer committed at')
          await expect(frame.getByRole('button', { name: /Pull request/ })).toHaveCount(0)
        }
        expect(await frame.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
      }
      expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
      if (process.env.SHAPES_FRAMES_DIR) {
        await mkdir(process.env.SHAPES_FRAMES_DIR, { recursive: true })
        await frame.screenshot({ path: path.join(process.env.SHAPES_FRAMES_DIR, `${scene}-${theme}-${process.env.SHAPES_PHASE ?? 'after'}.png`) })
      }
    }
  })
  test(`round geometry follows its column and lists beyond three in ${theme}`, async ({ page }) => {
    test.skip(process.env.SHAPES_PHASE === 'before')
    await page.emulateMedia({ colorScheme: theme })
    for (const [width, count, columns] of [[1050, 2, 2], [1050, 3, 3], [1050, 4, 1], [420, 2, 1], [420, 3, 1]] as const) {
      await page.setViewportSize({ width, height: 1100 })
      await page.goto(`/preview.html?run-shapes=shapes&standalone&count=${count}&theme=${theme}`)
      const cards = page.locator(`[data-slot="timeline-card-grid"][data-count="${count}"] [data-slot="timeline-card"]`)
      await expect(cards).toHaveCount(count)
      const first = (await cards.nth(0).boundingBox())!; const last = (await cards.nth(count - 1).boundingBox())!
      if (columns === 1) expect(last.y).toBeGreaterThan(first.y)
      else expect(last.y).toBe(first.y)
      const reading = page.locator('[data-slot="run-reading"]')
      expect(await reading.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
      if (process.env.SHAPES_FRAMES_DIR && count === 3 && width === 420) {
        expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
        await page.locator('#run-shapes-frame').screenshot({ path: path.join(process.env.SHAPES_FRAMES_DIR, `shapes-narrow-${theme}-after.png`) })
      }
    }
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`checkout-qualified check labels at equal revisions in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.setViewportSize({ width: 1440, height: 1440 })
    // Keep the recorded checkouts distinct while making both committed revisions equal.
    await page.route('**/run-shapes-fixture.ts', async route => {
      const response = await route.fetch()
      const body = (await response.text()).replace('"b".repeat(40)', '"a".repeat(40)')
      await route.fulfill({ response, body })
    })
    await page.goto(`/preview.html?run-shapes=comparison&theme=${theme}`)
    const frame = page.locator('#run-shapes-frame')
    await expect(frame.locator('[data-slot="run-header"]')).toBeVisible()
    await page.evaluate(async () => { await document.fonts.ready })
    expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
    if (process.env.CHECK_LABEL_FRAMES_DIR) {
      await mkdir(process.env.CHECK_LABEL_FRAMES_DIR, { recursive: true })
      await frame.screenshot({ path: path.join(process.env.CHECK_LABEL_FRAMES_DIR, `equal-revisions-${theme}-${process.env.CHECK_LABEL_PHASE ?? 'after'}.png`) })
    }
    await expect(frame.locator('[data-row="check-2-3"]')).toContainText('on Attempt A')
    await expect(frame.locator('[data-row="check-2-3"]')).toContainText('Passed')
    await expect(frame.locator('[data-row="check-2-4"]')).toContainText('on Attempt B')
    await expect(frame.locator('[data-row="check-2-4"]')).toContainText('Failed')
    await expect(frame.locator('[data-row="card-3-5"]')).toContainText('Attempt B at aaaaaaa')
    expect(await frame.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
  })
}
