import { expect, test } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'

/**
 * The catalogue's conversation header cases (#983 follow-up).
 *
 * Each one crops the real `Conversation` to its own header — the composer
 * dock is `position: absolute; bottom: 0` of the mounted screen, not of the
 * crop, so a frame this short pulls it up over the header unless it is
 * hidden for these cases specifically (`surfaces.module.css`). A regression
 * there either brings the dock back over the header (no visible bar) or
 * grows the frame well past the header's own height — both caught here.
 */

const CASES = [
  'conversation-header-idle',
  'conversation-header-ceiling',
  'conversation-header-running',
  'conversation-header-waiting',
  'conversation-header-failed',
  'conversation-header-narrow',
] as const

test('all six header cases render a header, cropped to it and nothing more', async ({ page }) => {
  await page.goto('/design.html?view=conversation')
  await page.evaluate(async () => { await document.fonts.ready })
  await page.waitForTimeout(300)

  for (const id of CASES) {
    const wrap = page.locator(`[data-testid="${id}"]`)
    await expect(wrap).toBeVisible()
    await wrap.scrollIntoViewIfNeeded()
    const bar = wrap.locator('[data-slot="bar"]')
    await expect(bar).toBeVisible()

    const measured = await wrap.evaluate((el) => {
      const frame = el.querySelector('[class*="frame"]') as HTMLElement
      const barEl = el.querySelector('[data-slot="bar"]') as HTMLElement
      const barRect = barEl.getBoundingClientRect()
      // `toBeVisible` only asks whether the bar has a box and is not
      // `display: none` — an absolutely positioned dock stacked on top of it
      // (the exact shape of the bug this guards) still passes that check, so
      // this also asks what element the page actually draws on top at the
      // bar's own centre point.
      const onTop = document.elementFromPoint(barRect.x + barRect.width / 2, barRect.y + barRect.height / 2)
      return {
        frameHeight: frame.getBoundingClientRect().height,
        barHeight: barRect.height,
        barIsOnTop: barEl.contains(onTop) || onTop === barEl,
      }
    })
    expect(Math.abs(measured.frameHeight - measured.barHeight)).toBeLessThanOrEqual(4)
    expect(measured.barIsOnTop).toBe(true)
  }
})

test('the minimum desktop case keeps 180px and at least 10 title characters', async ({ page }) => {
  await page.goto('/design.html?view=conversation')
  await page.evaluate(async () => { await document.fonts.ready })
  await page.waitForTimeout(300)

  const bar = page.locator('[data-testid="conversation-header-narrow"] [data-slot="bar"]')
  const fit = await bar.evaluate((el) => {
    const title = el.querySelector('[data-topbar-title] > *') as HTMLElement
    const cs = getComputedStyle(title)
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')!
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
    const text = title.textContent ?? ''
    const width = title.getBoundingClientRect().width
    let count = 0
    for (let index = 0; index < text.length; index += 1) {
      if (ctx.measureText(text.slice(0, index + 1)).width > width) break
      count = index + 1
    }
    return { count, width, overflow: el.scrollWidth - el.clientWidth }
  })
  expect(fit.count).toBeGreaterThanOrEqual(10)
  expect(fit.width).toBeGreaterThanOrEqual(FRAME.bar.titleMin)
  expect(fit.overflow).toBeLessThanOrEqual(0)
})
