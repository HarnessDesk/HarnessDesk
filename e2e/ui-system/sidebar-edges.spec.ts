import { expect, test, type Locator } from '@playwright/test'

const intersection = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

const box = async (locator: Locator) => {
  const value = await locator.boundingBox()
  expect(value, `expected a visible box for ${await locator.getAttribute('data-slot')}`).not.toBeNull()
  return value!
}

test('sidebar state marks yield to actions and every trailing control stays on the end rail', async ({ page }) => {
  await page.goto('/design.html?view=sidebar')
  const example = page.locator('[data-catalog-example="sidebar"]')
  const anatomy = example.locator('[data-catalog-label-case="badge"]')
  const list = anatomy.locator('xpath=ancestor::ul[@data-slot="sidebar-menu"]')
  const sidebars = example.locator('[class*="sidebar_"]')
  const state = anatomy.locator('[data-slot="sidebar-menu-state"]')
  const action = anatomy.locator('[data-slot="sidebar-menu-action"]')
  const nestedExample = example.locator('[aria-label="Nested row end rail"]')
  const sidebar = sidebars.first()

  for (const width of [200, 260, 320]) {
    await list.evaluate((node, next) => { (node as HTMLElement).style.width = `${next}px` }, width)
    await nestedExample.evaluate((node, next) => { (node as HTMLElement).style.width = `${next}px` }, width)
    for (let index = 0; index < await sidebars.count(); index += 1) {
      await sidebars.nth(index).evaluate((node, next) => { (node as HTMLElement).style.width = `${next}px` }, width)
    }
    for (const focus of [false, true]) {
      if (focus) await action.focus()
      else await anatomy.hover()
      await expect(action).toBeVisible()
      const stateBox = await box(state)
      const actionBox = await box(action)
      expect(intersection(stateBox, actionBox), `state mark and action overlap at ${width}px (${focus ? 'focus' : 'hover'})`).toBe(false)
      await expect(anatomy.locator('[data-sidebar-menu-state-full]')).toBeHidden()
      await expect(anatomy.locator('[data-sidebar-menu-state-compact]')).toBeVisible()
      await expect(state).toHaveAttribute('title', 'Working')
      await expect(state).toHaveAttribute('aria-label', 'Working')
      const rail = await box(sidebar)
      expect(actionBox.x, `row action begins outside sidebar at ${width}px`).toBeGreaterThanOrEqual(rail.x)
      expect(actionBox.x + actionBox.width, `row action spills past sidebar at ${width}px`).toBeLessThanOrEqual(rail.x + rail.width + 1)
      await anatomy.locator('[data-slot="sidebar-menu-button"]').focus()
      expect((await box(action)).x + (await box(action)).width).toBeLessThanOrEqual(rail.x + rail.width + 1)
    }
    for (let index = 0; index < await sidebars.count(); index += 1) {
      const column = sidebars.nth(index)
      const rail = await box(column)
      const plus = await box(column.getByRole('button', { name: 'Open a project folder' }))
      expect(plus.x + plus.width, `project add action spills past sidebar at ${width}px`).toBeLessThanOrEqual(rail.x + rail.width + 1)
      const rowActions = column.locator('[data-slot="sidebar-menu-action"]')
      for (let row = 0; row < await rowActions.count(); row += 1) {
        const rowAction = rowActions.nth(row)
        const trailing = await box(rowAction)
        expect(trailing.x, `row action begins outside sidebar at ${width}px`).toBeGreaterThanOrEqual(rail.x)
        expect(trailing.x + trailing.width, `row action spills past sidebar at ${width}px`).toBeLessThanOrEqual(rail.x + rail.width + 1)
        const parentActionBox = await rowAction.evaluate((node) => {
          const nested = node.closest('[data-nested="true"]')
          const parent = nested?.parentElement
          const action = parent?.querySelector<HTMLElement>(':scope > [data-slot="sidebar-menu-action"]')
          if (!action) return null
          const rect = action.getBoundingClientRect()
          return { left: rect.left, right: rect.right }
        })
        if (parentActionBox) {
          expect(Math.abs(trailing.x - parentActionBox.left), `nested action start misses parent end rail at ${width}px`).toBeLessThanOrEqual(1)
          expect(Math.abs(trailing.x + trailing.width - parentActionBox.right), `nested action end misses parent end rail at ${width}px`).toBeLessThanOrEqual(1)
        }
      }
      const nestedAction = nestedExample.getByRole('button', { name: 'Untitled session actions' })
      const parentAction = nestedExample.getByRole('button', { name: 'Release room actions' })
      const childRail = await box(nestedAction)
      const parentRail = await box(parentAction)
      expect(Math.abs(childRail.x - parentRail.x), `nested specimen misses its parent rail at ${width}px`).toBeLessThanOrEqual(1)
      expect(Math.abs(childRail.x + childRail.width - parentRail.x - parentRail.width), `nested specimen misses its parent rail at ${width}px`).toBeLessThanOrEqual(1)
      const states = column.locator('[data-slot="sidebar-menu-state"]')
      for (let stateIndex = 0; stateIndex < await states.count(); stateIndex += 1) {
        const mark = states.nth(stateIndex)
        const row = mark.locator('xpath=ancestor::li[@data-slot="sidebar-menu-item"][1]')
        const trailing = row.locator('[data-slot="sidebar-menu-action"]')
        if (await trailing.count() === 0) continue
        await row.hover()
        await expect(trailing).toBeVisible()
        expect(intersection(await box(mark), await box(trailing)), `state/action overlap on catalogue state at ${width}px`).toBe(false)
        await row.locator('[data-slot="sidebar-menu-button"]').first().focus()
        expect(intersection(await box(mark), await box(trailing)), `state/action overlap on focused catalogue state at ${width}px`).toBe(false)
      }
    }
  }
})

