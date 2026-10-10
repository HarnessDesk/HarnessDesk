import { expect, test, type Page } from '@playwright/test'
import { FRAME, FRAME_TOKENS } from '../../packages/ui/src/design/frame'
import { WALL_THEMES } from './frame-wall-destinations'
import { selectFrameTab } from './frame-actions'

/**
 * The rendered check (spec, "How it is checked"): the app measured against
 * the frame contract in `packages/ui/src/design/frame.ts`. Each phase of the
 * frame work adds what it moved; nothing here is a literal of its own.
 */
const openFrame = async (page: Page, query: string, theme: 'light' | 'dark', width = 1440) => {
  await page.setViewportSize({ width, height: 900 })
  await page.emulateMedia({ colorScheme: theme })
  await page.goto(`/preview.html?${query}&theme=${theme}`)
  if (theme === 'dark') await expect(page.locator('body')).toHaveAttribute('data-hd-dark-theme', '')
  await page.evaluate(async () => { await document.fonts.ready })
}

/** A token's resolved pixels: a hidden probe takes it as its width. */
const resolvedPx = (page: Page, token: string) => page.evaluate((name) => {
  const probe = document.createElement('div')
  probe.style.cssText = `position:absolute;visibility:hidden;width:var(${name})`
  document.body.append(probe)
  const px = probe.getBoundingClientRect().width
  probe.remove()
  return px
}, token)

for (const theme of WALL_THEMES) {
  test(`frame tokens resolve to the contract in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation', theme)
    for (const [token, px] of Object.entries(FRAME_TOKENS)) {
      expect(await resolvedPx(page, token), token).toBe(px)
    }
  })
}
for (const theme of WALL_THEMES) {
  test(`bars stand ${FRAME.bar.height}px in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation', theme)
    const rows = page.locator('[data-region="sidebar-header"] [data-slot="bar"]')
    await expect(rows.first()).toBeVisible()
    const heights = await rows.evaluateAll((bars) => bars.map((bar) => Math.round(bar.getBoundingClientRect().height)))
    expect(heights.length).toBeGreaterThan(0)
    for (const height of heights) expect(height).toBe(FRAME.bar.height)
    const header = page.locator('[data-slot="workbench-main"] header[data-slot="bar"]').first()
    await expect(header).toBeVisible()
    expect(Math.round((await header.boundingBox())!.height)).toBe(FRAME.bar.height)
  })

  test(`a menu keeps the contract in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=team', theme)
    await page.locator('[data-slot="team-room"] header').first().getByRole('button', { name: 'More', exact: true }).click()
    const menu = page.getByRole('menu').first()
    await expect(menu).toBeVisible()
    const surface = await menu.evaluate((el) => {
      // This Menu borrows Popover's padded panel; the menu role is its unpadded level.
      const panel = el.closest('[data-slot="popover-popup"]')!
      const style = getComputedStyle(panel)
      return {
        width: panel.getBoundingClientRect().width,
        padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
        radius: style.borderTopLeftRadius,
      }
    })
    expect(surface.width).toBeGreaterThanOrEqual(FRAME.menu.min)
    expect(surface.padding).toEqual(Array(4).fill(`${FRAME.menu.padding}px`))
    expect(surface.radius).toBe(`${FRAME.menu.radius}px`)
    const rows = await menu.locator('[role^="menuitem"]').evaluateAll((items) => items.map((item) => {
      const style = getComputedStyle(item)
      return { minHeight: style.minHeight, radius: style.borderTopLeftRadius }
    }))
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.minHeight).toBe(`${FRAME.menu.rowHeight}px`)
      expect(row.radius).toBe(`${FRAME.menu.rowRadius}px`)
    }
  })

  for (const width of [1440, 720]) {
    test(`the Findings page keeps the reading measure at ${width} in ${theme}`, async ({ page }) => {
      await openFrame(page, 'frame-wall=team', theme, width)
      await selectFrameTab(page, 'findings')
      const column = page.locator('[data-slot="page"][data-width="reading"]').first()
      await expect(column).toBeVisible()
      const measured = await column.evaluate((el) => {
        const style = getComputedStyle(el)
        const box = el.getBoundingClientRect()
        const parent = el.parentElement!.getBoundingClientRect()
        const left = box.left + parseFloat(style.paddingLeft)
        return {
          gutters: [parseFloat(style.paddingLeft), parseFloat(style.paddingRight)],
          measure: box.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
          margins: [box.left - parent.left, parent.right - box.right],
          edges: [...el.children]
            .filter((child) => (child as HTMLElement).offsetParent !== null)
            .map((child) => Math.round(child.getBoundingClientRect().left - left)),
        }
      })
      expect(measured.gutters).toEqual([FRAME.page.gutter, FRAME.page.gutter])
      expect(measured.measure).toBeLessThanOrEqual(FRAME.page.reading)
      expect(Math.abs(measured.margins[0] - measured.margins[1])).toBeLessThanOrEqual(1)
      expect(measured.edges, 'every block starts at the column edge').toEqual(measured.edges.map(() => 0))
    })
  }
}

for (const theme of WALL_THEMES) {
  test(`B1 TopBar is one contract-height row in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=topbar', theme)
    const rows = page.locator('[data-slot="top-bar"]')
    await expect(rows.first()).toBeVisible()
    for (const box of await rows.evaluateAll(nodes => nodes.map(node => node.closest('header')!.getBoundingClientRect().height))) {
      expect(Math.round(box)).toBe(FRAME.bar.height)
    }
    const divider = rows.first().locator('[data-slot="bar-divider"]')
    expect((await divider.boundingBox())!.height).toBe(FRAME.bar.dividerHeight)
    expect((await divider.boundingBox())!.width).toBe(await divider.evaluate(node => Number.parseFloat(getComputedStyle(node).getPropertyValue('--hd-border-width'))))
    await expect(rows.first().locator('[data-topbar="more"]')).toBeVisible()
    await expect(rows.first().locator('[data-team-page="findings"]')).toBeVisible()
  })
}

