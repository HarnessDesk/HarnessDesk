import { expect, test, type Locator } from '@playwright/test'

const intersection = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

const box = async (locator: Locator) => {
  const value = await locator.boundingBox()
  expect(value, `expected a visible box for ${await locator.getAttribute('data-slot')}`).not.toBeNull()
  return value!
}

const textInk = async (locator: Locator) => locator.evaluate((node) => {
  const range = document.createRange()
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
  let text = walker.nextNode()
  while (text && !(text.textContent ?? '').trim()) text = walker.nextNode()
  if (text) range.selectNodeContents(text)
  let clipLeft = Number.NEGATIVE_INFINITY
  let clipRight = Number.POSITIVE_INFINITY
  let clipTop = Number.NEGATIVE_INFINITY
  let clipBottom = Number.POSITIVE_INFINITY
  let parent = (text as Text | null)?.parentElement ?? null
  while (parent && parent !== node.closest('[data-slot="sidebar-menu-button"]')) {
    const style = getComputedStyle(parent)
    if (style.overflowX !== 'visible' || parent.matches('[data-slot="sidebar-menu-label-content"]')) {
      const rect = parent.getBoundingClientRect()
      clipLeft = Math.max(clipLeft, rect.left + parent.clientLeft + Number.parseFloat(style.paddingLeft))
      clipRight = Math.min(clipRight, rect.right - parent.clientLeft - Number.parseFloat(style.paddingRight))
      clipTop = Math.max(clipTop, rect.top + parent.clientTop + Number.parseFloat(style.paddingTop))
      clipBottom = Math.min(clipBottom, rect.bottom - parent.clientTop - Number.parseFloat(style.paddingBottom))
    }
    parent = parent.parentElement
  }
  return [...range.getClientRects()].map(({ x, y, width, height }) => ({
    x: Math.max(x, clipLeft),
    y: Math.max(y, clipTop),
    width: Math.max(0, Math.min(x + width, clipRight) - Math.max(x, clipLeft)),
    height: Math.max(0, Math.min(y + height, clipBottom) - Math.max(y, clipTop)),
  })).filter(({ width, height }) => width > 0 && height > 0)
})

test('marked sidebar titles clear every trailing box without changing label geometry', async ({ page }) => {
  await page.goto('/design.html?view=sidebar')
  const example = page.locator('[data-catalog-example="sidebar"]')
  const anatomy = example.locator('[aria-label="Sidebar trailing slot anatomy"]')
  const rows = anatomy.locator('[data-catalog-title-case]')

  for (const width of [200, 220, 260, 320]) {
    await anatomy.locator('[data-slot="sidebar-menu"]').evaluateAll((lists, next) => {
      for (const list of lists) (list as HTMLElement).style.width = `${next}px`
    }, width)
    for (let rowIndex = 0; rowIndex < await rows.count(); rowIndex += 1) {
      const row = rows.nth(rowIndex)
      const caseName = await row.getAttribute('data-catalog-title-case') ?? 'marked row'
      const button = row.locator(':scope > [data-slot="sidebar-menu-button"], :scope > div > [data-slot="sidebar-menu-button"]').first()
      const label = button.locator('[data-slot="sidebar-menu-label"]')
      const title = label.locator('[data-slot="sidebar-menu-label-content"]')
      const obstacles = row.locator(':scope > [data-slot="sidebar-menu-badge"], :scope > [data-slot="sidebar-menu-action"], :scope > div > [data-slot="sidebar-menu-badge"], :scope > div > [data-slot="sidebar-menu-action"]')
      let restBox: Awaited<ReturnType<typeof box>> | null = null

      for (const state of ['rest', 'hover', 'focus'] as const) {
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
        await page.mouse.move(0, 0)
        if (state === 'hover') await row.hover()
        if (state === 'focus') await button.focus()
        await page.waitForTimeout(100)
        const labelBox = await box(label)
        if (state === 'rest') restBox = labelBox
        else expect(labelBox, `${caseName} label box moved at ${width}px (${state})`).toEqual(restBox)

        const titleRects = await textInk(title)
        for (let obstacleIndex = 0; obstacleIndex < await obstacles.count(); obstacleIndex += 1) {
          const obstacle = obstacles.nth(obstacleIndex)
          if (!(await obstacle.isVisible())) continue
          if (await obstacle.getAttribute('data-slot') === 'sidebar-menu-action'
            && await obstacle.evaluate((node) => getComputedStyle(node).opacity) !== '1') continue
          const target = await box(obstacle)
          const widest = Math.max(0, ...titleRects.map((ink) =>
            ink.y < target.y + target.height && target.y < ink.y + ink.height
              ? Math.max(0, Math.min(ink.x + ink.width, target.x + target.width) - Math.max(ink.x, target.x))
              : 0,
          ))
          expect(widest, `${caseName} title overlaps ${await obstacle.getAttribute('aria-label') ?? 'trailing box'} by ${widest}px at ${width}px (${state})`).toBe(0)
        }
      }
    }
  }
})

