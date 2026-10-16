import { expect, test, type Page } from '@playwright/test'

import { SCENES, WINDOW, sceneUrl } from '../../packages/ui/src/review/scenes'
import { installFramePreviewFixture } from './frame-preview-fixture'

/**
 * Guides (`design/explorer/guides.ts`): the lines drawn over a preview frame
 * to show what lines up, what nearly does, and what spills — and the fix
 * preview that corrects what it can and measures again.
 *
 * The drawing is a canvas, so these read the report it keeps beside it —
 * `window.__hdGuides` — and prove three things the canvas cannot be seen to
 * do: it never takes a click from the screen under it, Alt+G steps through
 * the modes, and an edge nudged two pixels off its rail is found.
 */

type Report = { page: string; offLine: string[]; overflow: string[] }[]

const open = async (page: Page, query: string) => {
  await page.setViewportSize({ width: 1500, height: 1000 })
  await page.goto(`/preview.html?theme=light${query}`)
  await page.evaluate(async () => { await document.fonts.ready })
  const frame = page.locator('[data-frame-id="settings-sheet"]').first()
  await frame.evaluate(el => el.scrollIntoView({ block: 'start' }))
  return frame
}

const reportFor = (page: Page, id: string) => page.evaluate(id =>
  ((window as unknown as { __hdGuides: { current: Report } }).__hdGuides.current).find(one => one.page === id) ?? null, id)

test('guides draw over the frames and take no click from them', async ({ page }) => {
  const frame = await open(page, '&guides=lines')
  const canvas = page.locator('canvas[data-guides="lines"]')
  await expect(canvas).toHaveCount(1)
  expect(await canvas.evaluate(el => getComputedStyle(el).pointerEvents)).toBe('none')
  await expect.poll(() => reportFor(page, 'settings-sheet')).not.toBeNull()

  const row = frame.locator('[data-left-row] [data-slot="sidebar-menu-button"]', { hasText: 'Appearance' }).first()
  await row.click()
  await expect(frame.getByRole('heading', { name: 'Appearance' }).first()).toBeVisible()
})

test('Alt+G steps through the modes and off removes the drawing', async ({ page }) => {
  await open(page, '&guides=off')
  await expect(page.locator('canvas[data-guides]')).toHaveCount(0)
  await page.keyboard.press('Alt+KeyG')
  await expect(page.locator('canvas[data-guides="boxes"]')).toHaveCount(1)
  await page.keyboard.press('Alt+KeyG')
  await page.keyboard.press('Alt+KeyG')
  await expect(page.locator('canvas[data-guides="all"]')).toHaveCount(1)
  await page.keyboard.press('Alt+KeyG')
  await expect(page.locator('canvas[data-guides]')).toHaveCount(0)
})

test('an edge nudged two pixels off its rail is reported', async ({ page }) => {
  await open(page, '&guides=lines')
  await expect.poll(() => reportFor(page, 'settings-sheet')).not.toBeNull()
  const before = (await reportFor(page, 'settings-sheet'))!.offLine
  expect(before.some(one => one.includes('Notifications'))).toBe(false)

  await page.addStyleTag({ content: '[data-frame-id="settings-sheet"] [data-left-row] [data-slot="sidebar-menu-button"][data-guides-nudge] { translate: 2px 0 }' })
  await page.locator('[data-frame-id="settings-sheet"] [data-left-row] [data-slot="sidebar-menu-button"]', { hasText: 'Notifications' }).first()
    .evaluate(el => { el.setAttribute('data-guides-nudge', ''); window.dispatchEvent(new Event('resize')) })
  await expect.poll(async () => (await reportFor(page, 'settings-sheet'))!.offLine.find(one => one.includes('Notifications')) ?? '')
    .toContain('Δ2')
})

test('the fix preview corrects what the guides can, and the guides measure the result', async ({ page }) => {
  // The Details panel of an agent that keeps no background list. Its empty
  // state touched its card until #1738 gave it the card's edge; the test puts
  // the flaw back, so it goes on proving the guides find it and fix it.
  const scene = SCENES.find(one => one.id === 'conversation-details-no-background')!
  await page.setViewportSize({ width: WINDOW.width, height: WINDOW.height })
  await installFramePreviewFixture(page)
  const overflow = async (url: string) => {
    await page.goto(url)
    await expect(page.locator('html')).toHaveAttribute('data-scene-steps', 'done', { timeout: 15_000 })
    await page.addStyleTag({ content: '[data-slot="empty-state"] { padding-inline: 0 }' })
    await page.waitForTimeout(800)
    await page.evaluate(() => window.dispatchEvent(new Event('resize')))
    await page.waitForTimeout(300)
    return page.evaluate(() => (window as unknown as { __hdGuides: { current: Report } }).__hdGuides.current.flatMap(one => one.overflow))
  }
  expect(await overflow(sceneUrl(scene, 'light', 'lines'))).toContain('h3[text] "Nothing to list" touches frame')

  const after = await overflow(`${sceneUrl(scene, 'light', 'lines')}&fix=1`)
  expect(after.filter(one => one.includes('touches frame'))).toEqual([])
  expect(await page.locator('[data-slot="empty-state"]').first().evaluate(el => (el as HTMLElement).style.paddingLeft)).toBe('var(--hd-space-3)')
})
