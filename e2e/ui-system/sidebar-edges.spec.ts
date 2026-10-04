import { expect, test, type Locator } from '@playwright/test'
import { measureSidebarRail } from './sidebar-rail.mjs'

const intersection = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

const overlapSize = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) => ({
  width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)),
  height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)),
})

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

test('hover actions take the rail and every trailing mark moves by the declared action count', async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  await page.goto('/design.html?view=sidebar')
  const example = page.locator('[data-catalog-example="sidebar"]')
  const anatomy = example.locator('[aria-label="Sidebar trailing slot anatomy"]')
  const rows = anatomy.locator('[data-catalog-title-case]')
  const center = async (locator: Locator) => {
    const rect = await box(locator)
    return rect.x + rect.width / 2
  }

  for (const width of [200, 220, 260, 320]) {
    await anatomy.locator('[data-slot="sidebar-menu"]').evaluateAll((lists, next) => {
      for (const list of lists) (list as HTMLElement).style.width = `${next}px`
    }, width)
    for (let rowIndex = 0; rowIndex < await rows.count(); rowIndex += 1) {
      const row = rows.nth(rowIndex)
      await row.scrollIntoViewIfNeeded()
      const caseName = await row.getAttribute('data-catalog-title-case') ?? 'marked row'
      const actions = row.locator(':scope > [data-slot="sidebar-menu-action"]')
      const actionCount = await actions.count()
      if (actionCount === 0) continue
      const action = actions.last()
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      await page.mouse.move(0, 0)
      await action.evaluate((node) => { node.removeAttribute('data-state'); node.setAttribute('aria-expanded', 'false') })
      await page.waitForTimeout(300)
      const button = row.locator(':scope > [data-slot="sidebar-menu-button"], :scope > div > [data-slot="sidebar-menu-button"]').first()
      const label = button.locator('[data-slot="sidebar-menu-label"]')
      const title = label.locator('[data-slot="sidebar-menu-label-content"]')
      const badges = row.locator(':scope > [data-slot="sidebar-menu-badge"]:visible, :scope > div > [data-slot="sidebar-menu-badge"]:visible')
      const stateMarks = row.locator('[data-slot="sidebar-menu-state"]')
      const labelAtRest = await box(label)
      const badgeCentersAtRest: number[] = []
      for (let markIndex = 0; markIndex < await badges.count(); markIndex += 1) badgeCentersAtRest.push(await center(badges.nth(markIndex)))
      const rail = await row.evaluate((node, target) => ({
        center: node.getBoundingClientRect().right - target,
        target,
      }), await row.evaluate((node) => Number.parseFloat(getComputedStyle(node).getPropertyValue('--hd-sidebar-end-action-step'))))
      const expectedMove = actionCount * rail.target
      const declaredMarks = Number(await row.getAttribute('data-sidebar-trailing-marks') ?? 0)
      const hiddenCounts = await row.locator('[data-sidebar-count]').count() - await row.locator('[data-sidebar-count]:visible').count()
      const expectedStateOffset = (declaredMarks - 1 + actionCount - hiddenCounts) * rail.target
      if (await stateMarks.count() > 0 && await badges.count() === 3) {
        expect(declaredMarks, 'three badges plus the folded state reserve four marks').toBe(4)
        const reserve = await title.evaluate((node) => Number.parseFloat(getComputedStyle(node).paddingInlineEnd))
        const endRail = await action.evaluate((node) => Number.parseFloat(getComputedStyle(node).insetInlineEnd))
        const dotWidth = await row.locator('[data-sidebar-menu-state-compact] [data-slot="dot"]').evaluate(node => Number.parseFloat(getComputedStyle(node).width))
        expect(reserve, 'the full state clears the three badges and ends on their visible dot edge').toBe(endRail + 3 * rail.target + (rail.target - dotWidth) / 2)
      }

      for (const state of ['hover', 'focus', 'menu-open'] as const) {
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
        await page.mouse.move(0, 0)
        await action.evaluate((node) => { node.removeAttribute('data-state'); node.setAttribute('aria-expanded', 'false') })
        if (state === 'hover') await row.hover()
        if (state === 'focus') await button.focus()
        if (state === 'menu-open') await action.evaluate((node) => { node.setAttribute('data-state', 'open'); node.setAttribute('aria-expanded', 'true') })
        await page.waitForTimeout(300)
        await expect(action).toHaveCSS('opacity', '1')
        const labelBox = await box(label)
        expect(labelBox, `${caseName} label box moved at ${width}px (${state})`).toEqual(labelAtRest)
        for (let actionIndex = 0; actionIndex < actionCount; actionIndex += 1) {
          const actionCenter = await center(actions.nth(actionIndex))
          const expectedActionCenter = rail.center - (actionCount - actionIndex - 1) * rail.target
          expect(Math.abs(actionCenter - expectedActionCenter), `${caseName} action ${actionIndex} misses its rail column by ${Math.round(actionCenter - expectedActionCenter)}px at ${width}px (${state})`).toBeLessThanOrEqual(1)
        }

        const titleRects = await textInk(title)
        const actionBoxes: Awaited<ReturnType<typeof box>>[] = []
        for (let actionIndex = 0; actionIndex < actionCount; actionIndex += 1) {
          const currentAction = actions.nth(actionIndex)
          const actionBox = await box(currentAction)
          actionBoxes.push(actionBox)
          for (const ink of titleRects) expect(intersection(ink, actionBox), `${caseName} title ink overlaps action ${actionIndex} at ${width}px (${state})`).toBe(false)
        }
        for (let markIndex = 0; markIndex < await badges.count(); markIndex += 1) {
          const mark = badges.nth(markIndex)
          const markCenter = await center(mark)
          expect(Math.abs(markCenter - (badgeCentersAtRest[markIndex]! - expectedMove)), `${caseName} mark ${markIndex} did not move left by ${expectedMove}px at ${width}px (${state})`).toBeLessThanOrEqual(1)
          const markBox = await box(mark)
          for (let actionIndex = 0; actionIndex < actionBoxes.length; actionIndex += 1) expect(intersection(markBox, actionBoxes[actionIndex]!), `${caseName} mark ${markIndex} overlaps action ${actionIndex} at ${width}px (${state})`).toBe(false)
          for (const ink of titleRects) expect(intersection(ink, markBox), `${caseName} title ink overlaps mark ${markIndex} at ${width}px (${state})`).toBe(false)
        }
        // The folded state is a mark too: check every badge/state pair,
        // including folder + worktree + activity + needs-you on one row.
        const trailingBoxes = []
        for (const mark of await badges.all()) trailingBoxes.push(await box(mark))
        for (const mark of await stateMarks.all()) trailingBoxes.push(await box(mark))
        for (let left = 0; left < trailingBoxes.length; left += 1) {
          for (let right = left + 1; right < trailingBoxes.length; right += 1) {
            expect(intersection(trailingBoxes[left]!, trailingBoxes[right]!), `${caseName} marks ${left} and ${right} overlap at ${width}px (${state})`).toBe(false)
          }
        }
        for (let markIndex = 0; markIndex < await stateMarks.count(); markIndex += 1) {
          const mark = stateMarks.nth(markIndex)
          const markBox = await box(mark)
          const stateCenter = markBox.x + markBox.width / 2
          expect(Math.abs(stateCenter - (rail.center - expectedStateOffset)), `${caseName} state mark misses its declared leftmost slot by ${Math.round(stateCenter - (rail.center - expectedStateOffset))}px at ${width}px (${state})`).toBeLessThanOrEqual(1)
          for (let actionIndex = 0; actionIndex < actionBoxes.length; actionIndex += 1) expect(intersection(markBox, actionBoxes[actionIndex]!), `${caseName} state mark overlaps action ${actionIndex} at ${width}px (${state})`).toBe(false)
          for (const ink of titleRects) expect(intersection(ink, markBox), `${caseName} title ink overlaps state mark at ${width}px (${state})`).toBe(false)
        }
        if (declaredMarks === 4 && state === 'hover' && [200, 260].includes(width)) {
          await testInfo.attach(`four-marks-${width}-hover.png`, { body: await row.screenshot(), contentType: 'image/png' })
        }
      }
      await action.evaluate((node) => { node.removeAttribute('data-state'); node.setAttribute('aria-expanded', 'false') })
    }
  }
})