test('sidebar state marks yield to actions and every trailing control stays on the end rail', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto('/design.html?view=sidebar')
  const example = page.locator('[data-catalog-example="sidebar"]')
  const anatomy = example.locator('[data-catalog-label-case="badge"]')
  const list = anatomy.locator('xpath=ancestor::ul[@data-slot="sidebar-menu"]')
  const sidebars = example.locator('[data-region="sidebar-header"]').locator('xpath=ancestor::div[contains(@class,"sidebar_")][last()]')
  const state = anatomy.locator('[data-slot="sidebar-menu-state"]')
  const action = anatomy.locator('[data-slot="sidebar-menu-action"]')
  const nestedExample = example.locator('[aria-label="Nested row end rail"]')
  const sidebar = sidebars.first()
  const frame = sidebar.locator('xpath=parent::*')

  for (const width of [200, 220, 260, 320]) {
    await list.evaluate((node, next) => { (node as HTMLElement).style.width = `${next}px` }, width)
    await nestedExample.evaluate((node, next) => { (node as HTMLElement).style.width = `${next}px` }, width)
    await frame.evaluate((node, next) => { (node as HTMLElement).style.width = `${next}px` }, width)
    for (let index = 0; index < await sidebars.count(); index += 1) {
      await sidebars.nth(index).evaluate((node) => { (node as HTMLElement).style.width = '100%' })
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
        const trailing = row.locator(':scope > [data-slot="sidebar-menu-action"], :scope > div [data-slot="sidebar-menu-action"]')
        if (await trailing.count() === 0) continue
        await row.hover()
        await expect(trailing).toBeVisible()
        expect(intersection(await box(mark), await box(trailing)), `${await mark.getAttribute('aria-label')} state/action overlap at ${width}px (hover)`).toBe(false)
        await row.locator('[data-slot="sidebar-menu-button"]').first().focus()
        expect(intersection(await box(mark), await box(trailing)), `${await mark.getAttribute('aria-label')} state/action overlap at ${width}px (focus)`).toBe(false)
      }

      const rowItems = column.locator('[data-slot="sidebar-menu-item"]')
      for (let rowIndex = 0; rowIndex < await rowItems.count(); rowIndex += 1) {
        const row = rowItems.nth(rowIndex)
        const actions = row.locator(':scope > [data-slot="sidebar-menu-action"], :scope > div [data-slot="sidebar-menu-action"]')
        if (await actions.count() === 0) continue
        const button = row.locator('[data-slot="sidebar-menu-button"]').first()
        const badges = row.locator(':scope > [data-slot="sidebar-menu-badge"]')
        const chips = row.locator('[data-slot="sidebar-menu-label"] [data-slot="chip"]')
        await row.scrollIntoViewIfNeeded()
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
        await page.mouse.move(0, 0)
        const columnCenter = rail.x + rail.width - 32
        for (let badgeIndex = 0; badgeIndex < await badges.count(); badgeIndex += 1) {
          const badge = badges.nth(badgeIndex)
          if (!(await badge.isVisible())) continue
          const ink = badge.locator('svg, [data-role="meta"]').first()
          const inkBox = await ink.count() ? await box(ink) : await box(badge)
          const badgeClass = await badge.getAttribute('class') ?? ''
          const declaredSlot = badgeClass.includes('double-action-step') ? 2 : badgeClass.includes('action-step') ? 1 : 0
          const expectedCenter = columnCenter - declaredSlot * 24
          expect(Math.abs(inkBox.x + inkBox.width / 2 - expectedCenter), `${await badge.getAttribute('aria-label') ?? 'row badge'} visible ink centre ${inkBox.x + inkBox.width / 2} misses ${expectedCenter} at ${width}px (rest; ${await badge.getAttribute('class')})`).toBeLessThanOrEqual(1)
        }
        for (const focus of [false, true]) {
          if (focus) await button.focus()
          else await row.hover()
          for (let left = 0; left < await badges.count(); left += 1) {
            for (let right = left + 1; right < await badges.count(); right += 1) {
              const first = badges.nth(left)
              const second = badges.nth(right)
              if (!(await first.isVisible()) || !(await second.isVisible())) continue
              expect(intersection(await box(first), await box(second)), `trailing marks overlap in ${await button.getAttribute('aria-label') ?? 'sidebar row'} at ${width}px (${focus ? 'focus' : 'hover'})`).toBe(false)
            }
          }
          for (let actionIndex = 0; actionIndex < await actions.count(); actionIndex += 1) {
            const action = actions.nth(actionIndex)
            await expect(action).toHaveCSS('opacity', '1')
            const actionBox = await box(action)
            const markCount = Number(await row.getAttribute('data-sidebar-trailing-marks') ?? 0)
            const expectedCenter = columnCenter - (markCount + await actions.count() - actionIndex - 1) * 24
            const actionName = await action.getAttribute('aria-label')
            const actionInk = action.locator('svg').first()
            const actionInkBox = await actionInk.count() ? await box(actionInk) : actionBox
            expect(Math.abs(actionInkBox.x + actionInkBox.width / 2 - expectedCenter), `${await button.getAttribute('aria-label') ?? actionName ?? 'sidebar row'} action ${actionName ?? actionIndex} visible ink misses ${expectedCenter} at ${width}px (${focus ? 'focus' : 'hover'})`).toBeLessThanOrEqual(1)
            expect(actionBox.x, `row action starts outside sidebar at ${width}px`).toBeGreaterThanOrEqual(rail.x)
            expect(actionBox.x + actionBox.width, `row action ends outside sidebar at ${width}px`).toBeLessThanOrEqual(rail.x + rail.width + 1)
            for (let badgeIndex = 0; badgeIndex < await badges.count(); badgeIndex += 1) {
              const badge = badges.nth(badgeIndex)
              if (!(await badge.isVisible())) continue
              const badgeBox = await box(badge)
              expect(intersection(badgeBox, actionBox), `badge/action overlap in ${await button.getAttribute('aria-label') ?? 'sidebar row'} at ${width}px (${focus ? 'focus' : 'hover'})`).toBe(false)
              const badgeInk = badge.locator('svg, [data-role="meta"]').first()
              const badgeInkBox = await badgeInk.count() ? await box(badgeInk) : badgeBox
              const badgeClass = await badge.getAttribute('class') ?? ''
              const declaredSlot = badgeClass.includes('double-action-step') ? 2 : badgeClass.includes('action-step') ? 1 : 0
              const expectedBadgeCenter = columnCenter - declaredSlot * 24
              expect(Math.abs(badgeInkBox.x + badgeInkBox.width / 2 - expectedBadgeCenter), `${await badge.getAttribute('aria-label') ?? 'row badge'} visible ink moved from its fixed slot at ${width}px (${focus ? 'focus' : 'hover'})`).toBeLessThanOrEqual(1)
            }
            for (let chipIndex = 0; chipIndex < await chips.count(); chipIndex += 1) {
              const chip = chips.nth(chipIndex)
              if (!(await chip.isVisible())) continue
              expect(intersection(await box(chip), actionBox), `chip/action overlap in ${await button.getAttribute('aria-label') ?? 'sidebar row'} at ${width}px (${focus ? 'focus' : 'hover'})`).toBe(false)
            }
          }
        }
      }
    }
  }
})

