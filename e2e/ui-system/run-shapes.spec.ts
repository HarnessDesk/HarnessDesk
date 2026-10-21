import { runBar } from './run-frame-actions'
import { test, expect } from '@playwright/test'
import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { COLLECT, textReasons } from '../../script/shots/audit.mjs'
const scenes = ['shapes', 'comparison', 'independent-review', 'alignment', 'investigation'] as const
for (const theme of ['light', 'dark'] as const) {
  {

    for (const [item0, scene] of (scenes).entries()) test(`Run flow shapes and synthetic frames in ${theme} [item ${[item0].join('-')}]`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme })
      await page.setViewportSize({ width: 1440, height: 1440 })
      await page.goto(`/preview.html?run-shapes=${scene}&theme=${theme}`)
      const frame = page.locator('#run-shapes-frame')
      await expect(runBar(frame)).toBeVisible()
      await expect(frame.locator('[data-slot="run-header"]')).toHaveCount(0)
      await page.evaluate(async () => { await document.fonts.ready })
      if (process.env.SHAPES_PHASE !== 'before') {
        const story = frame.locator('[data-slot="workbench-main"] [data-slot="run-steps"]')
        const inspection = frame.locator('[data-slot="run-inspector"]')
        if (scene === 'comparison') {
          await expect(story.locator('[data-step-row][data-row]')).toHaveCount(4)
          await story.locator('[data-row="card-1-1"] button').click()
          const recorded = inspection.getByRole('region', { name: 'Recorded cards', exact: true })
          const a = recorded.getByRole('button', { name: /^Attempt A(?:\s|$)/ }), b = recorded.getByRole('button', { name: /^Attempt B(?:\s|$)/ })
          await expect(a).toContainText('Attempt A'); await expect(b).toContainText('Attempt B')
          await expect(a).toHaveAttribute('aria-current', 'true')
          await expect(a).toContainText('Picked'); await expect(b).toContainText('Not kept')
          await b.click()
          await expect(b).toHaveAttribute('aria-current', 'true')
          await expect(a).not.toHaveAttribute('aria-current', 'true')
          await expect(inspection).toContainText('Recorded the result')
          await frame.getByRole('button', { name: 'Close pane', exact: true }).click()
          await expect(inspection).toHaveCount(0)
          await frame.locator('[data-slot="workbench-main"]').getByRole('button', { name: 'Run details', exact: true }).click()
          await expect(frame.locator('[aria-label="Team Run facts"]')).toBeVisible()
          await story.locator('[data-row="check-2-3"] button').click()
          const checks = inspection.getByRole('region', { name: 'Recorded cards', exact: true })
          await expect(checks.locator('[data-slot="list-row"]').filter({ hasText: 'on Attempt A' })).toContainText('Passed')
          await expect(checks.locator('[data-slot="list-row"]').filter({ hasText: 'on Attempt B' })).toContainText('Failed')
          await story.locator('[data-row="card-3-5"] button').click()
          const compared = inspection.getByRole('region', { name: 'Compared attempts', exact: true }).locator('[data-slot="list-row"]')
          await expect(compared).toHaveCount(2)
          await expect(compared.first()).toContainText('aaaaaaa')
          await expect(compared.first()).toContainText('Picked')
          await expect(compared.last()).toContainText('Not kept')
          await compared.last().click()
          await expect(b).toHaveAttribute('aria-current', 'true')
        }
        if (scene === 'independent-review' || scene === 'shapes') {
          await expect(story.locator('[data-step-row][data-row]')).toHaveCount(2)
          await expect(story.getByText(/Blind until the round closes/)).toHaveCount(1)
          await story.locator('[data-row="card-2-2"] button').click()
          const cards = inspection.getByRole('region', { name: 'Recorded cards', exact: true }).locator('[data-slot="list-row"]')
          await expect(cards).toHaveCount(3)
          await cards.nth(2).click()
          await expect(cards.nth(2)).toHaveAttribute('aria-current', 'true')
        }
        if (scene === 'alignment') {
          await expect(story.locator('[data-kind="person"][data-step-row]')).toContainText('Person')
          await expect(story.locator('[data-step-row][data-flow-state="future"]').first()).toBeVisible()
          await story.locator('[data-kind="person"] button').click()
          await expect(inspection).toContainText('Agree on the plan before work starts')
        }
        if (scene === 'investigation') {
          await story.locator('[data-row="card-1-1"] button').click()
          await expect(inspection.locator('[data-slot="timeline-document"]')).toContainText('docs/answer.md')
          await expect(inspection.locator('[data-slot="timeline-document-body"]')).toContainText('Investigation answer')
          await expect(frame.locator('[aria-label="Team Run facts"] [data-slot="summary-item"]').filter({ hasText: /^Answer at/ })).toContainText('aaaaaaa')
          await expect(frame.getByRole('button', { name: /Pull request/ })).toHaveCount(0)
        }
        expect(await frame.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
      }
      expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
      if (process.env.SHAPES_FRAMES_DIR) {
        await mkdir(process.env.SHAPES_FRAMES_DIR, { recursive: true })
        await frame.screenshot({ path: path.join(process.env.SHAPES_FRAMES_DIR, `${scene}-${theme}-${process.env.SHAPES_PHASE ?? 'after'}.png`) })
      }


    })
  }
  {

    for (const [item0, [width, count, columns]] of ([[1050, 2, 2], [1050, 3, 3], [1050, 4, 1], [420, 2, 1], [420, 3, 1]] as const).entries()) test(`round geometry follows its column and lists beyond three in ${theme} [item ${[item0].join('-')}]`, async ({ page }) => {
      test.skip(process.env.SHAPES_PHASE === 'before')
      await page.emulateMedia({ colorScheme: theme })
      await page.setViewportSize({ width, height: 1100 })
      await page.goto(`/preview.html?run-shapes=shapes&standalone&count=${count}&theme=${theme}`)
      const cards = page.locator(`[data-slot="timeline-card-grid"][data-count="${count}"] [data-slot="timeline-card"]`)
      await expect(cards).toHaveCount(count)
      const first = (await cards.nth(0).boundingBox())!;
      const last = (await cards.nth(count - 1).boundingBox())!
      if (columns === 1) expect(last.y).toBeGreaterThan(first.y)
      else expect(last.y).toBe(first.y)
      const reading = page.locator('[data-slot="run-reading"]')
      expect(await reading.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
      if (process.env.SHAPES_FRAMES_DIR && count === 3 && width === 420) {
        expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
        await page.locator('#run-shapes-frame').screenshot({ path: path.join(process.env.SHAPES_FRAMES_DIR, `shapes-narrow-${theme}-after.png`) })
      }


    })
  }
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
    await expect(runBar(frame)).toBeVisible()
    await expect(frame.locator('[data-slot="run-header"]')).toHaveCount(0)
    await page.evaluate(async () => { await document.fonts.ready })
    expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
    if (process.env.CHECK_LABEL_FRAMES_DIR) {
      await mkdir(process.env.CHECK_LABEL_FRAMES_DIR, { recursive: true })
      await frame.screenshot({ path: path.join(process.env.CHECK_LABEL_FRAMES_DIR, `equal-revisions-${theme}-${process.env.CHECK_LABEL_PHASE ?? 'after'}.png`) })
    }
    const story = frame.locator('[data-slot="workbench-main"] [data-slot="run-steps"]')
    const inspection = frame.locator('[data-slot="run-inspector"]')
    await story.locator('[data-row="check-2-3"] button').click()
    const checks = inspection.getByRole('region', { name: 'Recorded cards', exact: true })
    const a = checks.locator('[data-slot="list-row"]').filter({ hasText: 'on Attempt A' })
    const b = checks.locator('[data-slot="list-row"]').filter({ hasText: 'on Attempt B' })
    await expect(a).toContainText('Passed')
    await expect(b).toContainText('Failed')
    await b.click()
    await expect(b).toHaveAttribute('aria-current', 'true')
    await expect(inspection).toContainText('/repo/attempt-1')
    await story.locator('[data-row="card-3-5"] button').click()
    await expect(inspection.getByRole('region', { name: 'Compared attempts', exact: true })
      .getByRole('button', { name: /^Attempt B(?:\s|$)/ })).toContainText('aaaaaaa')
    expect(await frame.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
  })
}
