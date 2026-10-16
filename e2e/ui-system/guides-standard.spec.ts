import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { expect, test, type Page } from '@playwright/test'

import { SCENES, WINDOW, sceneUrl } from '../../packages/ui/src/review/scenes'
import { installFramePreviewFixture } from './frame-preview-fixture'
import { WALL_TIME } from './frame-wall-destinations'
import { writeOnceEveryTestPasses } from './write-once'

/**
 * The guides standard: every scene on the review board, measured by its own
 * guides (`design/explorer/guides.ts`), against what was recorded.
 *
 * A scene's findings are kept as signatures — the element and what is wrong
 * with it — in `packages/ui/src/design/guides-standard.json`. A count may fall
 * but may not rise, and a signature not on the record fails: a new edge off
 * its rail, a new overflow, a new value no token names. Fixing one is free;
 * adding one is a review. `UPDATE_GUIDES=1` re-records, and is a choice to
 * accept what the board shows; `pnpm design:doc` then carries the new counts
 * into docs/design-system.md, whose check fails until it does.
 */

type Kind = 'offLine' | 'overflow' | 'offScale'
type Record_ = Record<string, Record<Kind, Record<string, number>>>
type Report = { page: string; offLine: string[]; overflow: string[]; offScale: string[] }[]

const TABLE = fileURLToPath(new URL('../../packages/ui/src/design/guides-standard.json', import.meta.url))
const UPDATE = process.env.UPDATE_GUIDES === '1'
const KINDS: Kind[] = ['offLine', 'overflow', 'offScale']
const observed: Record_ = {}

const recorded = (): Record_ => {
  try { return JSON.parse(readFileSync(TABLE, 'utf8')) as Record_ } catch { return {} }
}

const tally = (list: string[]) => {
  const out: Record<string, number> = {}
  for (const one of list) out[one] = (out[one] ?? 0) + 1
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)))
}

const measure = async (page: Page, url: string, hasSteps: boolean) => {
  await installFramePreviewFixture(page)
  // Relative times are part of a finding's text; the wall's clock holds them.
  await page.clock.setFixedTime(WALL_TIME)
  await page.goto(url)
  await page.evaluate(async () => { await document.fonts.ready })
  if (hasSteps) {
    const html = page.locator('html')
    await expect(html).toHaveAttribute('data-scene-steps', /^(done|failed)$/, { timeout: 15_000 })
    // A step that found nothing is a scene that no longer reaches its state: measuring it would hold the wrong page to the standard.
    expect(await html.getAttribute('data-scene-steps-missed'), `${url}: scene steps found nothing to act on`).toBeNull()
  }
  // Two reports a beat apart that agree: the page has stopped moving.
  let previous = ''
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(150)
    await page.evaluate(() => window.dispatchEvent(new Event('resize')))
    await page.waitForTimeout(100)
    const now = JSON.stringify(await page.evaluate(() => (window as unknown as { __hdGuides: { current: Report } }).__hdGuides.current))
    if (now === previous && now !== '[]') return JSON.parse(now) as Report
    previous = now
  }
  throw new Error(`guides never settled at ${url}`)
}

test.use({ viewport: { width: WINDOW.width, height: WINDOW.height }, screenshot: 'off', trace: 'off', video: 'off' })
if (UPDATE) writeOnceEveryTestPasses(test, () => writeFileSync(TABLE, `${JSON.stringify(observed, null, 2)}\n`))

for (const scene of SCENES) {
  test(`guides standard: ${scene.id}`, async ({ page }) => {
    if (scene.width || scene.height) await page.setViewportSize({ width: scene.width ?? WINDOW.width, height: scene.height ?? WINDOW.height })
    await page.emulateMedia({ colorScheme: 'light' })
    const report = await measure(page, sceneUrl(scene, 'light', 'lines'), !!scene.steps?.length)
    const found = Object.fromEntries(KINDS.map((kind) => [kind, tally(report.flatMap((one) => one[kind]))])) as Record<Kind, Record<string, number>>
    observed[scene.id] = found
    if (UPDATE) return
    const before = recorded()[scene.id]
    expect(before, `${scene.id} has no record; run with UPDATE_GUIDES=1 and review what it shows`).toBeTruthy()
    for (const kind of KINDS) {
      const grown = Object.entries(found[kind])
        .filter(([signature, count]) => count > (before![kind][signature] ?? 0))
        .map(([signature, count]) => `${signature} ×${count} (was ${before![kind][signature] ?? 0})`)
      expect(grown, `${scene.id}: ${kind} findings the record does not have`).toEqual([])
    }
  })
}
