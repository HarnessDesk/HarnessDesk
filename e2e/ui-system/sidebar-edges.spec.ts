import { expect, test, type Locator } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'

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

// Geometry cases inspect the full project; the cap is exercised by sidebar-structure.
const expandProjects = async (sidebar: import('@playwright/test').Locator) => {
  for (const group of await sidebar.locator('[data-project-root]').all()) {
    const more = group.getByRole('button', { name: 'Show more', exact: true })
    if (await more.count()) await more.click()
  }
  await sidebar.evaluate(node => { if (node.contains(document.activeElement)) (document.activeElement as HTMLElement).blur() })
}

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
          if (testInfo.project.use.screenshot !== 'off') await testInfo.attach(`four-marks-${width}-hover.png`, { body: await row.screenshot(), contentType: 'image/png' })
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
  const sidebars = example.locator('[data-region="sidebar-header"]').locator('xpath=ancestor::div[@data-left-column][1]')
  const state = anatomy.locator('[data-slot="sidebar-menu-state"]')
  const action = anatomy.locator('[data-slot="sidebar-menu-action"]')
  const nestedExample = example.locator('[aria-label="Nested row end rail"]')
  const sidebar = sidebars.first()
  await expandProjects(sidebar)
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

      const rows = column.locator('[data-left-row]:has([data-slot="sidebar-menu-action"])')
      expect(await rows.count()).toBeGreaterThan(0)
      for (const row of await rows.all()) {
        await row.scrollIntoViewIfNeeded()
        const opener = row.locator('[data-slot="sidebar-menu-button"]')
        const label = opener.locator('[data-slot="sidebar-menu-label-content"]')
        const trail = row.locator('[data-left-trailing]')
        const action = row.locator('[data-slot="sidebar-menu-action"]')
        expect((await box(opener)).height).toBe(FRAME.rail.rowHeight)
        expect((await box(trail)).width).toBe(24)
        const end = await box(trail)
        expect(Math.abs(end.x + end.width / 2 - (rail.x + rail.width - 28))).toBeLessThanOrEqual(1)
        const title = await opener.getAttribute('title')
        for (const mode of ['hover', 'focus'] as const) {
          await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
          await page.mouse.move(0, 0)
          const rest = await box(label)
          if (mode === 'hover') await opener.hover({ position: { x: 8, y: 12 } })
          else { await page.keyboard.press('Shift'); await opener.evaluate(node => (node as HTMLElement).focus({ preventScroll: true })) }
          await expect(action).toBeVisible()
          await expect(row.locator('[data-left-mark]')).toBeHidden()
          expect(await box(label)).toEqual(rest)
          expect(await opener.getAttribute('title')).toBe(title)
          expect(await box(action)).toEqual(end)
        }
      }
    }
  }
})