test('marked sidebar titles clear every trailing box without changing label geometry', async ({ page }) => {
  test.setTimeout(120_000)
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
      await row.scrollIntoViewIfNeeded()
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
    await list.evaluate((node, next) => { const css = getComputedStyle(node); (node as HTMLElement).style.width = `${next + Number.parseFloat(css.borderLeftWidth) + Number.parseFloat(css.borderRightWidth)}px` }, width)
    await nestedExample.evaluate((node, next) => { const css = getComputedStyle(node); (node as HTMLElement).style.width = `${next + Number.parseFloat(css.borderLeftWidth) + Number.parseFloat(css.borderRightWidth)}px` }, width)
    await frame.evaluate((node, next) => { const css = getComputedStyle(node); (node as HTMLElement).style.width = `${next + Number.parseFloat(css.borderLeftWidth) + Number.parseFloat(css.borderRightWidth)}px` }, width)
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
      await expect(state).toHaveAttribute('title', 'Needs you')
      await expect(state).toHaveAttribute('aria-label', 'Needs you')
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
      // Read each row's geometry once per state. Serial browser round trips
      // for each attribute made this full sweep exhaust its budget at 220px.
      const rowActions = await column.locator('[data-slot="sidebar-menu-action"]').evaluateAll((nodes) => nodes.map((node) => {
        const rect = node.getBoundingClientRect()
        const parent = node.closest('[data-nested="true"]')?.parentElement
        const action = parent?.querySelector(':scope > [data-slot="sidebar-menu-action"], :scope > div > [data-slot="sidebar-menu-action"]')
        const parentRect = action?.getBoundingClientRect()
        return { left: rect.left, right: rect.right, parent: parentRect ? { left: parentRect.left, right: parentRect.right } : null }
      }))
      for (const trailing of rowActions) {
        expect(trailing.left, `row action begins outside sidebar at ${width}px`).toBeGreaterThanOrEqual(rail.x)
        expect(trailing.right, `row action spills past sidebar at ${width}px`).toBeLessThanOrEqual(rail.x + rail.width + 1)
        if (trailing.parent) {
          expect(Math.abs(trailing.left - trailing.parent.left), `nested action start misses parent end rail at ${width}px`).toBeLessThanOrEqual(1)
          expect(Math.abs(trailing.right - trailing.parent.right), `nested action end misses parent end rail at ${width}px`).toBeLessThanOrEqual(1)
        }
      }
      const childRail = await box(nestedExample.getByRole('button', { name: 'Untitled session actions' }))
      const parentRail = await box(nestedExample.getByRole('button', { name: 'Release room actions' }))
      expect(Math.abs(childRail.x - parentRail.x), `nested specimen misses its parent rail at ${width}px`).toBeLessThanOrEqual(1)
      expect(Math.abs(childRail.x + childRail.width - parentRail.x - parentRail.width), `nested specimen misses its parent rail at ${width}px`).toBeLessThanOrEqual(1)

      const geometry = (row: Locator) => row.evaluate((node) => {
        const rect = (element: Element) => {
          const { x, y, width, height } = element.getBoundingClientRect()
          return { x, y, width, height }
        }
        const visible = (element: Element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden'
        const atoms = (slot: string) => [...node.querySelectorAll(`:scope > [data-slot="${slot}"], :scope > div > [data-slot="${slot}"]`)].filter(visible)
        return {
          name: node.querySelector('[data-slot="sidebar-menu-button"]')?.getAttribute('aria-label') ?? 'sidebar row',
          badges: atoms('sidebar-menu-badge').map((badge) => ({
            box: rect(badge), ink: rect(badge.querySelector('svg, [data-role="meta"], [data-slot="spinner"]') ?? badge),
            label: badge.getAttribute('aria-label') ?? 'row badge',
            slot: badge.className.includes('double-action-step') ? 2 : badge.className.includes('action-step') ? 1 : 0,
          })),
          actions: atoms('sidebar-menu-action').map((action) => ({
            box: rect(action), ink: rect(action.querySelector('svg') ?? action),
            name: action.getAttribute('aria-label'), opacity: getComputedStyle(action).opacity,
          })),
          chips: [...node.querySelectorAll(':scope > [data-slot="sidebar-menu-button"] [data-slot="chip"], :scope > div > [data-slot="sidebar-menu-button"] [data-slot="chip"]')].filter(visible).map(rect),
          states: [...node.querySelectorAll(':scope > [data-slot="sidebar-menu-button"] [data-slot="sidebar-menu-state"], :scope > div > [data-slot="sidebar-menu-button"] [data-slot="sidebar-menu-state"]')].filter(visible).map(rect),
        }
      })
      const rows = await column.locator('[data-slot="sidebar-menu-item"]:has(> [data-slot="sidebar-menu-action"], > div > [data-slot="sidebar-menu-action"])').all()
      const columnCenter = rail.x + rail.width - 32
      for (const row of rows) {
        await row.scrollIntoViewIfNeeded()
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
        await page.mouse.move(0, 0)
        const rest = await geometry(row)
        for (const badge of rest.badges) {
          expect(Math.abs(badge.ink.x + badge.ink.width / 2 - (columnCenter - badge.slot * 24)), `${badge.label} visible ink centre misses its rest slot at ${width}px`).toBeLessThanOrEqual(1)
        }
        for (const focus of [false, true]) {
          if (focus) await row.locator('[data-slot="sidebar-menu-button"]').first().focus()
          // Hover the leading icon, rather than a narrow row's trailing marks.
          else await row.locator(':scope > [data-slot="sidebar-menu-button"], :scope > div > [data-slot="sidebar-menu-button"]').first().hover({ position: { x: 8, y: 12 } })
          const measured = await geometry(row)
          const mode = focus ? 'focus' : 'hover'
          for (let left = 0; left < measured.badges.length; left += 1) {
            for (let right = left + 1; right < measured.badges.length; right += 1) {
              expect(intersection(measured.badges[left]!.box, measured.badges[right]!.box), `trailing marks overlap in ${measured.name} at ${width}px (${mode})`).toBe(false)
            }
          }
          for (let index = 0; index < measured.actions.length; index += 1) {
            const action = measured.actions[index]!
            expect(action.opacity, `${action.name} is hidden at ${width}px (${mode})`).toBe('1')
            const expectedCenter = columnCenter - (measured.actions.length - index - 1) * 24
            expect(Math.abs(action.ink.x + action.ink.width / 2 - expectedCenter), `${measured.name} action ${action.name} visible ink misses ${expectedCenter} at ${width}px (${mode})`).toBeLessThanOrEqual(1)
            expect(action.box.x, `row action starts outside sidebar at ${width}px`).toBeGreaterThanOrEqual(rail.x)
            expect(action.box.x + action.box.width, `row action ends outside sidebar at ${width}px`).toBeLessThanOrEqual(rail.x + rail.width + 1)
            for (const badge of measured.badges) {
              expect(intersection(badge.box, action.box), `badge/action overlap in ${measured.name} at ${width}px (${mode})`).toBe(false)
              const expectedBadgeCenter = columnCenter - (badge.slot + measured.actions.length) * 24
              expect(Math.abs(badge.ink.x + badge.ink.width / 2 - expectedBadgeCenter), `${badge.label} visible ink misses its shifted slot at ${width}px (${mode})`).toBeLessThanOrEqual(1)
            }
            for (const chip of measured.chips) expect(intersection(chip, action.box), `chip/action overlap in ${measured.name} at ${width}px (${mode})`).toBe(false)
            for (const state of measured.states) expect(intersection(state, action.box), `state/action overlap in ${measured.name} at ${width}px (${mode})`).toBe(false)
          }
        }
      }
    }
  }
})