for (const theme of WALL_THEMES) {
  test(`B1 probe exercises folded tabs and restores them in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=topbar', theme, 720)
    const row = page.locator('[data-slot="top-bar"]')
    await expect(row).toHaveAttribute('data-fold', '2')
    expect((await row.locator('[data-topbar-title]').boundingBox())!.width).toBeGreaterThanOrEqual(FRAME.bar.titleMin)
    await selectFrameTab(page, 'run')
    await expect(page.getByTitle('Destination views', { exact: true })).toContainText('Run')
    await expect(row).toHaveAttribute('data-fold', '2')
    await page.getByTitle('Destination views', { exact: true }).focus()
    await page.setViewportSize({ width: 1440, height: 900 })
    await expect(row).toHaveAttribute('data-fold', '0')
    await expect(row.getByRole('tab', { name: 'Run', exact: true })).toHaveAttribute('data-active', '')
    await expect(row.getByRole('tab', { name: 'Run', exact: true })).toBeFocused()
    await page.setViewportSize({ width: 720, height: 900 })
    await expect(row).toHaveAttribute('data-fold', '2')
    await expect(page.getByTitle('Destination views', { exact: true })).toBeFocused()
  })
}

for (const theme of WALL_THEMES) {
  test(`B1 catalogue preserves words for a verb without an icon in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/design.html?view=top-bar&theme=${theme}`)
    const rows = page.locator('[data-slot="top-bar"]')
    await expect(rows).toHaveCount(4)
    const narrow = rows.nth(2)
    await expect(narrow).toHaveAttribute('data-fold', '2')
    await expect(narrow.getByRole('button', { name: 'Decide this run', exact: true })).toHaveText('Decide this run')
    expect((await narrow.locator('[data-topbar-title]').boundingBox())!.width).toBeGreaterThanOrEqual(FRAME.bar.titleMin)
    await expect(rows.nth(3).getByRole('button', { name: 'View', exact: true })).toBeDisabled()
    await page.screenshot({ path: `output/frame-wall/B1-catalogue-${theme}.png`, fullPage: true })
  })
}

for (const theme of WALL_THEMES) {
  test(`B2 legacy tools open on the right without changing work in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation&frame-tool=tasks', theme)
    const main = page.locator('[data-slot="workbench-main"]')
    await expect(main).toBeVisible()
    await expect(page.locator('[data-slot="inspector-panel"]')).toBeVisible()
    expect((await main.boundingBox())!.width).toBeGreaterThanOrEqual(FRAME.main.min)
  })
}