test('worktree and gone-folder priority facts survive hover, focus and an open menu', async ({ page }, testInfo) => {
  await page.goto('/design.html?view=sidebar')
  const sidebar = page.locator('[data-catalog-example="sidebar"] [data-left-column]').first()
  await expandProjects(sidebar)
  const rows = [
    sidebar.locator('[data-region="session-row"] [data-left-row]').filter({ hasText: 'Add fixtures for the refund path before extending the checkout matrix' }),
    sidebar.locator('[data-region="session-row"] [data-left-row]').filter({ hasText: 'Draft the 2.5 migration notes after reviewing the sidebar target behavior' }),
  ]
  const measurements = []
  for (const width of [200, 220, 260, 320]) {
    await sidebar.locator('..').evaluate((node, value) => { (node as HTMLElement).style.width = `${value + 2}px` }, width)
    for (const row of rows) {
      await row.scrollIntoViewIfNeeded()
      const button = row.locator('[data-slot="sidebar-menu-button"]')
      const title = await button.getAttribute('title')
      expect(title).toContain('Worktree')
      if (row === rows[1]) expect(title).toContain('The transcript can be read; nothing more can be sent.')
      await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
      await page.mouse.move(0, 0)
      const label = button.locator('[data-slot="sidebar-menu-label-content"]')
      const before = await box(label)
      const mark = row.locator('[data-left-mark]')
      if (row === rows[1]) await expect(mark).toBeVisible()
      else { await expect(mark).toHaveCount(1); await expect(mark.locator('[data-slot="spinner"]')).toHaveCount(1); expect(title).toContain('Thinking') }
      const target = await box(row.locator('[data-left-trailing]'))
      const action = row.locator('[data-slot="sidebar-menu-action"]')
      for (const focus of [false, true]) {
        if (focus) await button.focus()
        else await button.hover()
        await expect(mark).toBeHidden()
        await expect(action).toBeVisible()
        expect(await box(action)).toEqual(target)
        expect(await box(label)).toEqual(before)
        expect(await button.getAttribute('title')).toBe(title)
      }
      expect(await action.getAttribute('title')).toContain('Actions for')
      await action.click()
      await expect(page.getByRole('menu')).toBeVisible()
      await expect(action).toHaveAttribute('aria-expanded', 'true')
      await expect(mark).toBeHidden()
      expect(await box(label)).toEqual(before)
      expect(await button.getAttribute('title')).toBe(title)
      measurements.push({ width, label: before, action: await box(action), title })
      await page.keyboard.press('Escape')
      await expect(button).toBeFocused()
    }
    const side = await box(sidebar)
    const plus = sidebar.getByRole('button', { name: 'Open a project folder', exact: true })
    const centre = (target: Awaited<ReturnType<typeof box>>) => target.x + target.width / 2
    expect(Math.abs(centre(await box(plus)) - side.x - side.width + 28)).toBeLessThanOrEqual(1)
    const start = sidebar.getByRole('button', { name: 'More ways to start', exact: true })
    expect(Math.abs(centre(await box(start)) - centre(await box(plus)))).toBeLessThanOrEqual(1)
    const project = sidebar.locator('[data-project-root] [data-left-row]').filter({ has: page.locator('button[data-draggable][title*="Pinned"]') }).first()
    const opener = project.locator('button[data-draggable]')
    await project.scrollIntoViewIfNeeded()
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
    await page.mouse.move(0, 0)
    const pin = project.locator('[data-left-mark]')
    await expect(pin).toHaveCount(0)
    await expect(opener).toHaveAttribute('title', /Pinned/)
    const target = await box(project.locator('[data-left-trailing]'))
    for (const focus of [false, true]) {
      if (focus) { await page.keyboard.press('Shift'); await opener.evaluate(node => (node as HTMLElement).focus({ preventScroll: true })) }
      else await opener.hover()
      const add = project.getByRole('button', { name: /^New session in / })
      await expect(add).toBeVisible()
      await expect(pin).toHaveCount(0)
      expect(await box(add)).toEqual(target)
      await expect(project.getByRole('button', { name: /^Actions for / })).toHaveCount(0)
    }
  }
  await testInfo.attach('priority-facts.json', { body: JSON.stringify(measurements), contentType: 'application/json' })
})

