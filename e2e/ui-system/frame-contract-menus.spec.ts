import { applyLeftColumnActions } from './left-column-actions'
import { expect, test } from '@playwright/test'
import { WALL_THEMES } from './frame-wall-destinations'
import { openFrame, contrastRatio, expectMenuGeometry, expectRefusedMenuRow } from './frame-contract-helpers'


// Contract runs measure the preview; the final wall owns images and recordings.
test.use({ screenshot: 'off', trace: 'off', video: 'off' })


test('R10.28 Projects keeps submenu values and chevrons inside the popup', async ({ page }) => {
  await openFrame(page, 'frame-wall=left-work', 'light', 1100)
  await applyLeftColumnActions(page, { leftOpen: true })
  await page.getByTitle('How this list is shown', { exact: true }).click()
  const menu = page.locator('[data-popup-kind="menu"]:visible').last()
  await expectMenuGeometry(menu)
  for (const value of ['Recency', 'All agents']) {
    const row = menu.locator('[data-menu-row]').filter({ hasText: value }).first()
    const trailing = row.locator('[data-menu-trailing]')
    const geometry = await trailing.evaluate((node, wanted) => {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
      let text: Text | null = null
      while (walker.nextNode()) if (walker.currentNode.textContent?.trim() === wanted) text = walker.currentNode as Text
      if (!text) throw new Error(`missing trailing value ${wanted}`)
      const range = document.createRange()
      range.selectNodeContents(text)
      const ink = range.getBoundingClientRect()
      const box = node.getBoundingClientRect()
      return { inkLeft: ink.left, inkRight: ink.right, left: box.left, right: box.right, scroll: node.scrollWidth, client: node.clientWidth }
    }, value)
    expect(geometry.inkLeft, `${value} leading edge is visible`).toBeGreaterThanOrEqual(geometry.left - 0.5)
    expect(geometry.inkRight, `${value} trailing edge is visible`).toBeLessThanOrEqual(geometry.right + 0.5)
    expect(geometry.scroll, `${value} and its chevron fit the assigned slot`).toBeLessThanOrEqual(geometry.client)
  }
})

test('shared overlay scrollbar stays hidden at rest and appears while scrolling', async ({ page }) => {
  await openFrame(page, 'frame-wall=conversation', 'light')
  await page.evaluate(() => {
    const region = document.createElement('div')
    region.dataset.contractScrollbar = ''
    region.style.cssText = 'position:fixed;left:0;top:0;width:80px;height:40px;overflow-y:auto'
    const content = document.createElement('div')
    content.style.height = '240px'
    region.append(content)
    document.body.append(region)
  })
  const scroller = page.locator('[data-contract-scrollbar]')

  const thumbColor = () => scroller.evaluate(node => getComputedStyle(node, '::-webkit-scrollbar-thumb').backgroundColor)
  const resting = await thumbColor()
  expect(resting).toBe('rgba(0, 0, 0, 0)')

  await scroller.evaluate(node => { node.scrollTop = 32 })
  await expect(scroller).toHaveAttribute('data-scrolling', '')
  expect(await thumbColor()).not.toBe(resting)

  await expect(scroller).not.toHaveAttribute('data-scrolling', '', { timeout: 2000 })
  expect(await thumbColor()).toBe(resting)
})

test('S17 popup menus fit their rows and keep one inset and one label per row', async ({ page }) => {
  await openFrame(page, 'frame-wall=conversation&popup=menu-icons', 'light', 1100)
  await page.getByRole('button', { name: 'Frame menu', exact: true }).click()
  await expectMenuGeometry(page.locator('[data-popup-kind="menu"]:visible').last())
})

