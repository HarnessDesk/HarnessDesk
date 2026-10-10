import { expect, test, type Page } from '@playwright/test'
import { FRAME, FRAME_TOKENS } from '../../packages/ui/src/design/frame'
import { WALL_THEMES } from './frame-wall-destinations'

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
      await page.locator('[data-team-page="findings"]').first().click()
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

import type { Locator } from '@playwright/test'

const menuMetrics = async (surface: Locator) => surface.evaluate((el) => {
  const css = getComputedStyle(el)
  const box = el.getBoundingClientRect()
  return { width: box.width, radius: css.borderTopLeftRadius, pad: [css.paddingTop, css.paddingRight, css.paddingBottom, css.paddingLeft], border: css.borderTopWidth, overflow: el.scrollWidth > el.clientWidth || [...el.querySelectorAll<HTMLElement>('[data-menu-label],[data-menu-hint],[data-menu-meter],[data-info-note]')].some(node => node.scrollWidth > node.clientWidth) }
})
const rowMetrics = async (surface: Locator) => surface.locator('[data-menu-row]').evaluateAll((els) => els.map(el => {
  const css = getComputedStyle(el)
  const label = el.querySelector('[data-menu-label]')!
  const hint = el.querySelector('[data-menu-hint]')
  const icon = el.querySelector('[data-menu-icon]')
  return { height: el.getBoundingClientRect().height, radius: css.borderTopLeftRadius, padTop: parseFloat(css.paddingTop), padBottom: parseFloat(css.paddingBottom), labelHeight: label.getBoundingClientRect().height, labelSize: getComputedStyle(label).fontSize, labelLine: getComputedStyle(label).lineHeight, labelWeight: getComputedStyle(label).fontWeight, font: getComputedStyle(label).fontFamily, smoothing: getComputedStyle(label).getPropertyValue('-webkit-font-smoothing'), hintHeight: hint?.getBoundingClientRect().height ?? 0, meterHeight: el.querySelector('[data-menu-meter]')?.getBoundingClientRect().height ?? 0, hintSize: hint ? getComputedStyle(hint).fontSize : null, hintLine: hint ? getComputedStyle(hint).lineHeight : null, icon: Boolean(icon), iconWidth: icon?.getBoundingClientRect().width ?? 0, gap: parseFloat(css.columnGap), iconTop: icon?.getBoundingClientRect().top ?? 0, labelTop: label.getBoundingClientRect().top }
}))
const expectMenuGeometry = async (surface: Locator) => {
  const m = await menuMetrics(surface)
  expect(m.width).toBeGreaterThanOrEqual(FRAME_MENU.min)
  expect(m.width).toBeLessThanOrEqual(FRAME_MENU.max)
  expect(m.pad).toEqual(Array(4).fill(`${FRAME_MENU.padding}px`))
  expect(m.radius).toBe(`${FRAME_MENU.radius}px`)
  expect(m.border).toBe('0px')
  expect(m.overflow).toBe(false)
  const rows = await rowMetrics(surface)
  expect(rows.length).toBeGreaterThan(0)
  expect(new Set(rows.map(row => row.icon)).size, 'whole-level icon policy').toBe(1)
  for (const row of rows) {
    expect(row.radius).toBe(`${FRAME_MENU.rowRadius}px`)
    expect(row.labelSize).toBe(`${FRAME_MENU.labelSize}px`)
    expect(row.labelLine).toBe(`${FRAME_MENU.labelLine}px`)
    expect(row.labelWeight).toBe('400')
    expect(row.font).toContain('Geist')
    expect(row.smoothing).toBe('auto')
    expect(row.labelHeight % FRAME_MENU.labelLine).toBe(0)
    if (row.hintHeight === 0 && row.meterHeight === 0 && row.labelHeight === FRAME_MENU.labelLine) expect(row.height).toBe(FRAME_MENU.rowHeight)
    if (row.hintHeight > 0 || row.meterHeight > 0 || row.labelHeight > FRAME_MENU.labelLine) {
      expect(row.padTop).toBe(FRAME_MENU.earnedPad)
      expect(row.padBottom).toBe(FRAME_MENU.earnedPad)
      expect(row.height).toBe(row.labelHeight + row.hintHeight + row.meterHeight + (row.meterHeight ? FRAME_MENU.padding : 0) + 2 * FRAME_MENU.earnedPad)
      if (row.hintHeight > 0) {
        expect(row.hintSize).toBe(`${FRAME_MENU.hintSize}px`)
        expect(row.hintLine).toBe(`${FRAME_MENU.hintLine}px`)
      }
    }
    if (row.icon) {
      expect(row.iconWidth).toBe(FRAME_MENU.icon)
      expect(row.gap).toBe(FRAME_MENU.gap)
      expect(row.iconTop).toBe(row.labelTop)
    }
  }
  const anatomy = await surface.evaluate(el => {
    const secondary = getComputedStyle(el).getPropertyValue('--hd-secondary-foreground').trim()
    const probe = document.createElement('span'); probe.style.color = secondary; el.append(probe)
    const secondaryColor = getComputedStyle(probe).color; probe.remove()
    return {
      groups: [...el.querySelectorAll('[data-menu-group]')].map(node => { const css = getComputedStyle(node); return { size: css.fontSize, weight: css.fontWeight, color: css.color } }),
      hints: [...el.querySelectorAll('[data-menu-hint]')].map(node => getComputedStyle(node).color),
      separators: [...el.querySelectorAll('[data-menu-separator]')].map(node => { const css = getComputedStyle(node); return { height: node.getBoundingClientRect().height, margins: [css.marginTop, css.marginRight, css.marginBottom, css.marginLeft] } }),
      secondaryColor,
    }
  })
  for (const group of anatomy.groups) expect(group).toEqual({ size: `${FRAME_MENU.groupSize}px`, weight: String(FRAME_MENU.groupWeight), color: anatomy.secondaryColor })
  for (const color of anatomy.hints) expect(color).toBe(anatomy.secondaryColor)
  for (const separator of anatomy.separators) expect(separator).toEqual({ height: FRAME_MENU.separator, margins: Array(4).fill(`${FRAME_MENU.padding}px`) })
  const edge = await surface.evaluate(el => {
    const box = el.getBoundingClientRect()
    const labels = [...el.querySelectorAll<HTMLElement>('[data-menu-label],[data-menu-group],[data-menu-note],[data-menu-footer],[data-menu-search]')]
    return labels.filter(n => n.offsetParent !== null).map(n => {
      const css = getComputedStyle(n)
      return n.getBoundingClientRect().left + parseFloat(css.paddingLeft) - box.left
    })
  })
  const icons = rows[0]!.icon
  const expected = FRAME_MENU.padding + FRAME_MENU.rowInset + (icons ? FRAME_MENU.icon + FRAME_MENU.gap : 0)
  for (const x of edge) expect(x).toBe(expected)
}
for (const theme of WALL_THEMES) for (const width of [1440, 1100, 720]) for (const mode of ['icons', 'none']) {
  test(`C1 menu ${mode} at ${width} in ${theme}`, async ({ page }) => {
    await openFrame(page, `frame-wall=conversation&popup=menu-${mode}`, theme, width)
    await page.getByRole('button', { name: 'Frame menu', exact: true }).click()
    const surface = page.locator('[data-popup-kind="menu"]:visible').last()
    await expect(surface).toBeVisible()
    await expectMenuGeometry(surface)
    const hint = surface.locator('[data-menu-hint]').filter({ hasText: 'Files are left as they are.' })
    await expect(hint).toBeVisible()
    expect(await hint.evaluate(el => getComputedStyle(el).whiteSpace)).toBe('normal')
    expect((await surface.getByRole('menuitem', { name: /^Keep the checkout/ }).boundingBox())!.height).toBe(62)
    expect((await surface.getByRole('menuitem', { name: /^Undo the last turn/ }).boundingBox())!.height).toBe(46)
  })
}

import { FRAME_MENU } from '../../packages/ui/src/design/frame'
