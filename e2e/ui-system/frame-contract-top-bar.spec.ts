import { expect, test, type Locator } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'
import { WALL_THEMES, WALL_WIDTHS } from './frame-wall-destinations'
import { settleFrameBar } from './frame-actions'
import { expectMenuGeometry, openFrame } from './frame-contract-helpers'
import { expectTitleRoom } from './title-contract'
import { applyFrameActions, selectFrameTab } from './frame-actions'

// Contract runs measure the synthetic preview; the final wall owns frames.
test.use({ screenshot: 'off', trace: 'off', video: 'off' })

/** Every actual destination shares this bar, including the detail pages. */
const destinations = [
  { id: 'work bar example', query: 'frame-wall=topbar', work: true },
  { id: 'account bar example', query: 'frame-wall=topbar&frame-parents=1', work: false },
  { id: 'draft', query: 'frame-wall=draft', work: true },
  { id: 'conversation', query: 'frame-wall=conversation', work: true },
  { id: 'Team', query: 'frame-wall=team', work: true },
  { id: 'trigger Team', query: 'frame-wall=team-trigger', work: true },
  { id: 'receipt Team', query: 'frame-wall=team-receipt', work: true },
  { id: 'Teams', query: 'frame-wall=teams', work: false },
  { id: 'Agents', query: 'frame-wall=agents', work: false },
  { id: 'Agent', query: 'frame-wall=agents&frame-detail=agent', work: false },
  { id: 'Library', query: 'frame-wall=library', work: false },
  { id: 'Plugins', query: 'frame-wall=plugins', work: false },
  { id: 'Plugin', query: 'frame-wall=plugins&frame-plugin-page=detail', work: false },
  { id: 'Dashboard', query: 'frame-wall=dashboard', work: false },
  { id: 'Settings', query: 'frame-wall=settings', work: false },
  { id: 'Runtime', query: 'frame-wall=settings&frame-detail=runtime', work: false },
  { id: 'Account', query: 'frame-wall=settings&frame-detail=account', work: false },
  { id: 'Project', query: 'frame-wall=settings&frame-detail=project', work: false },
  { id: 'Skill', query: 'frame-wall=settings&frame-detail=skill', work: false },
  { id: 'Changes review', query: 'frame-wall=changes-review', work: false },
] as const