test('worktree and missing-folder glyphs use the end rail without moving the label', async ({ page }, testInfo) => {
  await page.goto('/design.html?view=sidebar')
  const example = page.locator('[data-catalog-example="sidebar"]')
  const sidebars = example.locator('[class*="sidebar_"]')
  const sidebar = example.locator('[data-region="sidebar-header"]').locator('xpath=ancestor::div[contains(@class,"sidebar_")][1]')
  const frame = sidebar.locator('xpath=parent::*')
  const count = sidebar.locator('[aria-label="Main sections"] [data-slot="sidebar-menu-badge"]').first()
  const measurements: Array<Record<string, unknown>> = []

  for (const width of [200, 260, 320]) {
    await frame.evaluate((node, next) => { (node as HTMLElement).style.width = `${next}px` }, width)
    for (let index = 0; index < await sidebars.count(); index += 1) {
      await sidebars.nth(index).evaluate((node) => { (node as HTMLElement).style.width = '100%' })
    }

    for (const label of ['Worktree feat/worktrees', 'Folder is gone — settings-audit-77aa']) {
      const glyph = sidebar.locator(`[data-slot="sidebar-menu-badge"][aria-label="${label}"]`)
      await expect(glyph).toBeVisible()
      const row = glyph.locator('xpath=ancestor::li[@data-slot="sidebar-menu-item"][1]')
      const button = row.locator('[data-slot="sidebar-menu-button"]')
      const action = row.locator('[data-slot="sidebar-menu-action"]')
      const labelBox = row.locator('[data-slot="sidebar-menu-label"]')
      await row.scrollIntoViewIfNeeded()
      const restGlyph = await box(glyph)
      const restLabel = await box(labelBox)
      const sidebarBox = await box(sidebar)
      const countBox = await box(count)
      const restInset = sidebarBox.x + sidebarBox.width - (restGlyph.x + restGlyph.width)

      await row.hover()
      await expect(action).toBeVisible()
      await action.hover()
      const tooltip = page.locator('[data-slot="tooltip-content"]')
      await expect(tooltip).toBeVisible()
      await expect(tooltip).toContainText('Actions for')
      const actionBox = await box(action)
      const hoverGlyph = await box(glyph)
      const hoverLabel = await box(labelBox)
      const tooltipBox = await box(tooltip)
      const viewport = page.viewportSize()!
      const plainBox = (value: NonNullable<Awaited<ReturnType<typeof box>>>) => ({ x: value.x, y: value.y, width: value.width, height: value.height })

      expect(Math.abs(restInset - 20), `glyph slot should sit on the 20px column inset at ${width}px`).toBeLessThanOrEqual(1)
      expect(Math.abs(restGlyph.x + restGlyph.width - (countBox.x + countBox.width)), `glyph misses the count rail at ${width}px`).toBeLessThanOrEqual(1)
      expect(actionBox.x, `action begins outside sidebar at ${width}px`).toBeGreaterThanOrEqual(sidebarBox.x)
      expect(actionBox.x + actionBox.width, `action exceeds sidebar inset at ${width}px`).toBeLessThanOrEqual(sidebarBox.x + sidebarBox.width - restInset + 1)
      expect(Math.abs(restGlyph.x - hoverGlyph.x - 24), `glyph should shift by one action width at ${width}px`).toBeLessThanOrEqual(1)
      expect(hoverGlyph.x + hoverGlyph.width, `glyph should stop one action-width left of the rail at ${width}px`).toBeLessThanOrEqual(actionBox.x + 1)
      expect(hoverLabel).toEqual(restLabel)
      expect(tooltipBox.x, `tooltip begins outside window at ${width}px`).toBeGreaterThanOrEqual(0)
      expect(tooltipBox.x + tooltipBox.width, `tooltip exceeds window at ${width}px`).toBeLessThanOrEqual(viewport.width)

      measurements.push({
        width,
        glyph: label,
        restRightGap: restInset,
        countRailDelta: restGlyph.x + restGlyph.width - (countBox.x + countBox.width),
        hoverAction: plainBox(actionBox),
        tooltip: plainBox(tooltipBox),
        labelAtRest: plainBox(restLabel),
        labelOnHover: plainBox(hoverLabel),
      })

      await button.focus()
      expect(await box(labelBox)).toEqual(restLabel)
      expect(await box(action)).toEqual(actionBox)
      await action.click()
      await expect(action).toHaveAttribute('data-state', 'open')
      const openGlyph = await box(glyph)
      expect(Math.abs(restGlyph.x - openGlyph.x - 24), `glyph should keep the action-width offset while its menu is open at ${width}px`).toBeLessThanOrEqual(1)
      expect(await box(labelBox)).toEqual(restLabel)
      await page.keyboard.press('Escape')
    }
  }
  await testInfo.attach('sidebar-trailing-glyph-measurements.json', {
    body: JSON.stringify(measurements, null, 2),
    contentType: 'application/json',
  })
  console.info('SIDEBAR_TRAILING_GLYPH_MEASUREMENTS', JSON.stringify(measurements))
})

test('sidebar resize highlight is idle-only on hover, without a stuck seam state', async ({ page }) => {
  await page.goto('/design.html?view=panels')
  const seam = page.getByRole('separator', { name: 'Resize the sidebar' })
  await expect(seam).toBeVisible()
  const idle = await seam.evaluate((node) => getComputedStyle(node).backgroundColor)
  expect(idle, 'the seam must not paint a full-height highlight while idle').toBe('rgba(0, 0, 0, 0)')
  await seam.hover()
  const hovered = await seam.evaluate((node) => getComputedStyle(node).backgroundColor)
  expect(hovered).not.toBe(idle)
  await page.mouse.move(8, 8)
  await expect.poll(() => seam.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(idle)
  await seam.focus()
  expect(await seam.evaluate((node) => node.matches(':focus-visible'))).toBe(true)
  const focusedOutline = await seam.evaluate((node) => getComputedStyle(node).outlineStyle)
  expect(focusedOutline).not.toBe('none')
})