test('sidebar count and state marks occupy adjacent target slots on the shared rail', async ({ page }) => {
  test.setTimeout(120_000)
  await page.route('**/src/design/explorer/main.tsx*', async route => {
    const response = await route.fetch(), source = await response.text()
    const reactUrl = /from "([^"\n]*\/react\.js[^"\n]*)"/.exec(source)?.[1]
    if (!reactUrl) throw new Error('explorer React import was not found')
    await route.fulfill({ response, body: `${source}
      import railReact from ${JSON.stringify(reactUrl)};
      import { SidebarMenu, SidebarMenuItem, SidebarMenuButton, SidebarMenuBadge, Dot, Text } from '/src/design/index.ts';
      const railHost = document.createElement('div'); railHost.setAttribute('data-count-state-rail', ''); document.body.append(railHost);
      const rh = railReact.createElement;
      createRoot(railHost).render(rh('div', { style: { display: 'grid', gridTemplateColumns: '260px minmax(0,1fr)' } },
        rh('div', null, rh(SidebarMenu, { 'aria-label': 'Count and state rail' }, rh(SidebarMenuItem, { trailingMarks: 2 },
          rh(SidebarMenuButton, { label: 'Agents' }),
          rh(SidebarMenuBadge, { style: { insetInlineEnd: 'calc(var(--sidebar-menu-end-rail) + var(--hd-sidebar-end-action-step))' } }, rh(Text, { role: 'meta' }, '5')),
          rh(SidebarMenuBadge, null, rh(Dot, { state: 'limit' })) ))), rh('div')));
    ` })
  })
  await page.goto('/design.html?view=sidebar')
  const nav = page.getByRole('list', { name: 'Count and state rail' })
  const sidebar = nav.locator('xpath=parent::*')
  const frame = sidebar.locator('xpath=parent::*')
  const row = nav.getByRole('button', { name: 'Agents' }).locator('xpath=ancestor::li[@data-slot="sidebar-menu-item"][1]')
  const marks = row.locator('[data-slot="sidebar-menu-badge"]')
  const label = row.locator('[data-slot="sidebar-menu-label"]')
  const title = label.locator('[data-slot="sidebar-menu-label-content"]')
  await title.evaluate((node) => { node.textContent = 'Agents responsible for keeping every workspace conversation available' })

  for (const width of [200, 220, 260, 320]) {
    await frame.evaluate((node, next) => { (node as HTMLElement).style.gridTemplateColumns = `${next}px minmax(0, 1fr)` }, width)
    await row.scrollIntoViewIfNeeded()
    const sidebarBox = await box(sidebar)
    const column = await row.evaluate(node => { const badge = node.querySelector('[data-slot="sidebar-menu-badge"]')!; const style = getComputedStyle(badge); const origin = node.getBoundingClientRect(); return origin.right - parseFloat(getComputedStyle(node.querySelectorAll('[data-slot="sidebar-menu-badge"]')[1]!).insetInlineEnd) - parseFloat(style.width) / 2 })
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

test('real session and Team rows preserve full facts and one priority slot', async ({ page }) => {
  await page.goto('/design.html?view=sidebar')
  const sidebar = page.locator('[data-catalog-example="sidebar"] [data-left-column]').first()
  await expandProjects(sidebar)
  const session = sidebar.locator('[data-region="session-row"] [data-left-row]')
    .filter({ hasText: 'Pin the flaky inventory test after reconciling every retry branch' })
  const team = sidebar.locator('[data-virtual-key^="room:"] button[aria-label="Room Approve the migration evidence"][title*="held messages"]')
  const room = team.locator('..')
  await expect(session).toHaveCount(1)
  await expect(session.locator('[data-left-mark]')).toHaveAttribute('aria-label', 'Needs you')
  expect(await session.locator('[data-slot="sidebar-menu-button"]').getAttribute('title')).toContain('Worktree')
  await expect(room.locator('[data-left-mark]')).toHaveAttribute('aria-label', 'Needs you')
  expect(await team.getAttribute('title')).toContain('1 held message')
  await expect(room.locator('[data-slot="sidebar-menu-action"]')).toHaveCount(0)
  await expect(sidebar.locator('[data-nested="true"]')).toHaveCount(0)
  for (const width of [200, 260, 320]) {
    await sidebar.locator('..').evaluate((node, value) => { (node as HTMLElement).style.width = `${value + 2}px` }, width)
    for (const row of [room, session]) {
      await row.scrollIntoViewIfNeeded()
      const opener = row.locator('[data-slot="sidebar-menu-button"]')
      const label = opener.locator('[data-slot="sidebar-menu-label-content"]')
      await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
      await page.mouse.move(0, 0)
      const before = await box(label)
      await expect(row.locator('[data-left-mark]')).toHaveCount(1)
      const mark = await box(row.locator('[data-left-mark]'))
      const bounds = await box(opener)
      expect(bounds.height).toBe(FRAME.rail.rowHeight)
      expect(mark.x + mark.width).toBeLessThanOrEqual(bounds.x + bounds.width)
      for (const mode of ['hover', 'focus'] as const) {
        if (mode === 'hover') await opener.hover()
        else { await page.keyboard.press('Shift'); await opener.evaluate(node => (node as HTMLElement).focus({ preventScroll: true })) }
        expect(await box(label)).toEqual(before)
        if (row === session) {
          await expect(row.locator('[data-left-mark]')).toBeHidden()
          const action = row.locator('[data-slot="sidebar-menu-action"]')
          await expect(action).toBeVisible()
          expect(await box(action)).toEqual(await box(row.locator('[data-left-trailing]')))
        } else await expect(row.locator('[data-left-mark]')).toBeVisible()
      }
    }
  }
})

test('nested board and Team parent keep trailing marks on their own label line', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto('/design.html?view=sidebar')
  const example = page.locator('[data-catalog-example="sidebar"]')
  const anatomy = example.locator('[aria-label="Sidebar trailing slot anatomy"]')
  const nestedList = example.locator('[aria-label="Nested row end rail"]')
  const sidebars = example.locator('[data-region="sidebar-header"]').locator('xpath=ancestor::div[@data-left-column][1]')
  const sidebar = sidebars.first()
  await expandProjects(sidebar)
  const frame = sidebar.locator('xpath=parent::*')
  const productRoom = sidebar.locator('[data-virtual-key^="room:"] button[aria-label="Room Approve the migration evidence"][title*="held messages"]').locator('..')

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
  await expect(productRoom.locator('[data-slot="sidebar-menu-action"], [data-nested="true"]')).toHaveCount(0)
  const button = productRoom.locator('[data-slot="sidebar-menu-button"]')
  const mark = productRoom.locator('[data-left-mark]')
  for (const mode of ['rest', 'hover'] as const) {
    if (mode === 'hover') await button.hover()
    const line = await box(button.locator('[data-slot="sidebar-menu-label"]'))
    const target = await box(mark)
    expect(Math.abs(target.y + target.height / 2 - line.y - line.height / 2)).toBeLessThanOrEqual(1)
  }
})

// These are shipped Sidebar, SessionTree and AppWindow rows, not anatomy specimens.
test('real section headers start at the shared icon edge', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto('/design.html?view=sidebar')
  const sidebar = page.locator('[data-catalog-example="sidebar"] [data-region="sidebar-header"]')
    .locator('xpath=ancestor::div[@data-left-column][1]').first()
  const frame = sidebar.locator('xpath=parent::*')
  await expect(sidebar.locator('[data-tone="working"], [data-tone="waiting"]')).toHaveCount(0)
  await expect(sidebar.getByText('Pinned · 1', { exact: true })).toBeVisible()
  for (const width of [200, 220, 260, 320, 520]) {
    await frame.evaluate((node, next) => { const css = getComputedStyle(node); (node as HTMLElement).style.width = `${next + Number.parseFloat(css.borderLeftWidth) + Number.parseFloat(css.borderRightWidth)}px` }, width)
    await sidebar.evaluate((node) => { (node as HTMLElement).style.width = '100%' })
    const icon = sidebar.locator('[data-region="session-row"] [data-slot="sidebar-menu-icon"]').first()
    const iconX = (await box(icon)).x
    const ordinaryName = sidebar.locator('[data-region="session-row"] [data-slot="sidebar-menu-label-content"]').first()
    const textX = await ordinaryName.evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); return range.getBoundingClientRect().x })
    for (const header of [sidebar.getByText('Projects', { exact: true })]) {
      const x = await header.evaluate((node) => {
        const range = document.createRange(); range.selectNodeContents(node)
        return range.getBoundingClientRect().x
      })
      expect.soft(Math.abs(x - iconX), `${await header.textContent()} at ${width}px: header x=${x}, row icon x=${iconX}`).toBeLessThanOrEqual(1)
    }
    for (const group of await sidebar.locator('[data-left-group]').all()) {
      const header = group.locator('[data-left-group-text]')
      if (await header.count() === 0) continue
      const x = await header.evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); return range.getBoundingClientRect().x })
      const rowX = (await box(group.locator('[data-slot="sidebar-menu-icon"]').first())).x
      expect.soft(Math.abs(x - rowX), `${await header.textContent()} at ${width}px`).toBeLessThanOrEqual(1)
    }
    // Foldable group names begin at the ordinary icon edge; their disclosure follows the name.
    const other = sidebar.getByRole('button', { name: 'Other projects', exact: true }).locator('[data-slot="sidebar-menu-label-content"]')
    const otherX = await other.evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); return range.getBoundingClientRect().x })
    expect.soft(Math.abs(otherX - iconX), `Other projects at ${width}px`).toBeLessThanOrEqual(1)
  }
  await page.goto('/preview.html?frame-wall=settings')
  const nav = page.getByRole('navigation', { name: 'Settings navigation' })
  const navFrame = nav.locator('[data-left-group]').first().locator('xpath=ancestor::div[@data-region="sidebar-content"][1]')
  for (const width of [200, 220, 260, 320, 520]) {
    await navFrame.evaluate((node, next) => { (node as HTMLElement).style.width = `${next}px` }, width)
    for (const group of await nav.locator('[data-left-group]').all()) {
      const header = group.locator('[data-left-group-text]')
      const icon = group.locator('[data-slot="sidebar-menu-icon"]').first()
      const x = await header.evaluate((node) => { const range = document.createRange(); range.selectNodeContents(node); return range.getBoundingClientRect().x })
      expect.soft(Math.abs(x - (await box(icon)).x), `Settings ${await header.textContent()} at ${width}px`).toBeLessThanOrEqual(1)
    }
  }
})