const expectOneBar = async (bar: Locator, work: boolean) => {
  await expect(bar).toBeVisible()
  await settleFrameBar(bar)
  await expect(bar.locator('[role="tab"], [data-topbar="tabs"], [data-topbar="view"], [data-topbar="verb"], [data-topbar-crumb], [data-topbar-parent]')).toHaveCount(0)
  await expect(bar.locator('[data-slot="chip"], [data-slot="badge"], [data-count]')).toHaveCount(0)
  const worded = await bar.locator('button').evaluateAll(nodes => nodes
    .filter(node => !node.closest('[data-topbar-title]'))
    .filter(node => node.getBoundingClientRect().width > 0 && getComputedStyle(node).visibility !== 'hidden')
    .map(node => node.textContent?.trim()).filter(Boolean))
  expect(worded, 'only the subject title is a worded button').toEqual([])
  await expect(bar.locator('[data-work-panel-toggle]')).toHaveCount(0)
  await expect(bar.getByRole('button', { name: 'Activity', exact: true })).toHaveCount(0)
  await expect(bar.getByRole('button', { name: 'Details', exact: true })).toHaveCount(0)
  expect(Math.round((await bar.locator('..').boundingBox())!.height)).toBe(FRAME.bar.height)
  const destination = bar.page().locator('[data-page-destination]:visible')
  if (await destination.count()) {
    await expect(bar.locator('[data-topbar-title]')).toHaveCount(0)
    const canvas = await destination.locator('[data-slot="page"]').first().getAttribute('data-width') === 'canvas'
    await expect(destination.getByRole('heading', { level: 1 })).toHaveCount(canvas ? 0 : 1)
  } else await expectTitleRoom(bar.locator('[data-topbar-title]'))
  if (work) {
    expect(await bar.locator('[data-work-tool]').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')))).toEqual(['Terminal', 'Changes', 'Browser', 'Files'])
    await expect(bar.getByRole('button', { name: 'Toggle rail', exact: true })).toHaveCount(1)
    await expect(bar.locator('[data-work-tools-divider]')).toHaveCount(1)
  } else await expect(bar.locator('[data-work-tool], [data-work-rail-toggle], [data-topbar="state"]')).toHaveCount(0)
}

for (const theme of WALL_THEMES) for (const destination of destinations) {
  test(`one bar has no tabs, worded actions, counts or back arrow on ${destination.id} in ${theme}`, async ({ page }) => {
    await openFrame(page, destination.query, theme)
    const bars = page.locator('[data-slot="top-bar"]:visible')
    expect(await bars.count(), `${destination.id} mounts its real bar`).toBeGreaterThan(0)
    for (const bar of await bars.all()) await expectOneBar(bar, destination.work)
  })
}

for (const theme of WALL_THEMES) {
  test(`catalog bar examples follow the work and page contracts in ${theme}`, async ({ page }) => {
    await page.goto(`/design.html?view=top-bar&theme=${theme}`)
    const bars = page.locator('[data-slot="top-bar"]:visible')
    await expect(bars).toHaveCount(4)
    for (let index = 0; index < 4; index += 1) await expectOneBar(bars.nth(index), index % 2 === 0)
    await expect(page.locator('[data-slot="page-options"]:visible').getByRole('button', { name: 'Decide this run', exact: true })).toHaveCount(2)
    await expect(page.locator('[data-slot="page-options"]:visible').getByRole('button', { name: 'New Team', exact: true })).toHaveCount(2)
  })

  test(`the session state dot precedes a short title and its verbs in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation&frame-short-title=1', theme)
    const bar = page.locator('[data-slot="top-bar"]:visible'), title = bar.locator('[data-topbar-title]')
    const dot = bar.locator('[data-topbar="state"] [aria-label="Idle"]')
    await expect(dot).toBeVisible()
    const stateBox = (await dot.boundingBox())!, titleBox = (await title.boundingBox())!
    expect([stateBox.width, stateBox.height]).toEqual([8, 8])
    // The ghost button's hit padding reaches into the gap; its words follow
    // the dot, while the title's whole hit target keeps the intrinsic cap.
    const words = (await title.locator('[data-slot="text"]').boundingBox())!
    expect(stateBox.x + stateBox.width).toBeLessThan(words.x)
    expect(titleBox.width).toBeLessThanOrEqual(FRAME.bar.titleMax)
    await expect(title).toContainText('Extract the address form')
    await title.getByRole('button').click()
    for (const name of ['Rename', 'Fork', 'Archive']) await expect(page.getByRole('menu').getByRole('menuitem', { name, exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(title.getByRole('button')).toBeFocused()
  })

  test(`Team subject verbs stay under its title at native width in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=team', theme, 720)
    const bar = page.locator('[data-slot="top-bar"]:visible')
    await expectOneBar(bar, true)
    await bar.locator('[data-topbar-title]').getByRole('button').click()
    for (const name of ['Rename', 'Run again…', 'Wrap…', 'Stop run…']) await expect(page.getByRole('menu').getByRole('menuitem', { name, exact: true })).toBeVisible()
    await expectMenuGeometry(page.locator('[data-slot="popover-popup"]:visible'))
  })

  test(`Customize keeps its choices and Add skill in the page body in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=library', theme)
    const bar = page.locator('[data-slot="top-bar"]:visible')
    await expectOneBar(bar, false)
    await expect(bar.locator('[data-topbar-title]')).toHaveCount(0)
    await expect(page.locator('[data-page-destination="library"]:visible h1')).toHaveText('Customize')
    const author = page.getByRole('button', { name: 'Add skill', exact: true })
    await expect(author).toBeVisible()
    expect(await author.evaluate(node => node.closest('[data-slot="top-bar"]'))).toBeNull()
    await expect(page.locator('[data-slot="page-options"]')).toBeVisible()
  })

  test(`Findings body keeps its count agreement and decision refusal in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=team', theme, 720)
    await selectFrameTab(page, 'findings')
    const findings = page.locator('[data-slot="task-navigation"]').getByRole('button', { name: /^Findings(?:\s|$)/ })
    await expect(findings).toBeVisible()
    await expect(findings).toHaveAttribute('aria-pressed', 'true')
    await expect(findings).toContainText('3')
    const summary = page.locator('[aria-label="Findings summary"]')
    await expect(summary).toBeVisible()
    expect(await summary.locator('[data-slot="summary-item"]').evaluateAll(nodes => nodes.map(node => [
      node.querySelector('dt')?.textContent, node.querySelector('[data-slot="summary-value"]')?.textContent,
    ]))).toEqual([['Open', '3'], ['Blocking', '3'], ['All', '3']])
    await expect(page.locator('[data-slot="workbench-main"]')).not.toContainText('No findings recorded')
    const action = page.locator('[data-slot="page-options"]:visible').getByRole('button', { name: 'Decide this run', exact: true })
    const refusal = await action.getAttribute('title')
    expect(refusal?.trim()).toBeTruthy()
    for (const filter of ['All', 'Open', 'Blocking']) {
      await applyFrameActions(page, { viewChoice: filter })
      await expect(action).toBeDisabled()
      await expect(action).toHaveAttribute('title', refusal!)
      expect(await action.evaluate(node => node.closest('[data-slot="top-bar"]'))).toBeNull()
    }
  })

  for (const width of WALL_WIDTHS) {
    test(`session tasks live in the independent rail at ${width} in ${theme}`, async ({ page }) => {
      await openFrame(page, 'frame-wall=conversation&frame-status=tasks', theme, width)
      const bar = page.locator('[data-slot="top-bar"]:visible'), toggle = bar.getByRole('button', { name: 'Toggle rail', exact: true })
      const rail = page.locator('[data-frame-region="rail"]:visible')
      if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
      await expect(rail).toBeVisible()
      expect(await rail.locator('[data-slot="tool-section"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')))).toEqual(['Conversation', 'Seat record', 'Background tasks', 'Trajectory'])
      await expect(rail.getByRole('region', { name: 'Seat record', exact: true }).getByRole('button', { name: 'Seat record', exact: true })).toHaveAttribute('aria-expanded', 'false')
      await expect(rail.getByRole('region', { name: 'Background tasks', exact: true })).toContainText('Review the checkout')
      await expect(rail.getByRole('region', { name: 'Trajectory', exact: true }).locator('[data-slot="tool-section-fold"]')).toHaveAttribute('aria-expanded', 'false')
      await expect(rail.getByRole('region', { name: 'Events', exact: true })).toHaveCount(0)
      await toggle.click()
      await expect(rail).toHaveCount(0)
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    })

    test(`pane doors toggle one pane and keep their bar geometry at ${width} in ${theme}`, async ({ page }) => {
      await openFrame(page, 'frame-wall=conversation', theme, width)
      // The narrow pane hides this retained bar until Close/Return is used.
      const bar = page.locator('[data-slot="top-bar"]'), doors = bar.locator('[data-work-tool]')
      const read = () => doors.evaluateAll(nodes => nodes.map(node => {
        const box = node.getBoundingClientRect(), edge = node.closest('[data-slot="top-bar"]')!.getBoundingClientRect()
        return { x: box.x - edge.right, y: box.y - edge.top, width: box.width, height: box.height }
      }))
      const before = await read()
      for (const box of before) expect([box.width, box.height]).toEqual([FRAME.bar.iconButton, FRAME.bar.iconButton])
      for (let index = 1; index < before.length; index += 1) expect(before[index]!.x - before[index - 1]!.x).toBe(FRAME.bar.iconButton + FRAME.bar.toolGap)
      const changes = bar.locator('[data-work-tool="changes"]')
      await changes.click()
      await expect(changes).toHaveAttribute('aria-pressed', 'true')
      await expect(changes).toHaveCSS('box-shadow', 'none')
      const muted = await changes.evaluate(node => {
        const probe = document.createElement('span'); probe.style.backgroundColor = 'var(--hd-muted)'; node.append(probe)
        const color = getComputedStyle(probe).backgroundColor; probe.remove(); return color
      })
      await expect(changes).toHaveCSS('background-color', muted)
      const pane = page.locator('[data-slot="work-tools"]:visible')
      await expect(pane).toBeVisible()
      await expect(pane.getByRole('tab', { name: 'History', exact: true })).toBeVisible()
      // A full-height pane shortens the bar; its doors keep the same pitch
      // and right inset within that bar, as the approved regions require.
      expect(await read()).toEqual(before)
      if (width < FRAME.fold.panelFloats) await page.locator('[data-frame-region="right"]').getByRole('button', { name: 'Close pane', exact: true }).click()
      else await changes.click()
      await expect(changes).toHaveAttribute('aria-pressed', 'false')
      await expect(pane).toHaveCount(0)
    })

    test(`terminal stays available from More and its keyboard control at ${width} in ${theme}`, async ({ page }) => {
      await openFrame(page, 'frame-wall=team', theme, width)
      await expect(page.locator('[data-slot="status-bar"], [data-frame-region="status"]')).toHaveCount(0)
      const bar = page.locator('[data-slot="top-bar"]:visible')
      await bar.getByRole('button', { name: 'More', exact: true }).click()
      const item = page.getByRole('menuitemradio', { name: /Terminal/ })
      await expect(item).toContainText('⌃`')
      await item.click()
      const terminal = page.locator('[data-terminal-id]:visible')
      await expect(terminal).toBeVisible()
      await expect(page.getByRole('menu')).toHaveCount(0)
      if (width < FRAME.fold.panelFloats) await page.getByRole('button', { name: 'Close pane', exact: true }).click()
      else await bar.getByRole('button', { name: 'Terminal', exact: true }).click()
      await expect(terminal).toHaveCount(0)
      await page.locator('[data-slot="workbench-main"] [data-pane-id]').first().focus()
      await page.keyboard.press('Control+Backquote')
      await expect(terminal).toBeVisible()
    })
  }

  test(`connection Banner clears and the update row stays above the seat in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=team&frame-status=reconnecting', theme, 720)
    await expect(page.locator('[data-shell-host="main-notice"]')).toContainText('Reconnecting to HarnessDesk.')
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('harnessdesk:preview-connection', { detail: 'open' })))
    await expect(page.locator('[data-shell-host="main-notice"] [role="status"]')).toHaveCount(0)
    await openFrame(page, 'frame-wall=conversation&frame-update=1', theme)
    const update = page.getByRole('button', { name: 'Relaunch to update', exact: true })
    await expect(update).toBeVisible()
    const seat = (await page.locator('[data-left-seat]').boundingBox())!, row = (await update.boundingBox())!
    expect(row.height).toBe(FRAME.rail.rowHeight)
    expect(row.y + row.height).toBeLessThanOrEqual(seat.y)
    await update.click()
    await expect(update).toHaveCount(0)
  })
}