test('S17 New session menu uses a branch for worktrees and the neutral open plate', async ({ page }) => {
  await openFrame(page, 'frame-wall=conversation', 'light', 1100)
  await applyLeftColumnActions(page, { leftOpen: true, leftPopup: 'start' })
  const menu = page.locator('[data-popup-kind]:visible').last()
  await expectMenuGeometry(menu)
  const sessionIcon = await menu.getByRole('menuitem', { name: /^New session/ }).locator('[data-menu-icon] svg').evaluate(node => node.outerHTML)
  const worktreeIcon = await menu.getByRole('menuitem', { name: /^New worktree…/ }).locator('[data-menu-icon] svg').evaluate(node => node.outerHTML)
  expect(worktreeIcon).not.toBe(sessionIcon)
  const trigger = page.getByRole('button', { name: 'More ways to start', exact: true })
  const colors = await trigger.evaluate(node => {
    const hover = document.createElement('span'); hover.style.color = 'var(--hd-hover)'; document.body.append(hover)
    const expected = getComputedStyle(hover).color; hover.remove()
    return { actual: getComputedStyle(node).backgroundColor, expected }
  })
  expect(colors.actual).toBe(colors.expected)
})

test('S17 Projects keeps Show agents values on one line', async ({ page }) => {
  await openFrame(page, 'frame-wall=left-work', 'light', 1100)
  await applyLeftColumnActions(page, { leftOpen: true })
  await page.getByTitle('How this list is shown', { exact: true }).click()
  const menu = page.locator('[data-popup-kind="menu"]:visible').last()
  await expectMenuGeometry(menu)
  const show = menu.locator('[data-menu-row]').filter({ hasText: 'Show agents' })
  expect(await show.locator('[data-menu-trailing]').evaluate(node => getComputedStyle(node).whiteSpace)).toBe('nowrap')
})

test('S17 disabled destructive session actions use the shared disabled ink', async ({ page }) => {
  await openFrame(page, 'frame-wall=left-work', 'light', 1100)
  await applyLeftColumnActions(page, { leftOpen: true, leftPopup: 'session' })
  const menu = page.locator('[data-popup-kind]:visible').last()
  await expectMenuGeometry(menu)
  const remove = menu.locator('[data-menu-row]').filter({ hasText: 'Delete everywhere…' })
  await expect(remove).toHaveAttribute('data-danger', '')
  const colors = await remove.evaluate(el => {
    const probe = document.createElement('span'); probe.style.color = 'var(--hd-disabled-foreground)'; el.append(probe)
    const disabled = getComputedStyle(probe).color; probe.remove()
    return { disabled, row: getComputedStyle(el).color, icon: getComputedStyle(el.querySelector('[data-menu-icon]')!).color,
      label: getComputedStyle(el.querySelector('[data-menu-label]')!).color, trailing: getComputedStyle(el.querySelector('[data-menu-trailing]')!).color }
  })
  expect(colors.row).toBe(colors.disabled)
  expect(colors.icon).toBe(colors.disabled)
  expect(colors.label).toBe(colors.disabled)
  expect(colors.trailing).toBe(colors.disabled)
})

test('S17 conversation More keeps one Terminal row with its shortcut', async ({ page }) => {
  await openFrame(page, 'frame-wall=conversation&frame-conversation-actions=1', 'light', 1100)
  await page.locator('[data-slot="top-bar"]:visible').getByRole('button', { name: 'More', exact: true }).click()
  const menu = page.locator('[data-popup-kind="menu"]:visible').last()
  await expectMenuGeometry(menu)
  const terminals = menu.locator('[data-menu-row]').filter({ hasText: /^Terminal/ })
  await expect(terminals).toHaveCount(1)
  expect((await terminals.locator('[data-menu-trailing]').innerText()).trim()).not.toBe('')
})
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