test('real waiting Team keeps the priority mark and all held-message facts at every width', async ({ page }, testInfo) => {
  await page.goto('/design.html?view=sidebar')
  const sidebar = page.locator('[data-catalog-example="sidebar"] [data-left-column]').first()
  await expandProjects(sidebar)
  const team = sidebar.locator('[data-virtual-key^="room:"] button[aria-label="Room Approve the migration evidence"][title*="held messages"]')
  const row = team.locator('..')
  const measurements = []
  for (const width of [200, 220, 260, 320, 520]) {
    await sidebar.locator('..').evaluate((node, value) => { (node as HTMLElement).style.width = `${value + 2}px` }, width)
    await team.scrollIntoViewIfNeeded()
    const title = await team.getAttribute('title')
    expect(title).toContain('Needs you')
    expect(title).toContain('1 held message')
    await expect(row.locator('[data-left-mark]')).toHaveCount(1)
    await expect(row.locator('[data-left-mark]')).toHaveAttribute('aria-label', 'Needs you')
    const label = team.locator('[data-slot="sidebar-menu-label-content"]')
    const before = await box(label)
    for (const mode of ['hover', 'focus'] as const) {
      if (mode === 'hover') await team.hover()
      else await team.focus()
      await expect(row.locator('[data-left-mark]')).toBeVisible()
      expect(await box(label)).toEqual(before)
      expect(await team.getAttribute('title')).toBe(title)
    }
    expect(await sidebar.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
    measurements.push({ width, label: before, mark: await box(row.locator('[data-left-mark]')) })
  }
  await testInfo.attach('waiting-team.json', { body: JSON.stringify(measurements), contentType: 'application/json' })
})

test('real header glyph ink occupies the end rail and its adjacent target columns', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto('/design.html?view=sidebar')
  const sidebar = page.locator('[data-catalog-example="sidebar"] [data-region="sidebar-header"]')
    .locator('xpath=ancestor::div[@data-left-column][1]').first()
  const frame = sidebar.locator('xpath=parent::*')
  const header = sidebar.locator('[data-left-projects-head]')
  for (const width of [200, 220, 260, 320, 520]) {
    await frame.evaluate((node, next) => {
      const css = getComputedStyle(node)
      ;(node as HTMLElement).style.width = `${next + Number.parseFloat(css.borderLeftWidth) + Number.parseFloat(css.borderRightWidth)}px`
    }, width)
    await sidebar.evaluate((node) => { (node as HTMLElement).style.width = '100%' })
    const side = await box(sidebar)
    expect(side.width).toBe(width)
    const rail = side.x + side.width - 28
    const plus = header.getByRole('button', { name: 'Open a project folder', exact: true }).locator('svg')
    const display = header.getByRole('button', { name: 'How this list is shown', exact: true }).locator('svg')
    const filter = header.locator('[data-slot="search"] svg')
    for (const [glyph, slot, name] of [[plus, 0, '+'], [display, 1, 'display'], [filter, 2, 'filter']] as const) {
      const ink = await box(glyph)
      const delta = ink.x + ink.width / 2 - (rail - slot * 26)
      expect.soft(Math.abs(delta), `header ${name} SVG centre misses rail slot ${slot} by ${delta}px at ${width}px`).toBeLessThanOrEqual(1)
    }
  }
})