test('worktree and missing-folder glyphs use the end rail without moving the label', async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  await page.goto('/design.html?view=sidebar')
  const example = page.locator('[data-catalog-example="sidebar"]')
  const sidebars = example.locator('[data-region="sidebar-header"]').locator('xpath=ancestor::div[contains(@class,"sidebar_")][last()]')
  const sidebar = sidebars.first()
  const frame = sidebar.locator('xpath=parent::*')
  const count = sidebar.locator('[aria-label="Main sections"] [data-slot="sidebar-menu-badge"]').first()
  const measurements: Array<Record<string, unknown>> = []

  for (const width of [200, 220, 260, 320]) {
    await frame.evaluate((node, next) => { const css = getComputedStyle(node); (node as HTMLElement).style.width = `${next + Number.parseFloat(css.borderLeftWidth) + Number.parseFloat(css.borderRightWidth)}px` }, width)
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
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      await page.mouse.move(0, 0)
      const restGlyph = await box(glyph)
      const restInk = await box(glyph.locator('svg'))
      const restLabel = await box(labelBox)
      const sidebarBox = await box(sidebar)
      const countBox = await box(count)
      const endColumn = sidebarBox.x + sidebarBox.width - 32
      const activitySlot = await row.locator('[data-slot="sidebar-menu-badge"] [data-live]').count()
      const worktreeSlot = label.startsWith('Folder is gone') ? await row.locator('[data-slot="sidebar-menu-badge"][aria-label^="Worktree "]').count() : 0
      const offset = (activitySlot + worktreeSlot) * 24
      const markColumn = endColumn - offset

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
      const actionTarget = actionBox.width

      expect(Math.abs(restInk.x + restInk.width / 2 - markColumn), `${label} visible ink centre misses its end-column slot at ${width}px`).toBeLessThanOrEqual(1)
      expect(Math.abs(restGlyph.x + restGlyph.width / 2 - (countBox.x + countBox.width / 2) + offset), `glyph slot misses its count-column slot at ${width}px`).toBeLessThanOrEqual(1)
      expect(Math.abs(actionInk.x + actionInk.width / 2 - endColumn), `${label} action glyph misses the end rail at ${width}px`).toBeLessThanOrEqual(1)
      expect(actionBox.x, `action begins outside sidebar at ${width}px`).toBeGreaterThanOrEqual(sidebarBox.x)
      expect(actionBox.x + actionBox.width, `action exceeds sidebar inset at ${width}px`).toBeLessThanOrEqual(sidebarBox.x + sidebarBox.width - 20 + 1)
      expect(Math.abs(hoverGlyph.x + hoverGlyph.width / 2 - (restGlyph.x + restGlyph.width / 2 - actionTarget)), `${label} mark does not move left by one action at ${width}px`).toBeLessThanOrEqual(1)
      expect(Math.abs(hoverInk.x + hoverInk.width / 2 - (restInk.x + restInk.width / 2 - actionTarget)), `${label} visible ink does not move left by one action at ${width}px`).toBeLessThanOrEqual(1)
      expect(Math.abs(actionBox.x + actionBox.width / 2 - endColumn), `${label} action target misses the shared column at ${width}px`).toBeLessThanOrEqual(1)
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
      expect(Math.abs((await box(action)).x + actionBox.width / 2 - endColumn), `${label} focused action misses the shared column at ${width}px`).toBeLessThanOrEqual(1)
      await action.click()
      await expect(action).toHaveAttribute('data-state', 'open')
      const openGlyph = await box(glyph)
      expect(Math.abs(openGlyph.x + openGlyph.width / 2 - (restGlyph.x + restGlyph.width / 2 - actionTarget)), `${label} open-menu mark does not move left by one action at ${width}px`).toBeLessThanOrEqual(1)
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
      expect(intersection(addBox, moreBox), `real pinned project action targets overlap at ${width}px`).toBe(false)
      const shiftedPin = await box(pinned)
      expect(Math.abs(addBox.x + addBox.width / 2 - (endColumn - 24)), `project + action misses its adjacent slot at ${width}px`).toBeLessThanOrEqual(1)
      expect(Math.abs(moreBox.x + moreBox.width / 2 - endColumn), `project ⋯ action misses the end rail at ${width}px`).toBeLessThanOrEqual(1)
      expect(Math.abs(pinnedInk.x + pinnedInk.width / 2 - (shiftedPin.x + shiftedPin.width / 2 + 48)), `Pinned badge did not move left by two action targets at ${width}px (${focus ? 'focus' : 'hover'})`).toBeLessThanOrEqual(1)
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
  test.setTimeout(120_000)
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
  test.setTimeout(120_000)
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

test('real session and room rows keep every visible trailing mark in its own slot', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto('/design.html?view=sidebar')
  const example = page.locator('[data-catalog-example="sidebar"]')
  const sidebars = example.locator('[data-region="sidebar-header"]').locator('xpath=ancestor::div[contains(@class,"sidebar_")][last()]')
  const sidebar = sidebars.first()
  const frame = sidebar.locator('xpath=parent::*')
  const session = sidebar.locator('[data-region="session-row"] [data-slot="sidebar-menu-item"]')
    .filter({ hasText: 'Pin the flaky inventory test after reconciling every retry branch' })
  const room = sidebar.locator('[data-slot="sidebar-menu-button"][aria-label="Room Approve the migration evidence"][data-held]')
    .locator('xpath=ancestor::li[@data-slot="sidebar-menu-item"][1]')

  const expectNoTrailingOverlap = async (row: Locator, label: string, stateName: string) => {
    const state = row.locator('[data-slot="sidebar-menu-state"]')
    const full = state.locator('[data-sidebar-menu-state-full] [data-slot="chip"]')
    const compact = state.locator('[data-sidebar-menu-state-compact] [data-slot="dot"]')
    const atoms: Array<{ locator: Locator; label: string }> = []
    if (await full.isVisible()) atoms.push({ locator: full, label: 'state chip' })
    if (await compact.isVisible()) atoms.push({ locator: compact, label: 'state dot' })
    const badges = row.locator(':scope > [data-slot="sidebar-menu-badge"], :scope > div > [data-slot="sidebar-menu-badge"]')
    for (let index = 0; index < await badges.count(); index += 1) {
      const badge = badges.nth(index)
      if (await badge.isVisible()) atoms.push({ locator: badge, label: await badge.getAttribute('aria-label') ?? `mark ${index}` })
    }
    const actions = row.locator(':scope > [data-slot="sidebar-menu-action"], :scope > div > [data-slot="sidebar-menu-action"]')
    for (let index = 0; index < await actions.count(); index += 1) {
      const action = actions.nth(index)
      if (await action.isVisible() && await action.evaluate((node) => getComputedStyle(node).opacity) !== '0') {
        atoms.push({ locator: action, label: await action.getAttribute('aria-label') ?? `action ${index}` })
      }
    }
    for (let left = 0; left < atoms.length; left += 1) {
      for (let right = left + 1; right < atoms.length; right += 1) {
        const first = await box(atoms[left]!.locator)
        const second = await box(atoms[right]!.locator)
        const overlap = overlapSize(first, second)
        expect(overlap.width === 0 || overlap.height === 0,
          `${label}: ${atoms[left]!.label} overlaps ${atoms[right]!.label} by ${overlap.width}×${overlap.height}px at 260px (${stateName}); ${JSON.stringify({ first, second })}`,
        ).toBe(true)
      }
    }
  }

  await expect(session).toHaveCount(1)
  await expect(session).toHaveAttribute('data-sidebar-trailing-marks', '2')
  await expect(session.locator('[data-slot="sidebar-menu-state"]')).toHaveCount(1)
  await expect(session.locator('[data-slot="sidebar-menu-badge"][aria-label^="Worktree "]')).toHaveCount(1)
  await expect(session.locator('[data-slot="sidebar-menu-badge"] [data-live]')).toHaveCount(0)
  await expect(room).toHaveCount(1)
  await expect(room.locator('[data-slot="sidebar-menu-badge"][title="1 held message waiting for you"]')).toHaveText('1')
  await expect(room.locator('[data-slot="sidebar-menu-state"]'), 'production approval RoomRow must render the shared fold').toHaveCount(1)
  await expect(room.locator('[data-slot="sidebar-menu-state"]')).toHaveAttribute('aria-label', 'Needs you')

  await frame.evaluate((node) => { const css = getComputedStyle(node); (node as HTMLElement).style.width = `${260 + Number.parseFloat(css.borderLeftWidth) + Number.parseFloat(css.borderRightWidth)}px` })
  for (let index = 0; index < await sidebars.count(); index += 1) {
    await sidebars.nth(index).evaluate((node) => { (node as HTMLElement).style.width = '100%' })
  }
  for (const [row, label] of [[room, 'real room row'], [session, 'real session row']] as const) {
    await row.scrollIntoViewIfNeeded()
    const button = row.locator('[data-slot="sidebar-menu-button"]').first()
    const action = row.locator('[data-slot="sidebar-menu-action"]').first()
    for (const stateName of ['rest', 'hover', 'focus-within', 'menu-open'] as const) {
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      await page.mouse.move(0, 0)
      await action.evaluate((node) => { node.removeAttribute('data-state'); node.setAttribute('aria-expanded', 'false') })
      if (stateName === 'hover') await button.hover()
      if (stateName === 'focus-within') await button.focus()
      if (stateName === 'menu-open') await action.evaluate((node) => { node.setAttribute('data-state', 'open'); node.setAttribute('aria-expanded', 'true') })
      await expectNoTrailingOverlap(row, label, stateName)
    }
  }
})

test('nested board and expanded room keep trailing marks on their own label line', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto('/design.html?view=sidebar')
  const example = page.locator('[data-catalog-example="sidebar"]')
  const anatomy = example.locator('[aria-label="Sidebar trailing slot anatomy"]')
  const nestedList = example.locator('[aria-label="Nested row end rail"]')
  const sidebars = example.locator('[data-region="sidebar-header"]').locator('xpath=ancestor::div[contains(@class,"sidebar_")][last()]')
  const sidebar = sidebars.first()
  const frame = sidebar.locator('xpath=parent::*')
  const productRoom = sidebar.locator('[data-slot="sidebar-menu-button"][aria-label="Room Approve the migration evidence"][data-held]')
    .locator('xpath=ancestor::li[@data-slot="sidebar-menu-item"][1]')
  const roomToggle = productRoom.locator(':scope > div > [data-slot="sidebar-menu-action"]')

  const expectHeaderItemsCentered = async (row: Locator, label: string, mode: string) => {
    const line = await box(row.locator(':scope > div > [data-slot="sidebar-menu-button"] [data-slot="sidebar-menu-label"], :scope > [data-slot="sidebar-menu-button"] [data-slot="sidebar-menu-label"]').first())
    const centerY = line.y + line.height / 2
    const marks = row.locator(':scope > [data-slot="sidebar-menu-badge"], :scope > div > [data-slot="sidebar-menu-badge"]')
    for (let index = 0; index < await marks.count(); index += 1) {
      const mark = await box(marks.nth(index))
      const delta = mark.y + mark.height / 2 - centerY
      expect(Math.abs(delta), `${label} mark ${index} misses its own label line by ${delta}px (${mode})`).toBeLessThanOrEqual(1)
    }
    const actions = row.locator(':scope > [data-slot="sidebar-menu-action"], :scope > div > [data-slot="sidebar-menu-action"]')
    for (let index = 0; index < await actions.count(); index += 1) {
      const action = await box(actions.nth(index))
      const delta = action.y + action.height / 2 - centerY
      expect(Math.abs(delta), `${label} action ${index} misses its own label line by ${delta}px (${mode})`).toBeLessThanOrEqual(1)
    }
  }

  await anatomy.locator('[data-slot="sidebar-menu"]').evaluateAll((lists) => {
    for (const list of lists) (list as HTMLElement).style.width = '260px'
  })
  await nestedList.evaluate((node) => { const css = getComputedStyle(node); (node as HTMLElement).style.width = `${260 + Number.parseFloat(css.borderLeftWidth) + Number.parseFloat(css.borderRightWidth)}px` })
  await frame.evaluate((node) => { const css = getComputedStyle(node); (node as HTMLElement).style.width = `${260 + Number.parseFloat(css.borderLeftWidth) + Number.parseFloat(css.borderRightWidth)}px` })
  for (let index = 0; index < await sidebars.count(); index += 1) {
    await sidebars.nth(index).evaluate((node) => { (node as HTMLElement).style.width = '100%' })
  }

  const nestedHead = nestedList.locator('[data-catalog-title-case="nested room head"]')
  const nestedMember = nestedList.locator('[data-catalog-title-case="nested member row"]')
  for (const [row, label] of [[nestedHead, 'nested board room head'], [nestedMember, 'nested board member']] as const) {
    await expectHeaderItemsCentered(row, label, 'rest')
    await row.locator(':scope > div > [data-slot="sidebar-menu-button"], :scope > [data-slot="sidebar-menu-button"]').first().hover()
    await expectHeaderItemsCentered(row, label, 'hover')
  }

  await expect(productRoom).toHaveCount(1)
  if (await roomToggle.getAttribute('aria-expanded') !== 'true') {
    await productRoom.locator(':scope > div > [data-slot="sidebar-menu-button"]').hover()
    await roomToggle.click()
  }
  const productMember = productRoom.locator('[data-nested="true"] [data-region="session-row"] [data-slot="sidebar-menu-item"]').first()
  await expect(productMember).toBeVisible()
  for (const [row, label] of [[productRoom, 'product room head'], [productMember, 'product room member']] as const) {
    await row.scrollIntoViewIfNeeded()
    await expectHeaderItemsCentered(row, label, 'rest')
    await row.locator(':scope > div > [data-slot="sidebar-menu-button"], :scope > [data-slot="sidebar-menu-button"]').first().hover()
    await expectHeaderItemsCentered(row, label, 'hover')
  }
})