for (const theme of WALL_THEMES) {
  test(`B11a reconcile disabled start menu retains icons and readable reasons in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation', theme)
    await page.locator('[data-left-column]').getByRole('button', { name: 'More ways to start', exact: true }).click()
    const row = page.getByRole('menuitem', { name: /New worktree/ })
    await expect(row).toBeDisabled()
    await expect(row.locator('[data-menu-icon]')).toHaveCount(1)
    await expectRefusedMenuRow(row)
  })
}

for (const theme of WALL_THEMES) {
  test(`S22 disabled popup rows share one ink and keep refusal reasons readable in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation&popup=disabled-rows', theme)
    await page.getByRole('button', { name: 'Frame disabled menu', exact: true }).click()
    const menu = page.locator('[data-popup-kind="menu"]:visible').last()
    await expectMenuGeometry(menu)
    const disabledRows = menu.locator('[data-menu-row]:is([data-disabled],[aria-disabled="true"],:disabled)')
    await expect(disabledRows).toHaveCount(2)
    const enabledColor = await menu.locator('[data-menu-label]').filter({ hasText: 'Open workspace' }).evaluate(node => getComputedStyle(node).color)
    const menuTokens = await menu.evaluate(node => {
      const token = (name: string) => {
        const probe = document.createElement('span'); probe.style.color = `var(${name})`; node.append(probe)
        const color = getComputedStyle(probe).color; probe.remove(); return color
      }
      return { disabled: token('--hd-disabled-foreground'), secondary: token('--hd-secondary-foreground'), background: getComputedStyle(node).backgroundColor }
    })
    const rows = await disabledRows.evaluateAll(nodes => nodes.map(node => {
      const color = (selector: string) => getComputedStyle(node.querySelector(selector)!).color
      return {
        label: color('[data-menu-label]'), icon: color('[data-menu-icon]'), trailing: color('[data-menu-trailing]'),
        reason: color('[data-menu-hint]'), reasonExists: node.querySelector('[data-menu-hint]') !== null,
      }
    }))
    const enabledContrast = contrastRatio(enabledColor, menuTokens.background)
    for (const [index, row] of rows.entries()) {
      expect(row.label).toBe(menuTokens.disabled)
      expect(row.icon).toBe(row.label)
      expect(row.trailing).toBe(row.label)
      expect(row.reasonExists).toBe(true)
      expect(row.reason).toBe(menuTokens.secondary)
      const disabledContrast = contrastRatio(row.label, menuTokens.background)
      const reasonContrast = contrastRatio(row.reason, menuTokens.background)
      expect(disabledContrast).toBeGreaterThanOrEqual(3)
      expect(enabledContrast / disabledContrast).toBeGreaterThanOrEqual(1.8)
      expect(reasonContrast).toBeGreaterThanOrEqual(4.5)
      if (index === 0) console.log(`S22 ${theme}: enabled ${enabledContrast.toFixed(2)}:1, disabled ${disabledContrast.toFixed(2)}:1, reason ${reasonContrast.toFixed(2)}:1`)
    }

    const refusedMenuItem = disabledRows.first()
    await refusedMenuItem.hover({ force: true })
    const plates = await refusedMenuItem.evaluate(node => {
      const hover = getComputedStyle(node).backgroundColor
      for (const state of ['data-highlighted', 'data-selected', 'data-current']) node.setAttribute(state, '')
      return { hover, highlighted: getComputedStyle(node).backgroundColor }
    })
    expect(plates.hover).toBe('rgba(0, 0, 0, 0)')
    expect(plates.highlighted).toBe('rgba(0, 0, 0, 0)')

    await openFrame(page, 'frame-wall=conversation&popup=suggestions', theme)
    const suggestions = page.getByRole('listbox')
    const archivedOption = suggestions.getByRole('option', { name: /Archived conversation/ })
    await expect(archivedOption).toHaveAttribute('aria-disabled', 'true')
    expect(await archivedOption.locator('[data-menu-label]').evaluate(node => getComputedStyle(node).color)).toBe(menuTokens.disabled)
    expect(await archivedOption.locator('[data-menu-hint]').evaluate(node => getComputedStyle(node).color)).toBe(menuTokens.secondary)

    await openFrame(page, 'frame-wall=conversation&popup=select-disabled', theme)
    await page.getByRole('combobox', { name: 'Frame Select with disabled option' }).click()
    const archivedSelect = page.getByRole('option', { name: 'Archived Agent' })
    await expect(archivedSelect).toHaveAttribute('data-disabled', '')
    expect(await archivedSelect.locator('[data-menu-label]').evaluate(node => getComputedStyle(node).color)).toBe(menuTokens.disabled)
    expect(await archivedSelect.locator('[data-menu-hint]').evaluate(node => getComputedStyle(node).color)).toBe(menuTokens.secondary)

    await openFrame(page, 'frame-wall=conversation&popup=palette-result', theme)
    const palette = page.locator('[data-popup-kind="menu"]')
    const disabledPaletteRow = palette.locator('[data-palette-result]').last()
    await expect(disabledPaletteRow).toBeDisabled()
    const paletteInk = await disabledPaletteRow.evaluate(node => ({
      row: getComputedStyle(node).color,
      icon: getComputedStyle(node.querySelector('[data-palette-result-icon]')!).color,
      label: getComputedStyle(node.querySelector('[data-palette-result-title]')!).color,
      trailing: getComputedStyle(node.querySelector('[data-palette-result-meta]')!).color,
      opacity: getComputedStyle(node).opacity,
    }))
    expect(paletteInk.row).toBe(menuTokens.disabled)
    expect(paletteInk.icon).toBe(menuTokens.disabled)
    expect(paletteInk.label).toBe(menuTokens.disabled)
    expect(paletteInk.trailing).toBe(menuTokens.disabled)
    expect(paletteInk.opacity).toBe('1')
    await disabledPaletteRow.hover({ force: true })
    expect(await disabledPaletteRow.evaluate(node => getComputedStyle(node).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
  })
}

for (const theme of WALL_THEMES) for (const width of [1440, 720]) {
  test(`C3 refused rows retain disabled ink and readable reasons at ${width} in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation', theme, width)
    await applyLeftColumnActions(page, { leftOpen: true, leftPopup: 'start' })
    const worktree = page.getByRole('menuitem', { name: /^New worktree/ })
    await expect(worktree).toHaveAttribute('aria-disabled', 'true')
    await expectRefusedMenuRow(worktree)
    await page.keyboard.press('Escape')
    if (width === 720) await page.getByRole('dialog', { name: 'Sidebar', exact: true }).getByRole('button', { name: 'Hide sidebar', exact: true }).click()
    await page.getByRole('button', { name: 'Add', exact: true }).first().click()
    const images = page.getByRole('menuitem', { name: /^Attach images/ })
    await expect(images).toHaveAttribute('aria-disabled', 'true')
    await expectRefusedMenuRow(images)
  })
}

for (const theme of WALL_THEMES) for (const width of [1440, 1100, 720]) for (const mode of ['none', 'icons']) {
  test(`C3 dropdown ${mode} at ${width} in ${theme}`, async ({ page }) => {
    await openFrame(page, `frame-wall=conversation&popup=dropdown-${mode}`, theme, width)
    await page.getByRole('button', { name: 'Frame dropdown', exact: true }).click()
    const menu = page.locator('[data-popup-kind="menu"]:visible').last()
    await expect(menu).not.toHaveAttribute('data-starting-style', '')
    await menu.evaluate(async node => {
      await Promise.all(node.getAnimations().map(animation => animation.finished.catch(() => {})))
    })
    expect(await menu.evaluate(node => getComputedStyle(node).scale)).toMatch(/^(?:none|1)$/)
    await expectMenuGeometry(menu)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: 'Frame dropdown', exact: true })).toBeFocused()
  })
}
for (const theme of WALL_THEMES) {
  test(`C3 actual dynamic model level never mixes icons in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation', theme)
    const trigger = page.getByTitle(/Model and reasoning/).first()
    await trigger.click()
    const surface = page.locator('[data-popup-kind="wide-menu"]:visible').last()
    await expectMenuGeometry(surface)
    expect(await surface.locator('[data-menu-icon]').count()).toBe(0)
  })
}
