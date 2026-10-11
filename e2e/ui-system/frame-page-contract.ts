import { expect, type Page } from '@playwright/test'
import { installFramePreviewFixture } from './frame-preview-fixture'
import { FRAME } from '../../packages/ui/src/design/frame'
import { applyPageFrameActions, type PageFrameActions } from './frame-page-actions'
export const measureDestination = async (page: Page, query: string, widthKind: 'reading' | 'wide' | 'canvas', theme: 'light' | 'dark', width: number, actions: PageFrameActions = {}): Promise<void> => {
  await installFramePreviewFixture(page)
  await page.setViewportSize({ width, height: 900 })
  await page.emulateMedia({ colorScheme: theme })
  await page.goto(`/preview.html?${query}&theme=${theme}`)
  await page.evaluate(() => document.fonts.ready)
  await applyPageFrameActions(page, actions)
  const bar = page.locator('[data-slot="top-bar"]:visible')
  await expect(bar).toHaveCount(1)
  expect((await bar.locator('..').boundingBox())!.height).toBe(FRAME.bar.height)
  await expect(bar.locator('[data-work-tool]')).toHaveCount(0)
  await expect(bar.locator('[data-topbar="view"] button')).toHaveCount(0)
  await expect(bar.locator('[data-topbar="more"] button')).toBeVisible()
  const title = bar.locator('[data-topbar-title]')
  const titleText = title.locator('[data-slot="text"]').first()
  const titleStyle = await titleText.evaluate(element => {
    const css = getComputedStyle(element)
    return { size: parseFloat(css.fontSize), weight: css.fontWeight, family: css.fontFamily }
  })
  expect(titleStyle.size).toBe(14)
  expect(titleStyle.weight).toBe('500')
  expect(titleStyle.family).toContain('Geist')
  expect((await title.boundingBox())!.width).toBeGreaterThanOrEqual(FRAME.bar.titleMin - 1)
  const moreBox = (await bar.locator('[data-topbar="more"] button').boundingBox())!
  expect(Math.abs(moreBox.x + moreBox.width - (width - FRAME.bar.pad))).toBeLessThanOrEqual(1)
  const leftTop = page.locator('[data-left-top]:visible')
  if (await leftTop.count()) {
    const topBox = (await leftTop.boundingBox())!, barBox = (await bar.locator('..').boundingBox())!
    expect(topBox.height).toBe(FRAME.bar.height)
    expect(Math.abs(topBox.y + topBox.height - barBox.y - barBox.height)).toBeLessThanOrEqual(1)
  }
  const column = page.locator(`[data-page-destination]:visible [data-slot="page"][data-width="${widthKind}"]`).first()
  await expect(column).toBeVisible()
  const value = await column.evaluate(element => {
    const css = getComputedStyle(element), box = element.getBoundingClientRect()
    const parent = element.parentElement!.getBoundingClientRect()
    const left = parseFloat(css.paddingLeft), right = parseFloat(css.paddingRight)
    return { width: box.width - left - right, available: parent.width, left, right,
      top: parseFloat(css.paddingTop), centre: (box.left + box.right) / 2 - (parent.left + parent.right) / 2,
      edges: [...element.children].filter(child => getComputedStyle(child).display !== 'none' && child.getClientRects().length > 0)
        .map(child => child.getBoundingClientRect().left - box.left - left) }
  })
  const gutter = widthKind === 'canvas' ? FRAME.page.canvasGutter : FRAME.page.gutter
  expect([value.left, value.right, value.top]).toEqual([gutter, gutter, gutter])
  const expected = widthKind === 'canvas' ? value.available - 2 * gutter
    : Math.min(FRAME.page[widthKind], value.available - 2 * gutter)
  expect(value.width).toBeCloseTo(expected, 0)
  expect(Math.abs(value.centre)).toBeLessThanOrEqual(1)
  expect(value.edges.length).toBeGreaterThan(0)
  for (const edge of value.edges) expect(Math.abs(edge), 'every top-level block starts on the column edge').toBeLessThanOrEqual(1)
  const textEdges = await column.evaluate(root => [...root.querySelectorAll('[data-slot="rows"], [data-slot="summary-list"], [data-slot="section"]')].flatMap(surface => {
    const leaves = [...surface.querySelectorAll('[data-slot="row-title"], [data-slot="section-head"] [data-slot="group-label"], [data-slot="summary-key"], [data-slot="section-footer"] [data-slot="text"]')]
      .filter(element => element.getClientRects().length > 0 && element.closest('[data-slot="rows"], [data-slot="summary-list"], [data-slot="section"]') === surface)
    return leaves.length > 1 ? [leaves.map(element => element.getBoundingClientRect().left)] : []
  }))
  for (const edges of textEdges) for (const edge of edges) expect(Math.abs(edge - edges[0]!), 'head, row and footer text keep one left edge').toBeLessThanOrEqual(1)
  await expect(page.locator('[data-frame-region="right"]:visible [data-slot="tool-body"]')).toHaveCount(0)
  await expect(page.locator('[data-slot="status-bar"]')).toHaveCount(0)
  await expect(page.locator('[data-frame-region="right"]:visible')).toHaveCount(0)
  for (const control of await bar.locator('button:visible, a:visible, input:visible, select:visible, textarea:visible, [role="tab"]:visible, [role="button"]:visible').all()) {
    expect(await control.evaluate(element => getComputedStyle(element).getPropertyValue('-webkit-app-region'))).toBe('no-drag')
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
}
export const expectDestinationTab = async (page: Page, value: string): Promise<void> => {
  const tab = page.locator(`[data-slot="top-bar"]:visible [role="tab"][data-team-page="${value}"]`)
  if (await tab.count()) { await expect(tab).toHaveAttribute('aria-selected', 'true'); return }
  await page.getByTitle('Destination views', { exact: true }).click()
  const item = page.locator(`[role="menu"] [data-team-page="${value}"]:visible`)
  await expect(item).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')
}