// These are shipped Sidebar, SessionTree and AppWindow rows, not anatomy specimens.
test('real section headers start at the row icon inset', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto('/design.html?view=sidebar')
  const sidebar = page.locator('[data-catalog-example="sidebar"] [data-region="sidebar-header"]')
    .locator('xpath=ancestor::div[contains(@class,"sidebar_")][last()]').first()
  const frame = sidebar.locator('xpath=parent::*')
  await expect(sidebar.locator('[data-tone="working"], [data-tone="waiting"]')).toHaveCount(0)
  await expect(sidebar.getByText('Pinned · 1', { exact: true })).toBeVisible()
  for (const width of [200, 220, 260, 320, 520]) {
    await frame.evaluate((node, next) => { const css = getComputedStyle(node); (node as HTMLElement).style.width = `${next + Number.parseFloat(css.borderLeftWidth) + Number.parseFloat(css.borderRightWidth)}px` }, width)
    await sidebar.evaluate((node) => { (node as HTMLElement).style.width = '100%' })
    const name = sidebar.locator('[data-draggable] [data-slot="text"]').first()
    const iconX = await name.evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); return range.getBoundingClientRect().x })
    for (const header of [sidebar.getByText('Projects', { exact: true }), sidebar.getByText('Other projects', { exact: true }),
      ]) {
      const x = await header.evaluate((node) => {
        const range = document.createRange(); range.selectNodeContents(node)
        return range.getBoundingClientRect().x
      })
      expect.soft(Math.abs(x - iconX), `${await header.textContent()} at ${width}px: header x=${x}, row icon x=${iconX}`).toBeLessThanOrEqual(1)
    }
    for (const group of await sidebar.locator('[data-slot="sidebar-group"]').all()) {
      const header = group.locator(':scope > [data-slot="group-label"]')
      if (await header.count() === 0) continue
      const x = await header.evaluate((node) => { const range = document.createRange(); range.selectNodeContents(node); return range.getBoundingClientRect().x })
      const rowX = (await box(group.locator('[data-slot="sidebar-menu-icon"]').first())).x
      expect.soft(Math.abs(x + 29 - rowX), `${await header.textContent()} at ${width}px: Pinned children take one leading step from ${x} to ${rowX}`).toBeLessThanOrEqual(1)
    }
  }
  await page.goto('/design.html?view=app-window')
  const nav = page.getByRole('navigation', { name: 'Window navigation' })
  const navFrame = nav.locator('xpath=parent::*').locator('xpath=parent::*')
  for (const width of [200, 220, 260, 320, 520]) {
    await navFrame.evaluate((node, next) => { (node as HTMLElement).style.gridTemplateColumns = `${next}px minmax(0, 1fr)` }, width)
    for (const group of await nav.locator('[data-slot="sidebar-group"]').all()) {
      const header = group.locator(':scope > [data-slot="group-label"]')
      const icon = group.locator('[data-slot="sidebar-menu-icon"]').first()
      const x = await header.evaluate((node) => { const range = document.createRange(); range.selectNodeContents(node); return range.getBoundingClientRect().x })
      expect.soft(Math.abs(x - (await box(icon)).x), `AppWindow ${await header.textContent()} at ${width}px`).toBeLessThanOrEqual(1)
    }
  }
})

