import { expect, test, type Page } from '@playwright/test'

/**
 * Guides (`design/explorer/guides.ts`): the lines drawn over a preview frame
 * to show what lines up, what nearly does, and what spills.
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