test('real working worktree spins while keeping activity and checkout facts on hover', async ({ page }) => {
  await page.goto('/design.html?view=sidebar')
  const sidebar = page.locator('[data-catalog-example="sidebar"] [data-left-column]').first()
  await expandProjects(sidebar)
  const active = sidebar.locator('[data-region="session-row"] [data-left-row]')
    .filter({ hasText: 'Add fixtures for the refund path before extending the checkout matrix' })
  const opener = active.locator('[data-slot="sidebar-menu-button"]')
  await expect(active).toHaveCount(1)
  expect(await opener.getAttribute('title')).toContain('Worktree')
  expect(await opener.getAttribute('title')).toContain('Thinking')
  await expect(active.locator('[data-left-mark]')).toHaveCount(1)
  await expect(active.locator('[data-slot="spinner"]')).toHaveCount(1)
  for (const width of [200, 220, 260, 320, 520]) {
    await sidebar.locator('..').evaluate((node, value) => { (node as HTMLElement).style.width = `${value + 2}px` }, width)
    await active.scrollIntoViewIfNeeded()
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
    await page.mouse.move(0, 0)
    const mark = active.locator('[data-left-mark]')
    await expect(mark).toHaveCount(1)
    await expect(opener).toHaveAttribute('title', /Thinking/)
    const before = await box(opener.locator('[data-slot="sidebar-menu-label-content"]'))
    const target = await box(active.locator('[data-left-trailing]'))
    for (const mode of ['hover', 'focus'] as const) {
      if (mode === 'hover') await opener.hover({ position: { x: 8, y: 12 } })
      else { await page.keyboard.press('Shift'); await opener.evaluate(node => (node as HTMLElement).focus({ preventScroll: true })) }
      await expect(mark).toBeHidden()
      const action = active.locator('[data-slot="sidebar-menu-action"]')
      await expect(action).toBeVisible()
      expect(await box(action)).toEqual(target)
      expect(await box(opener.locator('[data-slot="sidebar-menu-label-content"]'))).toEqual(before)
    }
  }
})