test('real waiting room keeps its whole chip before the fade and count, then folds on hover', async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  await page.goto('/design.html?view=sidebar')
  const sidebar = page.locator('[data-catalog-example="sidebar"] [data-region="sidebar-header"]')
    .locator('xpath=ancestor::div[contains(@class,"sidebar_")][last()]').first()
  const frame = sidebar.locator('xpath=parent::*')
  const room = sidebar.locator('[data-slot="sidebar-menu-button"][aria-label="Room Approve the migration evidence"][data-held]')
    .locator('xpath=ancestor::li[@data-slot="sidebar-menu-item"][1]')
  const label = room.locator(':scope > div > [data-slot="sidebar-menu-button"] [data-slot="sidebar-menu-label"]')
  const chip = label.locator('[data-sidebar-menu-state-full] [data-slot="chip"]')
  const title = label.locator('[data-slot="sidebar-menu-label-content"] > span > span').first()
  const count = room.locator(':scope > div > [data-slot="sidebar-menu-badge"]')
  const action = room.locator(':scope > div > [data-slot="sidebar-menu-action"]')
  const measurements = []
  await expect(count).toHaveText('1')
  await expect(room.locator(':scope > div > [data-slot="sidebar-menu-button"]')).toHaveAttribute('aria-label', 'Room Approve the migration evidence')
  await expect(room.locator(':scope > div > [data-slot="sidebar-menu-button"]')).toHaveAttribute('title', /Approve the migration evidence/)
  for (const width of [200, 220, 260, 320, 520]) {
    await frame.evaluate((node, next) => { const css = getComputedStyle(node); (node as HTMLElement).style.width = `${next + Number.parseFloat(css.borderLeftWidth) + Number.parseFloat(css.borderRightWidth)}px` }, width)
    await sidebar.evaluate((node) => { (node as HTMLElement).style.width = '100%' })
    await room.scrollIntoViewIfNeeded()
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.mouse.move(0, 0)
    await expect(chip).toBeVisible()
    const labelBox = await box(label), chipBox = await box(chip), actionBox = await box(action)
    const countVisible = await count.isVisible()
    const fade = await label.evaluate((node) => getComputedStyle(node).maskImage === 'none' ? 0 : Number.parseFloat(getComputedStyle(node).getPropertyValue('--hd-space-8')))
    const clipRight = await label.locator('[data-slot="sidebar-menu-label-content"]').evaluate((node) => node.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(node).paddingRight))
    expect.soft(chipBox.x + chipBox.width, `Needs you chip clips content by ${chipBox.x + chipBox.width - clipRight}px at ${width}px`).toBeLessThanOrEqual(clipRight + 0.1)
    expect.soft(chipBox.x, `Needs you chip begins outside label at ${width}px`).toBeGreaterThanOrEqual(labelBox.x)
    expect.soft(chipBox.x + chipBox.width, `Needs you chip runs into fade at ${width}px`).toBeLessThanOrEqual(labelBox.x + labelBox.width - fade)
    if (countVisible) expect.soft(intersection(chipBox, await box(count)), `Needs you chip overlaps held count at ${width}px`).toBe(false)
    const { rail } = await sidebar.evaluate(measureSidebarRail)
    expect.soft(Math.abs(chipBox.x + chipBox.width - (rail - (countVisible ? 24 : 0))), `Needs you chip ends at the available visible rail at ${width}px`).toBeLessThanOrEqual(0.5)
    measurements.push({ width, chip: chipBox, contentRight: clipRight, title: await box(title) })
    await room.locator(':scope > div > [data-slot="sidebar-menu-button"]').hover()
    await expect(chip).toBeHidden()
    await expect(label.locator('[data-sidebar-menu-state-compact] [data-slot="dot"]')).toBeVisible()
    expect(await box(label), `room label changed on hover at ${width}px`).toEqual(labelBox)
  }
  await testInfo.attach('waiting-room-chip.json', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' })
  console.info('WAITING_ROOM_CHIP', JSON.stringify(measurements))
})