test('worktree and missing-folder glyphs use the end rail without moving the label', async ({ page }, testInfo) => {
  await page.goto('/design.html?view=sidebar')
  const example = page.locator('[data-catalog-example="sidebar"]')
  const sidebars = example.locator('[data-region="sidebar-header"]').locator('xpath=ancestor::div[contains(@class,"sidebar_")][last()]')
  const sidebar = sidebars.first()
  const frame = sidebar.locator('xpath=parent::*')
  const count = sidebar.locator('[aria-label="Main sections"] [data-slot="sidebar-menu-badge"]').first()
  const measurements: Array<Record<string, unknown>> = []

  for (const width of [200, 220, 260, 320]) {
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
      const restInk = await box(glyph.locator('svg'))
      const restLabel = await box(labelBox)
      const sidebarBox = await box(sidebar)
      const countBox = await box(count)
      const endColumn = sidebarBox.x + sidebarBox.width - 32
      const pairedMark = await row.locator('[data-slot="sidebar-menu-badge"][role="img"]').count() > 1
      const markColumn = endColumn - (label.startsWith('Folder is gone') && pairedMark ? 24 : 0)

      await row.hover()
      await expect(action).toBeVisible()
      await action.hover()
      const tooltip = page.locator('[data-slot="tooltip-content"]')
      await expect(tooltip).toBeVisible()
      await expect(tooltip).toContainText('Actions for')
      const actionBox = await box(action)
      const hoverGlyph = await box(glyph)
      const hoverInk = await box(glyph.locator('svg'))
      const actionInk = await box(action.locator('svg'))
      const hoverLabel = await box(labelBox)
      const tooltipBox = await box(tooltip)
      const viewport = page.viewportSize()!
      const plainBox = (value: NonNullable<Awaited<ReturnType<typeof box>>>) => ({ x: value.x, y: value.y, width: value.width, height: value.height })

      expect(Math.abs(restInk.x + restInk.width / 2 - markColumn), `${label} visible ink centre misses its end-column slot at ${width}px`).toBeLessThanOrEqual(1)
      expect(Math.abs(restGlyph.x + restGlyph.width / 2 - (countBox.x + countBox.width / 2) + (label.startsWith('Folder is gone') && pairedMark ? 24 : 0)), `glyph slot misses its count-column slot at ${width}px`).toBeLessThanOrEqual(1)
      const markCount = Number(await row.getAttribute('data-sidebar-trailing-marks') ?? 0)
      expect(Math.abs(actionInk.x + actionInk.width / 2 - (endColumn - markCount * 24)), `${label} action glyph misses the rail after its marks at ${width}px`).toBeLessThanOrEqual(1)
      expect(actionBox.x, `action begins outside sidebar at ${width}px`).toBeGreaterThanOrEqual(sidebarBox.x)
      expect(actionBox.x + actionBox.width, `action exceeds sidebar inset at ${width}px`).toBeLessThanOrEqual(sidebarBox.x + sidebarBox.width - 20 + 1)
      expect(hoverGlyph).toEqual(restGlyph)
      expect(hoverInk).toEqual(restInk)
      expect(Math.abs(actionBox.x + actionBox.width / 2 - (endColumn - markCount * 24)), `${label} action target misses the shared column after its marks at ${width}px`).toBeLessThanOrEqual(1)
      expect(hoverLabel).toEqual(restLabel)
      expect(tooltipBox.x, `tooltip begins outside window at ${width}px`).toBeGreaterThanOrEqual(0)
      expect(tooltipBox.x + tooltipBox.width, `tooltip exceeds window at ${width}px`).toBeLessThanOrEqual(viewport.width)

      measurements.push({
        width,
        glyph: label,
        restInkCentreOffset: restInk.x + restInk.width / 2 - endColumn,
        actionInkCentreOffset: actionInk.x + actionInk.width / 2 - endColumn,
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
      expect(openGlyph).toEqual(restGlyph)
      expect(await box(labelBox)).toEqual(restLabel)
      await page.keyboard.press('Escape')
    }

    const sidebarBox = await box(sidebar)
    const endColumn = sidebarBox.x + sidebarBox.width - 32
    const plus = sidebar.locator('[data-slot="navigation-group-header"] button[aria-label="Open a project folder"]')
    const plusInk = await box(plus.locator('svg'))
    expect(Math.abs(plusInk.x + plusInk.width / 2 - endColumn), `header + glyph misses the sidebar end column at ${width}px`).toBeLessThanOrEqual(1)
    const plusBox = await box(plus)
    expect(plusBox.x, `header + action starts outside sidebar at ${width}px`).toBeGreaterThanOrEqual(sidebarBox.x)
    expect(plusBox.x + plusBox.width, `header + action ends outside sidebar at ${width}px`).toBeLessThanOrEqual(sidebarBox.x + sidebarBox.width + 1)
    const headerTriggers = sidebar.locator('[data-slot="navigation-group-header"] [data-slot="popover-trigger"]')
    const display = headerTriggers.first()
    const displayBox = await box(display)
    expect(Math.abs(displayBox.x + displayBox.width / 2 - (endColumn - 24)), `display action is not one target left of header + at ${width}px`).toBeLessThanOrEqual(1)
    expect(displayBox.x, `display action starts outside sidebar at ${width}px`).toBeGreaterThanOrEqual(sidebarBox.x)
    expect(displayBox.x + displayBox.width, `display action ends outside sidebar at ${width}px`).toBeLessThanOrEqual(sidebarBox.x + sidebarBox.width + 1)

    const chevron = sidebar.locator('nav [data-slot="popover-trigger"]')
    const chevronInk = await box(chevron.locator('svg'))
    expect(Math.abs(chevronInk.x + chevronInk.width / 2 - endColumn), `New session chevron misses the sidebar end column at ${width}px`).toBeLessThanOrEqual(1)
    const chevronBox = await box(chevron)
    expect(chevronBox.x, `New session chevron starts outside sidebar at ${width}px`).toBeGreaterThanOrEqual(sidebarBox.x)
    expect(chevronBox.x + chevronBox.width, `New session chevron ends outside sidebar at ${width}px`).toBeLessThanOrEqual(sidebarBox.x + sidebarBox.width + 1)

    const projectRow = sidebar.locator('[data-draggable]').locator('xpath=ancestor::li[@data-slot="sidebar-menu-item"][1]')
    const pinned = projectRow.locator('[data-slot="sidebar-menu-badge"][aria-label="Pinned"]')
    await expect(pinned).toBeVisible()
    const pinnedInk = await box(pinned.locator('svg'))
    expect(Math.abs(pinnedInk.x + pinnedInk.width / 2 - endColumn), `Pinned badge misses the sidebar end column at ${width}px`).toBeLessThanOrEqual(1)
    const addAction = projectRow.getByRole('button', { name: /^New session in / })
    const moreAction = projectRow.getByRole('button', { name: /^Actions for / })
    for (const focus of [false, true]) {
      if (focus) await projectRow.locator('[data-slot="sidebar-menu-button"]').focus()
      else await projectRow.hover()
      await expect(addAction).toHaveCSS('opacity', '1')
      await expect(moreAction).toHaveCSS('opacity', '1')
      const addBox = await box(addAction)
      const moreBox = await box(moreAction)
      const shiftedPin = await box(pinned)
      expect(Math.abs(addBox.x + addBox.width / 2 - (endColumn - 48)), `project + action misses its shifted slot at ${width}px`).toBeLessThanOrEqual(1)
      expect(Math.abs(moreBox.x + moreBox.width / 2 - (endColumn - 24)), `project ⋯ action misses its shifted slot at ${width}px`).toBeLessThanOrEqual(1)
      expect(Math.abs(pinnedInk.x + pinnedInk.width / 2 - shiftedPin.x - shiftedPin.width / 2), `Pinned badge moved from its fixed slot at ${width}px (${focus ? 'focus' : 'hover'})`).toBeLessThanOrEqual(1)
      expect(intersection(shiftedPin, addBox), `Pinned badge overlaps project + at ${width}px (${focus ? 'focus' : 'hover'})`).toBe(false)
      expect(intersection(shiftedPin, moreBox), `Pinned badge overlaps project ⋯ at ${width}px (${focus ? 'focus' : 'hover'})`).toBe(false)
    }
  }
  await testInfo.attach('sidebar-trailing-glyph-measurements.json', {
    body: JSON.stringify(measurements, null, 2),
    contentType: 'application/json',
  })
  console.info('SIDEBAR_TRAILING_GLYPH_MEASUREMENTS', JSON.stringify(measurements))
})

test('AppWindow count and state marks occupy adjacent target slots on the shared rail', async ({ page }) => {
  await page.goto('/design.html?view=app-window')
  const nav = page.getByRole('navigation', { name: 'Window navigation' })
  const sidebar = nav.locator('xpath=parent::*')
  const frame = sidebar.locator('xpath=parent::*')
  const row = nav.getByRole('button', { name: 'Agents' }).locator('xpath=ancestor::li[@data-slot="sidebar-menu-item"][1]')
  const marks = row.locator('[data-slot="sidebar-menu-badge"]')
  const label = row.locator('[data-slot="sidebar-menu-label"]')
  const title = label.locator('[data-slot="sidebar-menu-label-content"]')
  await title.evaluate((node) => { node.textContent = 'Agents responsible for keeping every workspace conversation available' })

  for (const width of [200, 220, 260, 320]) {
    await frame.evaluate((node, next) => { (node as HTMLElement).style.gridTemplateColumns = `${next}px minmax(0, 1fr)` }, width)
    const sidebarBox = await box(sidebar)
    const column = sidebarBox.x + sidebarBox.width - 32
    expect(await marks.count()).toBe(2)
    const count = marks.nth(0).locator('[data-role="meta"]')
    const dot = marks.nth(1).locator('[data-slot="dot"]')
    let restLabelBox: Awaited<ReturnType<typeof box>> | null = null
    for (const state of ['rest', 'hover', 'focus'] as const) {
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      await page.mouse.move(0, 0)
      if (state === 'hover') await row.hover()
      if (state === 'focus') await row.locator('[data-slot="sidebar-menu-button"]').focus()
      await page.waitForTimeout(100)
      const labelBox = await box(label)
      if (state === 'rest') restLabelBox = labelBox
      else expect(labelBox, `AppWindow label box moved at ${width}px (${state})`).toEqual(restLabelBox)

      const countBox = await box(count)
      const dotBox = await box(dot)
      for (const ink of await textInk(title)) {
        expect(intersection(ink, countBox), `AppWindow title text overlaps count by more than 0px at ${width}px (${state})`).toBe(false)
        expect(intersection(ink, dotBox), `AppWindow title text overlaps state dot by more than 0px at ${width}px (${state})`).toBe(false)
      }
      expect(Math.abs(countBox.x + countBox.width / 2 - (column - 24)), `AppWindow count misses the adjacent target slot at ${width}px (${state})`).toBeLessThanOrEqual(1)
      expect(Math.abs(dotBox.x + dotBox.width / 2 - column), `AppWindow state dot misses the sidebar end column at ${width}px (${state})`).toBeLessThanOrEqual(1)
      for (let index = 0; index < await marks.count(); index += 1) {
        const mark = await box(marks.nth(index))
        expect(mark.x, `AppWindow mark ${index} begins outside sidebar at ${width}px`).toBeGreaterThanOrEqual(sidebarBox.x)
        expect(mark.x + mark.width, `AppWindow mark ${index} ends outside sidebar at ${width}px`).toBeLessThanOrEqual(sidebarBox.x + sidebarBox.width + 1)
      }
      expect(intersection(countBox, dotBox), `AppWindow count and state dot overlap at ${width}px (${state})`).toBe(false)
    }
  }
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