test('540px window floats the real sidebar with aligned headers and a Needs you mark', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 540, height: 900 })
  await page.goto('/preview.html?frame-wall=conversation&sidebar-geometry')
  const canvas = page.locator('[data-slot="fixed-shell"]')
  // The wall mounts B's real FixedShell at the actual viewport width.
  for (const hide of await canvas.getByRole('button', { name: 'Hide this panel', exact: true }).all()) {
    if (await hide.isVisible()) await hide.click()
  }
  await canvas.getByRole('button', { name: 'Show sidebar', exact: true }).click()
  const floating = page.getByRole('dialog', { name: 'Sidebar', exact: true })
  await expect(floating).toBeVisible()
  expect((await box(canvas)).width).toBe(540)
  const sidebar = floating.locator('[data-region="sidebar-header"]').locator('xpath=ancestor::div[@data-left-column][1]')
  await expandProjects(sidebar)
  expect((await box(sidebar)).width).toBe(FRAME.sidebar.width)
  await expect(sidebar.locator('[data-tone="working"], [data-tone="waiting"]')).toHaveCount(0)
  const headerX = await sidebar.getByText('Projects', { exact: true }).evaluate((node) => { const range = document.createRange(); range.selectNodeContents(node); return range.getBoundingClientRect().x })
  const projectX = await sidebar.locator('[data-draggable] [data-slot="sidebar-menu-label-content"]').first().evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); return range.getBoundingClientRect().x })
  expect(Math.abs(headerX - projectX)).toBeLessThanOrEqual(1)
  const button = sidebar.locator('[data-virtual-key^="room:"] button[aria-label="Room Approve the migration evidence"][title*="held messages"]')
  await button.scrollIntoViewIfNeeded()
  await page.mouse.move(539, 899)
  const label = button.locator('[data-slot="sidebar-menu-label-content"]')
  const before = await box(label)
  const mark = button.locator('..').locator('[data-left-mark]')
  await expect(mark).toHaveAttribute('aria-label', 'Needs you')
  expect(await button.getAttribute('title')).toContain('1 held message')
  const bounds = await box(button), target = await box(mark)
  expect(bounds.height).toBe(FRAME.rail.rowHeight)
  expect(target.x + target.width).toBeLessThanOrEqual(bounds.x + bounds.width)
  await button.hover()
  await expect(mark).toBeVisible()
  expect(await box(label)).toEqual(before)
  expect(await sidebar.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
})