test('real header glyph ink occupies the end rail and its adjacent target columns', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto('/design.html?view=sidebar')
  const sidebar = page.locator('[data-catalog-example="sidebar"] [data-region="sidebar-header"]')
    .locator('xpath=ancestor::div[contains(@class,"sidebar_")][last()]').first()
  const frame = sidebar.locator('xpath=parent::*')
  const header = sidebar.locator('[data-slot="navigation-group-header"]')
  for (const width of [200, 220, 260, 320, 520]) {
    await frame.evaluate((node, next) => {
      const css = getComputedStyle(node)
      ;(node as HTMLElement).style.width = `${next + Number.parseFloat(css.borderLeftWidth) + Number.parseFloat(css.borderRightWidth)}px`
    }, width)
    await sidebar.evaluate((node) => { (node as HTMLElement).style.width = '100%' })
    const side = await box(sidebar)
    expect(side.width).toBe(width)
    const rail = side.x + side.width - 32
    const plus = header.getByRole('button', { name: 'Open a project folder', exact: true }).locator('svg')
    const display = header.getByRole('button', { name: 'How this list is shown', exact: true }).locator('svg')
    const filter = header.locator('[data-slot="search"] svg')
    for (const [glyph, slot, name] of [[plus, 0, '+'], [display, 1, 'display'], [filter, 2, 'filter']] as const) {
      const ink = await box(glyph)
      const delta = ink.x + ink.width / 2 - (rail - slot * 24)
      expect.soft(Math.abs(delta), `header ${name} SVG centre misses rail slot ${slot} by ${delta}px at ${width}px`).toBeLessThanOrEqual(1)
    }
  }
})

test('real working worktree and expanded room members share distinct rail slots at every width', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto('/design.html?view=sidebar')
  const sidebar = page.locator('[data-catalog-example="sidebar"] [data-region="sidebar-header"]')
    .locator('xpath=ancestor::div[contains(@class,"sidebar_")][last()]').first()
  const frame = sidebar.locator('xpath=parent::*')
  const active = sidebar.locator('[data-region="session-row"] [data-slot="sidebar-menu-item"]')
    .filter({ hasText: 'Add fixtures for the refund path before extending the checkout matrix' })
  const room = sidebar.locator('[aria-label="Room Approve the migration evidence"][data-held]')
    .locator('xpath=ancestor::li[@data-slot="sidebar-menu-item"][1]')
  const parentAction = room.locator(':scope > div > [data-slot="sidebar-menu-action"]')
  if (await parentAction.getAttribute('aria-expanded') !== 'true') {
    await room.locator(':scope > div > [data-slot="sidebar-menu-button"]').hover()
    await parentAction.click()
  }
  const member = room.locator('[data-nested="true"] [data-region="session-row"] [data-slot="sidebar-menu-item"]').first()
  await expect(active).toHaveCount(1)
  await expect(active).toHaveAttribute('data-sidebar-trailing-marks', '2')
  const branch = active.locator('[data-slot="sidebar-menu-badge"][aria-label^="Worktree "]')
  const activity = active.locator('[data-slot="sidebar-menu-badge"]').filter({ has: page.locator('[data-live]') })
  await expect(branch).toHaveCount(1)
  await expect(activity).toHaveCount(1)
  const centre = async (glyph: Locator) => { const ink = await box(glyph); return ink.x + ink.width / 2 }
  for (const width of [200, 220, 260, 320, 520]) {
    await frame.evaluate((node, next) => {
      const css = getComputedStyle(node)
      ;(node as HTMLElement).style.width = `${next + Number.parseFloat(css.borderLeftWidth) + Number.parseFloat(css.borderRightWidth)}px`
    }, width)
    await sidebar.evaluate((node) => { (node as HTMLElement).style.width = '100%' })
    const side = await box(sidebar), rail = side.x + side.width - 32
    expect(side.width).toBe(width)
    for (const mode of ['rest', 'hover', 'focus-within'] as const) {
      await active.scrollIntoViewIfNeeded()
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      await page.mouse.move(0, 0)
      const label = active.locator('[data-slot="sidebar-menu-label"]'), rest = await box(label)
      if (mode === 'hover') await active.locator('[data-slot="sidebar-menu-button"]').hover({ position: { x: 8, y: 12 } })
      if (mode === 'focus-within') await active.locator('[data-slot="sidebar-menu-button"]').focus()
      const move = mode === 'rest' ? 0 : 24
      expect(Math.abs(await centre(branch.locator('svg')) - (rail - 24 - move)), `working branch ink at ${width}px (${mode})`).toBeLessThanOrEqual(1)
      expect(Math.abs(await centre(activity.locator('[data-slot="spinner"]')) - (rail - move)), `working activity ink at ${width}px (${mode})`).toBeLessThanOrEqual(1)
      expect(intersection(await box(branch), await box(activity)), `branch and activity overlap at ${width}px (${mode})`).toBe(false)
      expect(await box(label), `working title box moved at ${width}px (${mode})`).toEqual(rest)
    }
    for (const row of [room, member]) {
      await row.scrollIntoViewIfNeeded()
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      await page.mouse.move(0, 0)
      const mark = row.locator(':scope > [data-slot="sidebar-menu-badge"], :scope > div > [data-slot="sidebar-menu-badge"]').last()
      if (await mark.isVisible()) expect(Math.abs(await centre(mark) - rail), `real ${row === room ? 'parent' : 'member'} mark misses rail at ${width}px`).toBeLessThanOrEqual(1)
      else {
        const chip = await box(row.locator(':scope > div > [data-slot="sidebar-menu-button"] [data-sidebar-menu-state-full] [data-slot="chip"], :scope > [data-slot="sidebar-menu-button"] [data-sidebar-menu-state-full] [data-slot="chip"]'))
        const measured = await sidebar.evaluate(measureSidebarRail)
        expect(Math.abs(chip.x + chip.width - measured.rail), `whole parent chip occupies the visible rail when the count yields at ${width}px`).toBeLessThanOrEqual(0.5)
      }
      const action = row.locator(':scope > [data-slot="sidebar-menu-action"], :scope > div > [data-slot="sidebar-menu-action"]').last()
      await row.locator(':scope > div > [data-slot="sidebar-menu-button"], :scope > [data-slot="sidebar-menu-button"]').first().hover()
      expect(Math.abs(await centre(action.locator('svg')) - rail), `real ${row === room ? 'parent' : 'member'} action glyph misses rail at ${width}px`).toBeLessThanOrEqual(1)
    }
  }
})

test('540px window floats the real sidebar with aligned headers and a whole Needs you chip', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 540, height: 900 })
  await page.goto('/design.html?view=panels&sidebar-geometry')
  const canvas = page.locator('[data-slot="workbench-canvas"]')
  // The explorer adds its own navigation; the rig's window is the workbench.
  await canvas.evaluate((node) => Object.assign((node as HTMLElement).style, { position: 'fixed', inset: '0', width: '540px', height: '900px', zIndex: '100' }))
  for (const hide of await canvas.getByRole('button', { name: 'Hide this panel', exact: true }).all()) {
    if (await hide.isVisible()) await hide.click()
  }
  await canvas.getByRole('button', { name: 'Show sidebar', exact: true }).click()
  const floating = page.getByRole('dialog', { name: 'Sidebar', exact: true })
  await expect(floating).toBeVisible()
  expect((await box(canvas)).width).toBe(540)
  const sidebar = floating.locator('[data-region="sidebar-header"]').locator('xpath=ancestor::div[contains(@class,"sidebar_")][last()]')
  expect((await box(sidebar)).width).toBe(240)
  await expect(sidebar.locator('[data-tone="working"], [data-tone="waiting"]')).toHaveCount(0)
  const headerX = await sidebar.getByText('Projects', { exact: true }).evaluate((node) => { const range = document.createRange(); range.selectNodeContents(node); return range.getBoundingClientRect().x })
  const projectX = await sidebar.locator('[data-draggable] [data-slot="text"]').first().evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); return range.getBoundingClientRect().x })
  expect(Math.abs(headerX - projectX)).toBeLessThanOrEqual(1)
  const button = sidebar.locator('[data-slot="sidebar-menu-button"][aria-label="Room Approve the migration evidence"][data-held]')
  await button.scrollIntoViewIfNeeded()
  await page.mouse.move(539, 899)
  const label = button.locator('[data-slot="sidebar-menu-label"]'), chip = label.locator('[data-slot="chip"]')
  const full = await box(chip), labelBox = await box(label)
  const fade = await label.evaluate((node) => getComputedStyle(node).maskImage === 'none' ? 0 : Number.parseFloat(getComputedStyle(node).getPropertyValue('--hd-space-8')))
  expect(full.x + full.width).toBeLessThanOrEqual(labelBox.x + labelBox.width - fade)
  const measured = await sidebar.evaluate(measureSidebarRail)
  const count = button.locator('xpath=parent::*').locator(':scope > [data-sidebar-count]')
  expect(Math.abs(full.x + full.width - (measured.rail - (await count.isVisible() ? 24 : 0)))).toBeLessThanOrEqual(0.5)
  await expect(chip).toHaveText('Needs you')
  await button.hover()
  await expect(chip).toBeHidden()
  await expect(label.locator('[data-sidebar-menu-state-compact] [data-slot="dot"]')).toBeVisible()
  expect(await box(label)).toEqual(labelBox)
})