for (const theme of ['light', 'dark'] as const) {
  test(`every production work row shares the exact trail and label edges (${theme})`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/design.html?view=sidebar')
    const sidebar = page.locator('[data-catalog-example="sidebar"] [data-left-column]').first()
    await expandProjects(sidebar)
    const measurements = []
    for (const width of [200, 260, 320, 540]) {
      await sidebar.locator('..').evaluate((node, value) => { (node as HTMLElement).style.width = `${value + 2}px` }, width)
      const rows = await sidebar.locator('[data-region="session-tree"] [data-left-row]').evaluateAll(nodes => nodes.map(node => {
        const button = node.querySelector<HTMLElement>('[data-slot="sidebar-menu-button"]')!
        const label = node.querySelector('[data-slot="sidebar-menu-label-content"]')!.getBoundingClientRect()
        const trail = node.querySelector('[data-left-trailing]')!.getBoundingClientRect()
        const bounds = button.getBoundingClientRect()
        const icon = node.querySelector('[data-slot="sidebar-menu-icon"]')?.getBoundingClientRect()
        return { name: node.querySelector('[data-slot="sidebar-menu-label-content"]')!.textContent, title: button.title, height: bounds.height,
          project: node.hasAttribute('data-left-project'), fold: button.hasAttribute('aria-expanded') && !node.querySelector('[data-left-disclosure]'), icon: icon?.x ?? null, iconWidth: icon?.width ?? null, label: label.x, trail: trail.x + trail.width / 2, target: trail.width,
          marks: node.querySelectorAll('[data-left-mark]').length }
      }))
      expect(rows.length).toBeGreaterThan(9)
      const ordinary = rows.find(row => !row.project)!
      expect(ordinary).toBeDefined()
      for (const row of rows) {
        expect(row.height).toBe(FRAME.rail.rowHeight)
        expect(row.target).toBe(24)
        expect(Math.abs(row.label - (row.fold ? ordinary.icon : ordinary.label))).toBeLessThanOrEqual(1)
        if (row.fold) expect(row.icon).toBeNull()
        else { expect(row.iconWidth).toBe(FRAME.rail.icon); expect(Math.abs(row.icon! - ordinary.icon!)).toBeLessThanOrEqual(1) }
        expect(Math.abs(row.trail - rows[0]!.trail)).toBeLessThanOrEqual(1)
        expect(row.marks).toBeLessThanOrEqual(1)
        expect(row.title.length).toBeGreaterThan(0)
      }
      expect(await sidebar.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
      measurements.push({ theme, width, rows })
    }
    await testInfo.attach('every-left-row.json', { body: JSON.stringify(measurements), contentType: 'application/json' })
  })

  test(`waiting priority preserves the held count in full facts at narrow widths (${theme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/design.html?view=sidebar')
    const sidebar = page.locator('[data-catalog-example="sidebar"] [data-left-column]').first()
    await expandProjects(sidebar)
    const button = sidebar.locator('[data-virtual-key^="room:"] button[aria-label="Room Approve the migration evidence"][title*="held messages"]')
    const row = button.locator('..')
    for (const width of [200, 260, 320, 540]) {
      await sidebar.locator('..').evaluate((node, value) => { (node as HTMLElement).style.width = `${value + 2}px` }, width)
      await button.scrollIntoViewIfNeeded()
      const label = button.locator('[data-slot="sidebar-menu-label-content"]')
      const before = await box(label)
      expect(before.width).toBeGreaterThanOrEqual(32)
      expect(await button.getAttribute('title')).toContain('1 held message')
      expect(await button.getAttribute('title')).toContain('Needs you')
      await expect(row.locator('[data-left-mark]')).toHaveCount(1)
      await expect(row.locator('[data-left-mark]')).toHaveAttribute('aria-label', 'Needs you')
      for (const mode of ['hover', 'focus'] as const) {
        if (mode === 'hover') await button.hover()
        else await button.focus()
        await expect(row.locator('[data-left-mark]')).toBeVisible()
        await expect(row.locator('[data-slot="sidebar-menu-action"]')).toHaveCount(0)
        expect(await box(label)).toEqual(before)
      }
    }
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