for (const theme of ['light', 'dark'] as const) {
  test(`every quiet state label ends on the session dot rail and stays inside its clip (${theme})`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/design.html?view=sidebar')
    const sidebar = page.locator('[data-catalog-example="sidebar"] [data-region="sidebar-header"]')
      .locator('xpath=ancestor::div[contains(@class,"sidebar_")][last()]').first()
    const measurements = []
    for (const width of [200, 260, 320, 540]) {
      await sidebar.locator('xpath=parent::*').evaluate((node, width) => { (node as HTMLElement).style.width = `${width + 2}px` }, width)
      await sidebar.evaluate(node => { (node as HTMLElement).style.width = '100%' })
      await page.mouse.move(0, 0)
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      const measured = await sidebar.evaluate(measureSidebarRail)
      measurements.push({ theme, width, ...measured })
      expect(measured.rail).toBeLessThanOrEqual(measured.sidebarRight - 20)
      expect(measured.rows.filter(row => row.chipBox).length).toBeGreaterThanOrEqual(9)
      expect(measured.rows.filter(row => row.chipBox).map(row => row.chip)).toEqual(Array(measured.rows.filter(row => row.chipBox).length).fill('Needs you'))
      for (const row of measured.rows) {
        if (row.targetRight !== null) expect.soft(Math.abs(row.targetRight - measured.targetRail), `${row.name}: trailing target at ${width}px`).toBeLessThanOrEqual(0.5)
        if (row.chipBox) {
          expect.soft(row.chipStyle, `${row.name}: plain text without a pill at ${width}px`).toEqual({
            background: 'rgba(0, 0, 0, 0)', border: '0px', shadow: 'none', paddingLeft: '0px', paddingRight: '0px',
          })
          expect.soft(Math.abs(row.textBox!.right - row.chipRail), `${row.name}: text ends on the rail at ${width}px`).toBeLessThanOrEqual(0.5)
          expect.soft(row.textBox!.left, `${row.name}: full text starts inside chip`).toBeGreaterThanOrEqual(row.chipBox.left - 0.5)
          expect.soft(row.textBox!.right, `${row.name}: full text ends inside chip`).toBeLessThanOrEqual(row.chipBox.right + 0.5)
          expect.soft(Math.abs(row.chipBox.right - row.chipRail), `${row.name}: ${row.chip} misses visible dot rail at ${width}px`).toBeLessThanOrEqual(0.5)
          expect.soft(row.chipBox.left, `${row.name}: chip starts inside clip`).toBeGreaterThanOrEqual(row.clip.left)
          expect.soft(row.chipBox.right, `${row.name}: chip ends inside clip`).toBeLessThanOrEqual(row.clip.right)
          expect.soft(row.chipBox.top).toBeGreaterThanOrEqual(row.clip.top)
          expect.soft(row.chipBox.bottom).toBeLessThanOrEqual(row.clip.bottom)
        }
      }
    }
    await testInfo.attach('every-row-rail.json', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' })
  })

  test(`owner decision: narrow count yields and the whole state uses the inset rail (${theme})`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/design.html?view=sidebar')
    const sidebar = page.locator('[data-catalog-example="sidebar"] [data-region="sidebar-header"]')
      .locator('xpath=ancestor::div[contains(@class,"sidebar_")][last()]').first()
    const room = sidebar.locator('[data-slot="sidebar-menu-button"][aria-label="Room Approve the migration evidence"][data-held]')
      .locator('xpath=ancestor::li[@data-slot="sidebar-menu-item"][1]')
    const button = room.locator(':scope > div > [data-slot="sidebar-menu-button"]')
    const title = button.locator('[data-slot="sidebar-menu-label-content"] > span > span').first()
    const chip = button.locator('[data-sidebar-menu-state-full] [data-slot="chip"]')
    const count = room.locator(':scope > div > [data-slot="sidebar-menu-badge"]')
    const action = room.locator(':scope > div > [data-slot="sidebar-menu-action"]')
    const measurements = []
    for (const width of [200, 260, 320, 540]) {
      await sidebar.locator('xpath=parent::*').evaluate((node, width) => { (node as HTMLElement).style.width = `${width + 2}px` }, width)
      await sidebar.evaluate(node => { (node as HTMLElement).style.width = '100%' })
      await room.scrollIntoViewIfNeeded()
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      await page.mouse.move(0, 0)
      const side = await box(sidebar), chipBox = await box(chip), titleBox = await box(title)
      const { rail, targetRail } = await sidebar.evaluate(measureSidebarRail)
      const countVisible = await count.isVisible()
      measurements.push({ width, sideRight: side.x + side.width, rail, chipRight: chipBox.x + chipBox.width, titleWidth: titleBox.width, countVisible })
      expect.soft(countVisible, `count yields at 200px, returns at 260px`).toBe(width > 200)
      expect.soft(titleBox.width, `title retains useful space at ${width}px`).toBeGreaterThanOrEqual(32)
      expect.soft(rail, 'visible rail is inset from the sidebar edge').toBeLessThanOrEqual(side.x + side.width - 20)
      expect.soft(Math.abs(chipBox.x + chipBox.width - (rail - (countVisible ? 24 : 0))), `whole chip ends on the available rail at ${width}px`).toBeLessThanOrEqual(0.5)
      const clip = await button.locator('[data-slot="sidebar-menu-label-content"]').evaluate(node => node.getBoundingClientRect().right - parseFloat(getComputedStyle(node).paddingRight))
      expect.soft(chipBox.x + chipBox.width, 'state is not clipped').toBeLessThanOrEqual(clip + 1)
      if (countVisible) expect.soft(intersection(chipBox, await box(count)), 'chip clears count').toBe(false)
      const before = titleBox.width
      for (const mode of ['hover', 'focus'] as const) {
        if (mode === 'hover') await button.hover()
        else await button.focus()
        await expect(chip).toBeHidden()
        await expect(action).toHaveCSS('opacity', '1')
        expect.soft((await box(title)).width, `actions never squeeze title further (${mode})`).toBeGreaterThanOrEqual(before)
        const dot = button.locator('[data-sidebar-menu-state-compact]')
        expect.soft(intersection(await box(dot), await box(action)), 'state clears action').toBe(false)
        expect.soft(Math.abs((await box(action)).x + (await box(action)).width - targetRail), 'actions keep their shared target rail').toBeLessThanOrEqual(0.5)
      }
    }
    await testInfo.attach('owner-baseline-geometry.json', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' })
    console.info('OWNER_GEOMETRY', JSON.stringify(measurements))
  })

  test(`owner decision: parent and member hover and focus reveal only their own actions (${theme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/design.html?view=sidebar')
    const nested = page.getByRole('list', { name: 'Nested row end rail' })
    const parent = nested.getByRole('button', { name: 'Release room actions', exact: true })
    const member = nested.getByRole('button', { name: 'Untitled session actions', exact: true })
    const buttons = nested.locator('[data-slot="sidebar-menu-button"]')
    for (const mode of ['hover', 'focus'] as const) {
      await page.mouse.move(0, 0)
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      if (mode === 'hover') await buttons.nth(0).hover()
      else await buttons.nth(0).focus()
      await expect.soft(parent).toHaveCSS('opacity', '1')
      await expect.soft(member).toHaveCSS('opacity', '0')
      if (mode === 'hover') await buttons.nth(1).hover()
      else await buttons.nth(1).focus()
      await expect.soft(parent).toHaveCSS('opacity', '0')
      await expect.soft(member).toHaveCSS('opacity', '1')
    }
  })
}
