import { measureDestination, expectPageJourney } from './frame-page-contract'
import { applySettingsNavigationActions } from './left-column-actions'
import { applyLeftColumnActions } from './left-column-actions'
import { openWallDestination } from './frame-wall-actions'
import { installFramePreviewFixture } from './frame-preview-fixture'
import { selectRunView } from './run-frame-actions'
import { expect, test, type Page } from '@playwright/test'
import { FRAME, FRAME_TOKENS } from '../../packages/ui/src/design/frame'
import { WALL_DESTINATIONS, WALL_THEMES, WALL_WIDTHS } from './frame-wall-destinations'
import { applyFrameActions, selectFrameTab } from './frame-actions'

// Contract runs measure the preview; the final wall owns images and recordings.
test.use({ screenshot: 'off', trace: 'off', video: 'off' })

/**
 * The rendered check (spec, "How it is checked"): the app measured against
 * the frame contract in `packages/ui/src/design/frame.ts`. Each phase of the
 * frame work adds what it moved; nothing here is a literal of its own.
 */
const openFrame = async (page: Page, query: string, theme: 'light' | 'dark', width = 1440) => {
  await installFramePreviewFixture(page)
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

for (const theme of WALL_THEMES) for (const filter of ['All', 'Open', 'Blocking']) {
  test(`B11 native-width lead folds the Findings ${filter} verb last in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=team', theme, 720)
    await applyFrameActions(page, { tab: 'findings', viewChoice: filter })
    const bar = page.locator('[data-slot="top-bar"]:visible').first()
    const verb = bar.locator('[data-topbar="verb"] button')
    await expect(verb).toHaveText('Decide this run')
    const refusal = await verb.getAttribute('title')
    const fixed = bar.locator('[data-topbar="view"] button, [data-work-tool], [data-topbar="more"] button')
    const positions = await fixed.evaluateAll(nodes => nodes.map(node => ({ x: node.getBoundingClientRect().x, width: node.getBoundingClientRect().width })))
    // Match the measured native traffic-light reserve, without changing app
    // tokens or the browser preview's ordinary corner policy.
    await bar.evaluate(node => { node.closest('header')!.style.paddingLeft = '78px' })
    await expect.poll(async () => (await bar.locator('[data-topbar-title]').boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(FRAME.bar.titleMin)
    await expect(bar).toHaveAttribute('data-fold', '3')
    expect((await bar.locator('[data-topbar-title]').boundingBox())!.x).toBe(112)
    await expect(bar.locator('[data-topbar="lead"] button')).toHaveCount(1)
    await expect(verb).toHaveCount(0)
    await expect(bar.locator('[data-work-tool]')).toHaveCount(4)
    expect(await fixed.evaluateAll(nodes => nodes.map(node => ({ x: node.getBoundingClientRect().x, width: node.getBoundingClientRect().width })))).toEqual(positions)
    await bar.getByRole('button', { name: 'More', exact: true }).click()
    const first = page.getByRole('menu').getByRole('menuitem').first()
    await expect(first.getByText('Decide this run', { exact: true })).toBeVisible()
    await expect(first).toHaveAttribute('aria-disabled', 'true')
    expect(await first.evaluate(node => node.nextElementSibling?.getAttribute('role'))).toBe('separator')
    expect(await first.evaluate(node => document.getElementById(node.getAttribute('aria-describedby')!)?.textContent)).toBe(refusal)
    await page.keyboard.press('Escape')
    await page.setViewportSize({ width: 1440, height: 900 })
    await expect(verb).toHaveText('Decide this run')
    await expect(bar.getByRole('button', { name: 'Destination views', exact: true })).toHaveCount(0)
  })
}
test.describe('B11a owner corrections', () => {
  for (const theme of WALL_THEMES) for (const width of WALL_WIDTHS) {
    test(`Owner fix 2 Activity tasks close from either control at ${width} in ${theme}`, async ({ page }) => {
      await openFrame(page, 'frame-wall=conversation&frame-status=tasks', theme, width)
      const bar = page.locator('[data-slot="top-bar"]:visible')
      const panel = page.locator('[data-slot="work-tools"]:visible')
      const tasks = bar.getByRole('button', { name: 'Activity', exact: true })
      await expect(tasks.locator('[data-slot="tool-dot"]')).toHaveCount(1)
      for (const closer of ['Toggle right panel', 'Activity']) {
        await tasks.click()
        await expect(panel).toBeVisible()
        await expect(bar.getByRole('button', { name: 'Activity', exact: true })).toHaveAttribute('aria-pressed', 'true')
        await bar.getByRole('button', { name: closer, exact: true }).click()
        await expect(panel).toHaveCount(0)
        await expect(bar.getByRole('button', { name: 'Toggle right panel', exact: true })).toHaveAttribute('aria-pressed', 'false')
      }
    })
    test(`B11a owner bar edge and retained control geometry at ${width} in ${theme}`, async ({ page }) => {
      for (const foundation of ['desk', 'studio'] as const) {
        await openFrame(page, 'frame-wall=conversation', theme, width)
        await page.locator('body').evaluate((body, value) => { body.dataset.hdInterface = value }, foundation)
        const bar = page.locator('[data-slot="top-bar"]:visible')
        const header = bar.locator('..')
        await expect(header).not.toHaveAttribute('data-rule', 'bottom')
        expect(await header.evaluate(node => getComputedStyle(node).borderBottomWidth)).toBe('0px')
        expect((await header.boundingBox())!.height).toBe(FRAME.bar.height)
        const toggle = bar.getByRole('button', { name: 'Toggle right panel', exact: true })
        for (const open of [false, true, false]) {
          if (open || await toggle.getAttribute('aria-pressed') === 'true') await toggle.click()
          const box = (await toggle.boundingBox())!, head = (await header.boundingBox())!
          // The former border occupied the final pixel of the 40px bar.
          expect(box.y + box.height / 2 - head.y).toBe((FRAME.bar.height - 1) / 2)
          const tools = bar.locator('[data-topbar="tools"]')
          if (open && width >= FRAME.fold.panelFloats) {
            const column = (await tools.boundingBox())!
            expect(column.y).toBe(head.y)
            expect(column.height).toBe(FRAME.bar.height)
            expect(await tools.evaluate(node => getComputedStyle(node).borderLeftWidth)).toBe('1px')
          } else expect(await tools.evaluate(node => getComputedStyle(node).borderLeftWidth)).toBe('0px')
        }
      }
    })
  }
})

for (const theme of WALL_THEMES) for (const destination of ['settings', 'agents', 'teams', 'dashboard']) {
  test(`Owner fix 2 ${destination} has one shell bar and no footer in ${theme}`, async ({ page }) => {
    await openFrame(page, `frame-wall=${destination}`, theme, 720)
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    const bar = dialog.locator('[data-slot="top-bar"]')
    await expect(bar).toHaveCount(1)
    await expect(page.locator('[data-slot="status-bar"], [data-frame-region="status"]')).toHaveCount(0)
    await expect(page.locator('[data-slot="top-bar"]:visible')).toHaveCount(1)
    await expect(bar.locator('[data-work-tool]')).toHaveCount(0)
    expect((await bar.locator('..').boundingBox())!.height).toBe(FRAME.bar.height)
    const more = bar.getByRole('button', { name: 'More', exact: true })
    await more.focus()
    await expect(more).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(page.locator('[data-slot="top-bar"]:visible')).toHaveCount(1)
    await expect(page.locator('[data-slot="status-bar"]:visible')).toHaveCount(0)
  })
}

for (const theme of WALL_THEMES) {
  test(`Owner fix 2 seat usage menu returns focus and has plan actions in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation', theme)
    const trigger = page.locator('[data-left-seat] [data-slot="popover-trigger"]:not(:has([data-slot="inbox-button"]))')
    await applyLeftColumnActions(page, { leftOpen: true, leftPopup: 'usage' })
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Open usage', exact: true })).toBeVisible()
    await expect(menu.locator('[data-slot="usage-meter-row"]')).not.toHaveCount(0)
    const rows = menu.getByRole('menuitem')
    const count = await rows.count()
    expect(count).toBeGreaterThan(1)
    await page.keyboard.press('Home')
    for (let index = 0; index < count; index++) {
      await expect(rows.nth(index)).toBeFocused()
      if (index + 1 < count) await page.keyboard.press('ArrowDown')
    }
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await applyLeftColumnActions(page, { leftOpen: true, leftPopup: 'usage' })
    await page.keyboard.press('Home')
    await page.keyboard.press('Tab')
    await expect(menu).toHaveCount(0)
    await expect(page.locator('[data-left-seat] [data-slot="popover-trigger"]:has([data-slot="inbox-button"])')).toBeFocused()
  })
  test(`Owner fix 2 modal tools preserve work intent and preserve File and terminal nodes in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation&frame-tool=file&frame-tool-path=%2Frepo%2FREADME.md&frame-terminal=1&frame-status=tasks', theme)
    const editor = page.locator('[data-slot="work-tools"] .cm-content')
    await expect(editor).toContainText('Storefront')
    await page.locator('[data-slot="work-tools"]').getByRole('button', { name: 'Edit', exact: true }).click()
    await expect(editor).toHaveAttribute('contenteditable', 'true')
    await editor.fill('Keep this dirty checkout note')
    await editor.evaluate(node => { node.dataset.b10Retained = 'file' })
    const terminal = page.locator('[data-terminal-id]')
    await expect(terminal).toBeVisible()
    const terminalId = await terminal.getAttribute('data-terminal-id')
    await terminal.evaluate(node => { node.dataset.b10Retained = 'terminal' })
    await page.locator('[data-frame-region="left"]').getByRole('button', { name: 'Agents', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(editor).toBeHidden()
    await expect(terminal).toBeHidden()
    await expect(dialog.locator('[data-slot="top-bar"] [data-work-tool]')).toHaveCount(0)
    await expect(dialog).toBeVisible()
    await expect(page.locator('[data-slot="work-tools"]')).toBeHidden()
    const more = dialog.getByRole('button', { name: 'More', exact: true })
    await more.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('menu')).toBeVisible()
    await expect(page.getByRole('menuitemradio', { name: /Terminal/ })).toHaveAttribute('aria-checked', 'true')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(dialog).toBeVisible()
    await expect(more).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(page.locator('[data-slot="work-tools"]')).toBeVisible()
    await expect(page.locator('[data-b10-retained="file"]')).toHaveCount(1)
    await expect(editor).toContainText('Keep this dirty checkout note')
    await expect(terminal).toHaveAttribute('data-terminal-id', terminalId!)
    await expect(terminal).toHaveAttribute('data-b10-retained', 'terminal')
    await expect(terminal).toBeVisible()
  })
}

for (const theme of WALL_THEMES) for (const width of WALL_WIDTHS) {
  test(`Owner fix 2 empty connection host takes no main height at ${width} in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation', theme, width)
    const main = (await page.locator('[data-slot="workbench-main"]').boundingBox())!
    const pane = (await page.locator('[data-slot="workbench-main"] [data-pane-id]').first().boundingBox())!
    expect(pane.y).toBe(main.y)
    expect(pane.y + pane.height).toBe(main.y + main.height)
  })
}

for (const theme of WALL_THEMES) {
  for (const width of WALL_WIDTHS) {
    test(`Owner fix 2 frame reaches bottom and More retains Terminal at ${width} in ${theme}`, async ({ page }) => {
      await openFrame(page, 'frame-wall=team&frame-terminal=1', theme, width)
      await expect(page.locator('[data-slot="status-bar"], [data-frame-region="status"]')).toHaveCount(0)
      const main = (await page.locator('[data-frame-region="main"]').boundingBox())!
      const bottom = (await page.locator('[data-frame-region="bottom"]').boundingBox())!
      expect(main.y + main.height).toBe(bottom.y)
      expect(bottom.y + bottom.height).toBe(900)
      if (width >= FRAME.fold.sidebarFloats) {
        const left = (await page.locator('[data-frame-region="left"]').boundingBox())!
        expect(left.y + left.height).toBe(900)
        const seat = (await page.locator('[data-left-seat]').boundingBox())!
        expect(seat.y + seat.height).toBe(900)
      }
      const terminal = page.locator('[data-terminal-id]')
      const id = await terminal.getAttribute('data-terminal-id')
      await selectFrameTab(page, 'findings')
      await expect(terminal).toHaveAttribute('data-terminal-id', id!)
      await expect(terminal).toBeVisible()
      await page.getByRole('button', { name: 'More', exact: true }).click()
      const item = page.getByRole('menuitemradio', { name: /Terminal/ })
      await expect(item).toContainText('⌃`')
      await item.click()
      await expect(terminal).toHaveCount(0)
      await expect(page.getByRole('menu')).toHaveCount(0)
      const work = page.locator('[data-slot="workbench-main"] [data-pane-id]').first()
      await work.focus()
      await expect(work).toBeFocused()
      await page.keyboard.press('Control+Backquote')
      await expect(page.locator('[data-terminal-id]')).toBeVisible()
    })
  }
  test(`Owner fix 2 Activity carries tasks and connection Banner clears in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation&frame-status=tasks', theme)
    const activity = page.getByRole('button', { name: 'Activity', exact: true })
    await expect(activity.locator('[data-slot="tool-dot"]')).toHaveCount(1)
    expect((await activity.boundingBox())!.height).toBe(FRAME.bar.iconButton)
    await activity.click()
    const sections = page.locator('[data-slot="work-tools"] [data-slot="tool-section"]:visible')
    await expect(sections.first()).toHaveAttribute('aria-label', 'Background work')
    await expect(sections.first()).toContainText('Review the checkout')
    await openFrame(page, 'frame-wall=team&frame-status=reconnecting', theme, 720)
    await expect(page.locator('[data-shell-host="main-notice"]')).toContainText('Reconnecting to HarnessDesk.')
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('harnessdesk:preview-connection', { detail: 'open' })))
    await expect(page.locator('[data-shell-host="main-notice"] [role="status"]')).toHaveCount(0)
  })
  test(`Owner fix 2 update row uses column anatomy above seat in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation&frame-update=1', theme)
    const update = page.getByRole('button', { name: 'Relaunch to update', exact: true })
    await expect(update).toBeVisible()
    expect((await update.boundingBox())!.height).toBe(FRAME.rail.rowHeight)
    const seat = (await page.locator('[data-left-seat]').boundingBox())!
    const row = (await update.boundingBox())!
    expect(row.y + row.height).toBeLessThanOrEqual(seat.y)
    await update.click()
    await expect(update).toHaveCount(0)
  })
}

for (const theme of WALL_THEMES) {
  test(`B8 Agents layout measures allocated rows and keeps names inside their column in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=team', theme)
    await page.locator('[data-work-tool="details"]').click()
    const overview = page.locator('[data-slot="team-overview"]')
    const seats = overview.locator('[aria-label="Seats"]')
    const allocated = (await seats.boundingBox())!.width
    expect(allocated).toBeLessThan(800)
    await expect(overview).toHaveAttribute('data-layout', 'narrow')
    // Keep the existing 800 breakpoint, and exercise both sides on the real
    // row allocation after the canonical reading inset.
    const atThreshold = 1440 + 800 - allocated
    await page.setViewportSize({ width: atThreshold - 1, height: 900 })
    await expect.poll(async () => (await seats.boundingBox())!.width).toBe(799)
    await expect(overview).toHaveAttribute('data-layout', 'narrow')
    await page.setViewportSize({ width: atThreshold, height: 900 })
    await expect.poll(async () => (await seats.boundingBox())!.width).toBe(800)
    await expect(overview).toHaveAttribute('data-layout', 'table')
    for (const name of ['Alpha', 'Beta']) {
      const action = seats.getByRole('button', { name: `Open ${name}`, exact: true })
      await expect(action).toBeVisible()
      const cell = action.locator('xpath=ancestor::td')
      const bounds = (await cell.boundingBox())!, label = (await action.boundingBox())!
      expect(label.x).toBeGreaterThanOrEqual(bounds.x)
      expect(label.x + label.width).toBeLessThanOrEqual(bounds.x + bounds.width)
    }
  })
  for (const width of [1280, 1279, 1000, 999, 720]) {
    test(`B8 fixed folds at ${width} in ${theme}`, async ({ page }) => {
      await openFrame(page, 'frame-wall=conversation', theme, width)
      await page.locator('[data-work-tool="details"]').click()
      const shell = page.locator('[data-slot="fixed-shell"]')
      await expect(shell).toHaveAttribute('data-panel-floats', String(width < FRAME.fold.panelFloats))
      await expect(shell).toHaveAttribute('data-left-floats', String(width < FRAME.fold.sidebarFloats))
      const main = page.locator('[data-frame-region="main"]')
      expect(await main.evaluate(node => node.closest('[inert]') !== null)).toBe(false)
      await expect(page.locator('[data-slot="workbench-main"]')).not.toHaveAttribute('inert', '')
      if (width >= FRAME.fold.panelFloats) expect((await main.boundingBox())!.width).toBeGreaterThanOrEqual(FRAME.main.min)
      await expect(page.locator('[data-region="sidebar"] [data-slot="dock-panel"]')).toHaveCount(0)
      const bar = (await page.locator('[data-frame-region="top"]').boundingBox())!
      const panel = (await page.locator('[data-frame-region="right"]').boundingBox())!
      expect(Math.abs(panel.y - bar.y - FRAME.bar.height)).toBeLessThanOrEqual(1)
      expect(panel.x).toBeGreaterThanOrEqual(0)
      expect(panel.x + panel.width).toBeLessThanOrEqual(width)
      if (width < FRAME.fold.panelFloats) expect(panel.width).toBe(FRAME.rightPanel.width)
    })
  }
  test(`B8 terminal height and seam default are measured in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation&frame-terminal=1', theme)
    const terminal = page.locator('[data-terminal-id]')
    const id = await terminal.getAttribute('data-terminal-id')
    const seam = page.getByRole('separator', { name: 'Resize the bottom panel' })
    await seam.focus()
    for (let i = 0; i < 40; i++) await seam.press('ArrowUp')
    expect((await page.locator('[data-frame-region="bottom"]').boundingBox())!.height).toBeLessThanOrEqual(450)
    await seam.dblclick()
    expect(Math.round((await page.locator('[data-frame-region="bottom"]').boundingBox())!.height)).toBe(FRAME.bottomPanel.height)
    await page.setViewportSize({ width: 1440, height: 240 })
    await expect.poll(async () => (await page.locator('[data-frame-region="bottom"]').boundingBox())!.height).toBe(FRAME.bottomPanel.min)
    await page.setViewportSize({ width: 1440, height: 239 })
    await expect(terminal).toBeHidden()
    await expect(terminal).toHaveAttribute('data-terminal-id', id!)
    await page.setViewportSize({ width: 1440, height: 900 })
    await expect(terminal).toBeVisible()
    await expect(terminal).toHaveAttribute('data-terminal-id', id!)
    await expect.poll(async () => (await page.locator('[data-frame-region="bottom"]').boundingBox())!.height).toBe(FRAME.bottomPanel.height)
  })
}

for (const theme of WALL_THEMES) for (const tool of ['details', 'changes', 'activity', 'browser']) {
  test(`B7a ${tool} is a flat body without furniture in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation', theme)
    await page.locator(`[data-work-tool="${tool}"]`).click()
    const panel = page.locator('[data-slot="work-tools"]')
    await expect(panel).toBeVisible()
    for (const slot of ['dock-panel-tabs', 'dock-panel-bar', 'inspector-tools', 'tool-pane-header', 'card-header']) {
      expect(await panel.locator(`[data-slot="${slot}"]`).count(), `${tool}: ${slot} retired`).toBe(0)
    }
    const panelBox = (await panel.boundingBox())!
    const topBox = (await page.locator('[data-slot="top-bar"]').locator('..').boundingBox())!
    expect(Math.abs(panelBox.y - topBox.y - topBox.height)).toBeLessThanOrEqual(1)
    if (tool === 'activity') await expect(panel.getByText('Events', { exact: true })).toBeVisible()
  })
}

for (const theme of WALL_THEMES) {
  test(`B7 shell owns the retained tool frame in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation', theme)
    await page.locator('[data-work-tool="changes"]').click()
    await expect(page.locator('[data-slot="dock-panel-tabs"]')).toHaveCount(0)
    await expect(page.locator('[data-slot="inspector-tools"]')).toHaveCount(0)
    const tool = page.locator('[data-slot="work-tools"]')
    await expect(tool).toBeVisible()
    expect(Math.round((await page.locator('[data-slot="top-bar"]').locator('..').boundingBox())!.height)).toBe(FRAME.bar.height)
    const mounts = await page.locator('[data-tool-mount]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-tool-mount')))
    await page.locator('[data-work-panel-toggle]').click()
    await expect(tool).toBeHidden()
    await page.locator('[data-work-panel-toggle]').click()
    await expect(tool).toBeVisible()
    expect(await page.locator('[data-tool-mount]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-tool-mount')))).toEqual(mounts)
  })
}

for (const theme of WALL_THEMES) {
  test(`B6 Team view controls keep one View x and no second toolbar in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=team', theme)
    const xs: number[] = []
    for (const tab of ['overview', 'run', 'board', 'room', 'findings']) {
      await selectFrameTab(page, tab)
      const icon = page.locator('[data-topbar="view"]')
      await expect(icon).toBeVisible()
      xs.push((await icon.boundingBox())!.x)
      await expect(page.locator('[data-slot="view-bar"]')).toHaveCount(0)
      await expect(page.locator('[data-slot="run-header"]')).toHaveCount(0)
    }
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(1)
    await selectFrameTab(page, 'findings')
    await page.getByRole('button', { name: 'View', exact: true }).click()
    await page.getByRole('switch', { name: 'Open', exact: true }).click()
    await expect(page.locator('[data-topbar="view"] [data-filtered="true"]')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Decide this run', exact: true })).toBeVisible()
  })

  test(`B5 equivalent completed rounds stay folded and select their latest record in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=team-run-equivalent', theme)
    await selectFrameTab(page, 'run')
    const main = page.locator('[data-slot="workbench-main"]')
    const group = main.locator('[data-round-group]')
    await expect(group).toHaveCount(1)
    await expect(group).toContainText('Rounds 1–2')
    await expect(group).toContainText('2 runs')
    await expect(main.locator('[data-slot="timeline-records"]')).toHaveCount(0)
    await group.click()
    await expect(main.locator('[data-row="card-2-2"]')).toHaveAttribute('aria-current', 'true')
    await expect(page.locator('[data-slot="tool-body"]:visible [data-slot="run-inspector"]')).toContainText('#2')
    await page.locator('[data-slot="top-bar"]:visible').getByRole('button', { name: 'Toggle right panel', exact: true }).click()
    await selectRunView(page.locator('[data-frame-id="frame-wall"]'), 'Flow')
    await selectRunView(page.locator('[data-frame-id="frame-wall"]'), 'Timeline')
    await expect(group).toHaveCount(1)
    await expect(main.locator('[data-row="card-2-2"]')).toHaveAttribute('aria-current', 'true')
    await expect(page.locator('[data-slot="tool-body"]:visible')).toHaveCount(0)
  })

  for (const width of [1440, 720]) {
    test(`B5 Steps stay in main and Run View preserves the canonical bar at ${width} in ${theme}`, async ({ page }) => {
      await openFrame(page, 'frame-wall=team-run-recorded', theme, width)
      await selectFrameTab(page, 'run')
      const bar = page.locator('[data-slot="top-bar"]:visible').first()
      const main = page.locator('[data-slot="workbench-main"]')
      await expect(page.locator('[data-slot="run-header"]')).toHaveCount(0)
      await expect(main.locator('[data-slot="run-steps"]')).toBeVisible()
      await expect(page.locator('[data-slot="work-tools"] [data-slot="run-steps"]')).toHaveCount(0)
      await expect(page.locator('[data-slot="tool-body"]:visible')).toHaveCount(0)
      await expect(bar.locator('[data-work-tool]')).toHaveCount(4)
      const verb = bar.getByRole('button', { name: 'Stop run…', exact: true })
      await expect(verb).toBeVisible()
      await expect(verb.locator('svg')).toHaveCount(0)
      await expect.poll(async () => (await bar.locator('[data-topbar-title]').boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(FRAME.bar.titleMin)
      const view = bar.locator('[data-topbar="view"]')
      const before = (await view.boundingBox())!
      await selectRunView(page.locator('[data-frame-id="frame-wall"]'), 'Flow')
      await expect(main.locator('[data-slot="run-flow"]')).toBeVisible()
      await expect(main.locator('[data-slot="flow-canvas"] .react-flow__node')).toHaveCount(4)
      await expect.poll(async () => (await view.boundingBox())!.x).toBe(before.x)
      await expect.poll(async () => (await bar.locator('[data-topbar-title]').boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(FRAME.bar.titleMin)
      await expect(page.locator('[data-slot="tool-body"]:visible')).toHaveCount(0)
      await selectRunView(page.locator('[data-frame-id="frame-wall"]'), 'Timeline')
      await expect(main.locator('[data-slot="run-steps"]')).toBeVisible()
      await expect(page.locator('[data-slot="tool-body"]:visible')).toHaveCount(0)
      const future = main.locator('[data-slot="run-steps"] [data-step-row="person"]')
      await future.click()
      await expect(future).toHaveAttribute('aria-current', 'true')
      await bar.getByRole('button', { name: 'Toggle right panel', exact: true }).click()
      await selectRunView(page.locator('[data-frame-id="frame-wall"]'), 'Flow')
      await expect(main.locator('[data-slot="flow-step"][data-step="person"]')).toHaveAttribute('data-selected', 'true')
      await selectRunView(page.locator('[data-frame-id="frame-wall"]'), 'Timeline')
      await expect(future).toHaveAttribute('aria-current', 'true')
      await expect(page.locator('[data-slot="tool-body"]:visible')).toHaveCount(0)
    })
  }

  test(`B3 narrow Team Run retains its timeline after automatic panel collapse in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=team', theme, 720)
    await selectFrameTab(page, 'run')
    const main = page.locator('[data-slot="workbench-main"]')
    await expect(main).toBeVisible()
    await expect(main.locator('[data-slot="run-workspace"]')).toBeVisible()
    await expect(main).toContainText('Round 1')
    await page.getByRole('button', { name: 'Toggle right panel', exact: true }).click()
    const details = page.locator('[data-slot="tool-body"]:visible')
    await expect(details.locator('[aria-label="Team Run facts"]')).toBeVisible()
    await expect(details.locator('[aria-label="Seats"]')).toBeVisible()
    await expect(details.locator('[data-slot="summary-card"][data-surface="card"]')).toHaveCount(0)
    // The canonical toggle stays above the covered main area and returns to
    // the same timeline without reselecting or releasing the retained record.
    await page.locator('[data-slot="top-bar"]').getByRole('button', { name: 'Toggle right panel', exact: true }).click()
    await expect(main).toBeVisible()
    await expect(main).toContainText('Round 1')
    // The ordinary wall Run truthfully records no Flow steps. Use the existing
    // synthetic recorded-Flow rig for its narrow Steps visibility boundary.
    await openFrame(page, 'run-dock', theme, 720)
    await selectFrameTab(page, 'run')
    await selectRunView(page.locator('#run-dock-frame'), 'Flow')
    await expect(main.locator('[data-slot="flow-canvas"] .react-flow__node')).toHaveCount(4)
    await expect(main.locator('[data-slot="flow-list"] section[aria-label="Rules"]')).toHaveCount(1)
    await selectRunView(page.locator('#run-dock-frame'), 'Timeline')
    await expect(main.locator('[data-slot="run-steps"]')).toBeVisible()
    await expect(main.locator('[data-step-row]')).toHaveCount(5)
    await expect(main).toContainText('Taken 4')
    await expect(main).toContainText('Not reached 1')
    // The canonical toggle restores remembered Details on one press; Flow
    // retains its native Rules alternative and Timeline Steps without a Steps tool.
    await page.getByRole('button', { name: 'Toggle right panel', exact: true }).click()
    await expect(page.locator('[data-slot="tool-body"]:visible')).toContainText('Seats')
    await expect(page.locator('[data-slot="tool-body"] [data-slot="run-steps"]')).toHaveCount(0)
    await page.locator('[data-slot="top-bar"]').getByRole('button', { name: 'Toggle right panel', exact: true }).click()
    await expect(main).toBeVisible()
  })

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
    const header = page.locator('[data-slot="top-bar"]').locator('..')
    await expect(header).toBeVisible()
    expect(Math.round((await header.boundingBox())!.height)).toBe(FRAME.bar.height)
  })

  test(`a menu keeps the contract in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=team', theme)
    await page.locator('[data-slot="top-bar"]:visible').first().getByRole('button', { name: 'More', exact: true }).click()
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
    await expect(rows.first().locator('[data-slot="bar-divider"]')).toHaveCount(0)
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
    await expect(page.locator('[data-slot="inspector-panel"]:visible')).toBeVisible()
    expect((await main.boundingBox())!.width).toBeGreaterThanOrEqual(FRAME.main.min)
  })
}

for (const theme of WALL_THEMES) {
  test(`B4 embedded member retains scoped actions in the canonical Team bar in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=team&frame-member-actions=1', theme)
    const bar = page.locator('[data-slot="top-bar"]')
    await bar.getByRole('button', { name: 'Details', exact: true }).click()
    await page.getByRole('button', { name: 'Actions for Alpha', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Open conversation', exact: true }).click()
    await expect(bar).toHaveCount(1)
    expect(await bar.locator('[data-work-tool]').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.workTool))).toEqual(['details', 'changes', 'activity', 'browser'])
    await expect(bar.locator('[data-topbar-title]')).toContainText('Retry the checkout call')
    await bar.getByRole('button', { name: 'More', exact: true }).click()
    await expect(page.getByRole('menuitem', { name: 'Compact now', exact: true })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Save as an Agent…', exact: true })).toBeVisible()
    await expect(page.getByRole('menuitemcheckbox', { name: 'Browser', exact: true })).toHaveCount(0)
    await page.getByRole('menuitem', { name: 'Folder actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Commit the changes', exact: true }).click()
    const composer = page.locator('[data-slot="workbench-main"] textarea')
    await expect(composer).toHaveValue('Commit the changes from this conversation with a clear message, then tell me the commit hash.')
    await expect(composer).toBeFocused()
    await page.screenshot({ path: `output/frame-wall/B4-member-actions-${theme}.png` })
  })
  test(`B3 Details Commit reaches its conversation after Browser focus in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation', theme)
    const bar = page.locator('[data-slot="top-bar"]')
    await bar.getByRole('button', { name: 'Browser', exact: true }).click()
    const address = page.getByRole('textbox', { name: 'Address', exact: true })
    await address.click()
    await expect(address).toBeFocused()
    await bar.getByRole('button', { name: 'Details', exact: true }).click()
    await page.getByRole('button', { name: 'Folder actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Commit the changes', exact: true }).click()
    const composer = page.locator('[data-slot="workbench-main"] textarea')
    await expect(composer).toHaveValue('Commit the changes from this conversation with a clear message, then tell me the commit hash.')
    await expect(composer).toBeFocused()
    await expect(page.locator('input[aria-label="Address"]')).toHaveCount(1)
    await expect(page.locator('input[aria-label="Address"]')).toBeHidden()
  })
  for (const destination of ['conversation', 'draft']) {
    test(`B3 ${destination} has one shell row and four tool anchors in ${theme}`, async ({ page }) => {
      await openFrame(page, `frame-wall=${destination}`, theme)
      const top = page.locator('[data-slot="top-bar"]')
      await expect(top).toHaveCount(1)
      expect(Math.round((await top.locator('..').boundingBox())!.height)).toBe(FRAME.bar.height)
      await expect(top.locator('[data-slot="bar-divider"]')).toHaveCount(0)
      await expect(page.locator('[data-slot="workbench-main"] header[data-slot="bar"]')).toHaveCount(0)
      expect(await top.locator('[data-work-tool]').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.workTool)))
        .toEqual(['details', 'changes', 'activity', 'browser'])
      if (destination === 'draft') {
        await expect(top.getByRole('button', { name: 'Changes', exact: true })).toBeDisabled()
        await expect(top.getByRole('button', { name: 'Activity', exact: true })).toBeDisabled()
      }
      await top.getByRole('button', { name: 'Details', exact: true }).click()
      const details = page.locator('[data-slot="tool-body"]:visible')
      await expect(details.getByText('Plan', { exact: true })).toBeVisible()
      await expect(details.locator('[data-slot="summary-card"]').first()).toHaveAttribute('data-surface', 'panel')
      const firstTool = (await top.locator('[data-work-tool="details"]').boundingBox())!
      const panel = (await details.boundingBox())!
      expect(firstTool.x - panel.x).toBe(FRAME.bar.pad + 1)
      const more = (await top.getByRole('button', { name: 'More', exact: true }).boundingBox())!
      expect(more.x + more.width + FRAME.bar.pad).toBe(1440)
      const keys = details.locator('[data-slot="summary-item"] dt')
      const widths = await keys.evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().width)))
      expect(widths).toEqual(widths.map(() => FRAME.summaryKey.panel))
    })
  }
}

for (const theme of WALL_THEMES) {
  test(`B3 standing tools follow the painted panel seam in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation', theme)
    const top = page.locator('[data-slot="top-bar"]')
    await top.getByRole('button', { name: 'Details', exact: true }).click()
    const details = page.locator('[data-slot="tool-body"]:visible')
    const first = top.locator('[data-work-tool="details"]')
    const more = top.getByRole('button', { name: 'More', exact: true })
    const panelBefore = (await details.boundingBox())!
    const moreBefore = (await more.boundingBox())!
    const seam = (await page.getByRole('separator', { name: 'Resize the right panel', exact: true }).boundingBox())!
    const start = seam.x + seam.width / 2
    await page.mouse.move(start, 400)
    await page.mouse.down()
    await page.mouse.move(start - 40, 400, { steps: 6 })
    await expect.poll(async () => Math.round((await details.boundingBox())!.width)).toBe(Math.round(panelBefore.width) + 40)
    const painted = (await details.boundingBox())!
    expect((await first.boundingBox())!.x - painted.x).toBe(FRAME.bar.pad + 1)
    expect((await more.boundingBox())!.x).toBe(moreBefore.x)
    await page.mouse.up()
    expect((await first.boundingBox())!.x - (await details.boundingBox())!.x).toBe(FRAME.bar.pad + 1)
  })
}


for (const theme of WALL_THEMES) {
  test(`B4 Team tabs own navigation and Chat owns its layout in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=team', theme)
    await expect(page.locator('[data-slot="top-bar"]')).toHaveCount(1)
    await expect(page.locator('[data-team-page="overview"]')).toBeVisible()
    await expect(page.locator('[data-team-page="side-by-side"]')).toHaveCount(0)
    await page.locator('[data-work-tool="details"]').click()
    const details = page.locator('[data-slot="tool-body"]:visible')
    const headings = await details.locator('[data-slot="tool-section"] > [data-slot="group-label"]').evaluateAll(nodes => nodes.map(node => node.textContent))
    expect(headings[0]).toContain('Run')
    expect(headings[1]).toContain('Seats')
    await selectFrameTab(page, 'room')
    await page.getByRole('button', { name: 'View', exact: true }).click()
    await expect(page.getByRole('menuitemradio', { name: 'Thread', exact: true })).toBeVisible()
    await expect(page.getByRole('menuitemradio', { name: 'Side by side', exact: true })).toBeVisible()
  })
  test(`B4 Chat has one composer edge and no view toolbar in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=team', theme)
    await selectFrameTab(page, 'room')
    await expect(page.locator('[data-slot="view-bar"]')).toHaveCount(0)
    const composer = page.locator('[data-slot="room-body"] [data-slot="composer"]:visible').first()
    await expect(composer).toBeVisible()
    const content = page.locator('[data-slot="room-body"]')
    const composerBox = (await composer.boundingBox())!, contentBox = (await content.boundingBox())!
    expect(composerBox.y + composerBox.height).toBeLessThanOrEqual(contentBox.y + contentBox.height + 1)
  })
}

for (const theme of WALL_THEMES) {
  test(`B4a Hold lives in Send to and preserves the person's draft in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=team', theme, 720)
    await selectFrameTab(page, 'room')
    const composer = page.locator('[data-slot="room-body"] [data-slot="composer"]:visible').first()
    const input = composer.locator('textarea').first()
    await input.fill('Check the retry budget')
    await page.getByRole('button', { name: 'Send to', exact: true }).click()
    await page.getByRole('switch', { name: 'Hold messages', exact: true }).click()
    await expect(composer.getByText('Holding messages', { exact: true })).toBeVisible()
    await expect(input).toHaveValue('Check the retry budget')
    await expect(input).toBeEnabled()
    await expect(page.locator('[data-slot="top-bar"]').getByRole('button', { name: /Hold messages/ })).toHaveCount(0)
    expect(Math.round((await page.locator('[data-slot="top-bar"]').locator('..').boundingBox())!.height)).toBe(FRAME.bar.height)
  })
}

for (const theme of WALL_THEMES) {
  test(`B4a Side by side shares Hold with the controlled Chat draft in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=team', theme)
    await selectFrameTab(page, 'room')
    const input=page.locator('[data-slot="room-body"] [data-slot="composer"]:visible textarea').first()
    await input.fill('Check the retry budget')
    await page.getByRole('button',{name:'Send to',exact:true}).click()
    await page.getByRole('switch',{name:'Hold messages',exact:true}).click()
    await page.getByRole('button',{name:'View',exact:true}).click()
    await page.getByRole('menuitemradio',{name:'Side by side',exact:true}).click()
    const shared=page.locator('[data-shared-composer]:visible')
    await expect(shared.getByText('Holding messages',{exact:true})).toBeVisible()
    await expect(shared.locator('textarea')).toHaveValue('Check the retry budget')
    await expect(shared.locator('textarea')).toBeEnabled()
    await shared.getByRole('button',{name:'Send to',exact:true}).click()
    await expect(page.getByRole('switch',{name:'Hold messages',exact:true})).toHaveAttribute('aria-checked','true')
    await page.getByRole('switch',{name:'Hold messages',exact:true}).click()
    await expect(shared.getByText('Holding messages',{exact:true})).toHaveCount(0)
    await expect(shared.locator('textarea')).toHaveValue('Check the retry budget')
  })
}

// Task 10 extends this same window contract to the transitional
// AppWindow hosts. The pattern probe deliberately has no application lead.
const B10_NONWORK = /frame-wall=(?:teams|agents|agent|dashboard|settings(?:-general|-runtimes)?|library|plugins|changes-review)(?:&|$)/
const D6_NONWORK = /frame-wall=settings-(?:navigation|search)(?:&|$)/
const B6_WORK_DESTINATIONS = WALL_DESTINATIONS.filter(destination => destination.surface !== 'pattern' && !B10_NONWORK.test(destination.query) && !D6_NONWORK.test(destination.query))
const B10_NONWORK_DESTINATIONS = WALL_DESTINATIONS.filter(destination => B10_NONWORK.test(destination.query) || D6_NONWORK.test(destination.query))
for (const theme of WALL_THEMES) for (const width of [720, 1440]) {
  test(`B10 nonwork place hierarchy and lead follow window state at ${width} in ${theme}`, async ({ page }) => {
    const hidden = width === 1440 ? '&frame-sidebar-hidden=1' : ''
    await openFrame(page, `frame-wall=conversation${hidden}`, theme, width)
    const referenceX = (await page.locator('[data-slot="top-bar"] [data-topbar="place"]').boundingBox())!.x
    const measured: { destination: string; origin: number; childX: number; titleWidth: number }[] = []
    for (const destination of B10_NONWORK_DESTINATIONS) {
      await openFrame(page, `${destination.query}${hidden}`, theme, width)
      const bar = page.locator('[data-slot="top-bar"]:visible')
      if (destination.id === 'agent') await expect(bar.locator('[data-topbar-title]')).toContainText('Implementer')
      await expect(bar.locator('[data-topbar="lead"]').getByRole('button')).toHaveCount(width === 720 ? 1 : 3)
      await expect(bar.locator('[data-topbar="lead"]').getByRole('button', { name: 'Show sidebar', exact: true })).toBeVisible()
      await expect(bar.locator('[data-work-tool]')).toHaveCount(0)
      await expect.poll(async () => (await bar.locator('[data-topbar-title]').boundingBox())?.width ?? 0,
        { message: `${destination.id} child title floor` }).toBeGreaterThanOrEqual(FRAME.bar.titleMin)
      const title = (await bar.locator('[data-topbar-title]').boundingBox())!
      const origin = (await bar.locator('[data-topbar="place"]').boundingBox())!.x
      // Bars slot 2 and the approved Agent/Settings drawing put the parent
      // before the child. Pin that entire place origin, and separately keep
      // the child title's unchanged 180px floor; work title-x stays in B6.
      expect(Math.abs(origin - referenceX), `${destination.id} place origin`).toBeLessThanOrEqual(1)
      measured.push({ destination: destination.id, origin, childX: title.x, titleWidth: title.width })
    }
    await test.info().attach('nonwork-place-measurements', { body: JSON.stringify(measured, null, 2), contentType: 'application/json' })
  })
}
for (const theme of WALL_THEMES) {
  test(`B10 standing-column place origin stays common in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation', theme)
    const referenceX = (await page.locator('[data-slot="top-bar"] [data-topbar="place"]').boundingBox())!.x
    for (const destination of B10_NONWORK_DESTINATIONS) {
      await openFrame(page, destination.query, theme)
      const bar = page.locator('[data-slot="top-bar"]:visible')
      if (destination.id === 'agent') await expect(bar.locator('[data-topbar-title]')).toContainText('Implementer')
      await expect(bar.locator('[data-topbar="lead"]').getByRole('button')).toHaveCount(0)
      const origin = (await bar.locator('[data-topbar="place"]').boundingBox())!.x
      expect(Math.abs(origin - referenceX), `${destination.id}: origin ${origin}, work ${referenceX}`).toBeLessThanOrEqual(1)
    }
  })
}
for (const theme of WALL_THEMES) {
  for (const width of [720, 1440]) for (let group = 0; group < Math.ceil(B6_WORK_DESTINATIONS.length / 9); group++) {
    test(`B6 lead follows window state on work destinations group ${group + 1} at ${width} in ${theme}`, async ({ page }) => {
      await openFrame(page, 'frame-wall=conversation', theme, width)
      if (width === 1440) await page.getByRole('button', { name: 'Hide sidebar', exact: true }).click()
      const referenceX = (await page.locator('[data-slot="top-bar"] [data-topbar-title]').boundingBox())!.x
      const titleXs: number[] = [referenceX]
      for (const destination of B6_WORK_DESTINATIONS.slice(group * 9, (group + 1) * 9)) {
        await openFrame(page, destination.query, theme, width)
        if (width === 1440) await page.getByRole('button', { name: 'Hide sidebar', exact: true }).click()
        await applyFrameActions(page, destination)
        const bar = page.locator('[data-slot="top-bar"]:visible').first()
        const lead = bar.locator('[data-topbar="lead"]')
        await expect(lead.getByRole('button')).toHaveCount(width === 720 ? 1 : 3)
        await expect(lead.getByRole('button', { name: 'Show sidebar', exact: true })).toBeVisible()
        await expect.poll(async () => (await bar.locator('[data-topbar-title]').boundingBox())?.width ?? 0,
          { message: `${destination.id} title floor` }).toBeGreaterThanOrEqual(FRAME.bar.titleMin)
        titleXs.push((await bar.locator('[data-topbar-title]').boundingBox())!.x)
      }
      expect(Math.max(...titleXs) - Math.min(...titleXs)).toBeLessThanOrEqual(1)
    })
  }
  test(`B6 one visible tile keeps its own draft and the room Holding chip in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=team', theme)
    await selectFrameTab(page, 'room')
    await page.getByRole('button', { name: 'Send to', exact: true }).click()
    await page.getByRole('switch', { name: 'Hold messages', exact: true }).click()
    const roomChip = page.locator('[data-slot="room-body"] [data-slot="composer-chip"]').filter({ hasText: 'Holding messages' })
    const title = await roomChip.getAttribute('title')
    await page.getByRole('button', { name: 'View', exact: true }).click()
    await page.getByRole('menuitemradio', { name: 'Side by side', exact: true }).click()
    await page.locator('[data-slot="side-by-side-tile"]:visible').first().getByRole('button', { name: / actions$/ }).click()
    await page.getByRole('menuitem', { name: /^Expand / }).click()
    await expect(page.locator('[data-slot="side-by-side-tile"]:visible')).toHaveCount(1)
    await expect(page.locator('[data-shared-composer]:visible')).toHaveCount(0)
    const own = page.locator('[data-slot="side-by-side-tile"]:visible [data-slot="composer"]')
    const chip = own.locator('[data-slot="composer-chip"]').filter({ hasText: 'Holding messages' })
    await expect(chip).toBeVisible()
    await expect(chip).toHaveAttribute('title', title!)
    await own.locator('textarea').fill('Keep this member draft')
    await expect(own.locator('textarea')).toBeEnabled()
    await expect(own.getByRole('button', { name: 'Send to', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'View', exact: true }).click()
    await page.getByRole('menuitemradio', { name: 'Thread', exact: true }).click()
    await page.getByRole('button', { name: 'Send to', exact: true }).click()
    await expect(page.getByRole('switch', { name: 'Hold messages', exact: true })).toHaveAttribute('aria-checked', 'true')
    await page.getByRole('switch', { name: 'Hold messages', exact: true }).click()
    await page.getByRole('button', { name: 'View', exact: true }).click()
    await page.getByRole('menuitemradio', { name: 'Side by side', exact: true }).click()
    await expect(own.locator('textarea')).toHaveValue('Keep this member draft')
    await expect(chip).toHaveCount(0)
  })
}

for (const theme of WALL_THEMES) {
  test(`B11 fixed tools retain work and refuse free docking in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation&frame-terminal=1', theme)
    const tools = page.locator('[data-slot="top-bar"] [data-work-tool]')
    await expect(tools).toHaveCount(4)
    await page.locator('[data-work-tool="details"]').click()
    await page.locator('[data-work-tool="activity"]').click()
    await page.locator('[data-work-tool="details"]').click()
    await expect(page.locator('[data-slot="tool-body"]:visible').getByText('Plan', { exact: true })).toBeVisible()
    await page.locator('[data-work-tool="details"]').click()
    await expect(page.locator('[data-slot="work-tools"]')).toBeHidden()
    await page.getByRole('button', { name: 'Toggle right panel', exact: true }).click()
    await expect(page.locator('[data-slot="work-tools"]')).toBeVisible()
    await expect(page.locator('[data-frame-region="bottom"] [data-terminal-id]')).toBeVisible()
    await expect(page.locator('[draggable="true"][data-tool-mount]')).toHaveCount(0)
    await expect(page.locator('[data-slot="dock-panel-tabs"]')).toHaveCount(0)
  })
}

for (const theme of WALL_THEMES) {
  test(`B11a bar order, switcher, pressed tools and continuous standing seam in ${theme}`, async ({ page }) => {
    for (const width of [1440, 1100, 720]) {
      await openFrame(page, 'frame-wall=team', theme, width)
      const bar = page.locator('[data-slot="top-bar"]:visible')
      await expect.poll(async () => (await bar.locator('[data-topbar-title]').boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(FRAME.bar.titleMin)
      const order = await bar.evaluate(node => [...node.children].map(one => one.getAttribute('data-topbar')))
      if (order.includes('state')) {
        expect(order.indexOf('place')).toBeLessThan(order.indexOf('state'))
        expect(order.indexOf('state')).toBeLessThan(order.indexOf('tabs'))
      }
      expect(order.indexOf('place')).toBeLessThan(order.indexOf('tabs'))
      expect(order.indexOf('tabs')).toBeLessThan(order.indexOf('spacer'))
      const track = bar.locator('[data-slot="tabs-list"]')
      if (await track.isVisible()) {
        expect(await track.evaluate(node => { const style = getComputedStyle(node); return [style.paddingTop, style.gap, style.borderRadius] })).toEqual(['2px', '1px', '8px'])
        expect(await track.locator('[role="tab"]').first().evaluate(node => { const style = getComputedStyle(node); return [node.getBoundingClientRect().height, style.paddingLeft, style.borderRadius, style.fontSize] })).toEqual([24, '9px', '6px', '13px'])
        expect(await track.locator('[aria-selected="true"]').evaluate(node => getComputedStyle(node).boxShadow)).not.toBe('none')
      }
      await bar.getByRole('button', { name: 'Details', exact: true }).click()
      const tools = bar.locator('[data-topbar="tools"]')
      const panel = page.locator('[data-slot="work-tools"]:visible')
      await expect(panel).toBeVisible()
      const pressed = bar.locator('[data-work-tool="details"]')
      await expect(pressed).toHaveAttribute('aria-pressed', 'true')
      expect(await pressed.evaluate(node => getComputedStyle(node).boxShadow)).toContain('inset')
      expect(await tools.evaluate(node => getComputedStyle(node).borderLeftWidth)).toBe(width >= FRAME.fold.panelFloats ? '1px' : '0px')
      if (width >= FRAME.fold.panelFloats) {
        const top = (await tools.boundingBox())!, body = (await panel.boundingBox())!
        expect(top.x).toBe(body.x)
        expect(top.width).toBe(body.width)
        expect(top.y).toBe(0)
      }
      await bar.getByRole('button', { name: 'Toggle right panel', exact: true }).click()
      expect(await tools.evaluate(node => getComputedStyle(node).borderLeftWidth)).toBe('0px')
    }
  })

  test(`B11a panel facts have one-line row density and Findings agrees with its tab in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=team', theme)
    const bar = page.locator('[data-slot="top-bar"]:visible')
    await bar.getByRole('button', { name: 'Details', exact: true }).click()
    const panel = page.locator('[data-slot="tool-body"]:visible')
    const facts = panel.locator('[data-slot="summary-item"]:not(:has([data-slot="summary-action"]))')
    const rows = await facts.evaluateAll(nodes => nodes.filter(node => !node.querySelector('[data-slot="summary-note"]')).map(node => node.getBoundingClientRect().height))
    expect(rows.length).toBeGreaterThan(2)
    expect(rows.every(height => height >= 36 && height <= 38)).toBe(true)
    await bar.getByRole('button', { name: 'Toggle right panel', exact: true }).click()
    await selectFrameTab(page, 'findings')
    await expect(bar.locator('[data-team-page="findings"]')).toContainText('3')
    expect(await page.locator('[aria-label="Findings summary"] [data-slot="summary-item"]').evaluateAll(nodes => nodes.map(node => [node.querySelector('dt')?.textContent, node.querySelector('[data-slot="summary-value"]')?.textContent]))).toEqual([['Open', '3'], ['Blocking', '3'], ['All', '3']])
    await expect(page.locator('[data-slot="workbench-main"]')).not.toContainText('No findings recorded')
  })
}

for (const theme of WALL_THEMES) {
  for (const width of WALL_WIDTHS) {
    for (const foundation of ['desk', 'studio'] as const) {
      test(`D7 group names sit with icons and following groups use the spacing token at ${width} in ${theme}/${foundation}`, async ({ page }, testInfo) => {
        await openFrame(page, 'frame-wall=left-work', theme, width)
        await page.locator('body').evaluate((body, value) => { body.dataset.hdInterface = value }, foundation)
        const column = page.locator('[data-left-column]:visible')
        if (!await column.count()) await page.getByRole('button', { name: 'Show sidebar', exact: true }).click()
        const token = await resolvedPx(page, '--hd-space-4')
        const sessions = await column.evaluate(column => {
          const inkX = (element: Element) => {
            const range = document.createRange()
            range.selectNodeContents(element)
            return range.getBoundingClientRect().x
          }
          const firstIcon = column.querySelector('[data-left-row] [data-slot="sidebar-menu-icon"]')!.getBoundingClientRect().x
          const dashboard = column.querySelector('[aria-label="Dashboard"]')!.getBoundingClientRect()
          const projects = column.querySelector('[data-left-projects-head] [data-slot="navigation-group-label"]')!
          const names = [...column.querySelectorAll('[data-left-group-text], [data-draggable] [data-slot="sidebar-menu-label-content"]')]
            .map(label => ({ label: label.textContent, x: inkX(label), size: parseFloat(getComputedStyle(label).fontSize), weight: parseInt(getComputedStyle(label).fontWeight, 10) }))
          const gaps = [{ label: 'Projects', gap: projects.getBoundingClientRect().top - dashboard.bottom }]
          const allRows = [...column.querySelectorAll('[data-left-row]')]
          for (const project of column.querySelectorAll('[data-project-root]')) {
            const label = project.querySelector('[data-draggable] [data-slot="sidebar-menu-label-content"]')!
            const heading = label.closest('[data-left-row]')!
            const previousRow = allRows[allRows.indexOf(heading) - 1]
            if (previousRow) gaps.push({ label: label.textContent!, gap: label.getBoundingClientRect().top - previousRow.getBoundingClientRect().bottom })
          }
          const rows = [...column.querySelectorAll('[data-left-row] [data-slot="sidebar-menu-button"]:not([aria-expanded])')].map(row => {
            const style = getComputedStyle(row)
            return { height: row.getBoundingClientRect().height, icon: row.querySelector('[data-slot="sidebar-menu-icon"]')!.getBoundingClientRect().width, gap: parseFloat(style.gap) }
          })
          const disclosures = [...column.querySelectorAll('[data-draggable]')].map(row => ({
            arrowX: row.querySelector('[data-slot="disclosure-chevron"]')!.getBoundingClientRect().x,
            nameRight: row.querySelector('[data-left-fold-name]')!.getBoundingClientRect().right,
          }))
          return { firstIcon, names, gaps, rows, disclosures }
        })
        const modes = []
        for (const query of ['frame-wall=settings', 'frame-wall=settings-middle']) {
          await openFrame(page, query, theme, width)
          if (query === 'frame-wall=settings' && width === 720) await page.getByRole('button', { name: 'Show sidebar', exact: true }).click()
          await page.locator('body').evaluate((body, value) => { body.dataset.hdInterface = value }, foundation)
          const navigation = page.locator(query === 'frame-wall=settings' ? '[aria-label="Settings navigation"]' : '[data-left-settings]')
          const groups = await navigation.locator('[data-left-group]').evaluateAll(groups => groups.map(group => {
            const previousRow = group.previousElementSibling?.querySelector('[data-left-row]:last-child')
            const label = group.querySelector(':scope > [data-slot="group-label"]')!
            const name = label.querySelector('[data-left-group-text]')!
            const range = document.createRange()
            range.selectNodeContents(name)
            const icon = group.querySelector('[data-left-row] [data-slot="sidebar-menu-icon"]')!
            return { label: name.textContent, x: range.getBoundingClientRect().x, iconX: icon.getBoundingClientRect().x,
              gap: previousRow ? label.getBoundingClientRect().top - previousRow.getBoundingClientRect().bottom : null,
              inset: label.getBoundingClientRect().top - group.getBoundingClientRect().top }
          }))
          expect(groups.length).toBeGreaterThan(1)
          modes.push({ query, groups })
        }
        await testInfo.attach('group-labels', { body: JSON.stringify({ width, theme, foundation, token, sessions, modes }, null, 2), contentType: 'application/json' })
        expect(sessions.names.length).toBeGreaterThan(2)
        for (const name of sessions.names) {
          expect(name.x, `Sessions: ${name.label}`).toBe(sessions.firstIcon)
          expect(name.size).toBe(FRAME.rail.label)
          expect(name.weight).toBe(FRAME.rail.groupWeight)
        }
        for (const group of sessions.gaps) expect(group.gap, `Sessions: ${group.label}`).toBe(token)
        for (const disclosure of sessions.disclosures) expect(disclosure.arrowX - disclosure.nameRight, 'disclosure follows the name by the spacing token').toBe(6)
        for (const row of sessions.rows) {
          expect(row.height).toBe(FRAME.rail.rowHeight)
          expect(row.icon).toBe(FRAME.rail.icon)
          expect(row.gap).toBe(FRAME.rail.gap)
        }
        for (const mode of modes) for (const group of mode.groups) {
          expect(group.x, `${mode.query}: ${group.label}`).toBe(group.iconX)
          if (group.gap !== null) expect(group.gap, `${mode.query}: ${group.label}`).toBe(token)
          else expect(group.inset, 'the first group keeps its existing spacing').toBe(0)
        }
      })
    }
  }
}

for (const theme of WALL_THEMES) {
  for (const foundation of ['desk', 'studio'] as const) {
  test(`D1 row anatomy in ${theme}/${foundation}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=left-column', theme)
    await page.locator('body').evaluate((body, value) => { body.dataset.hdInterface = value }, foundation)
    const rows = page.locator('[data-left-row]')
    await expect(rows).toHaveCount(4)
    const values = await rows.evaluateAll(nodes => nodes.map(node => {
      const button = node.querySelector<HTMLElement>('[data-slot="sidebar-menu-button"]')!
      const icon = button.querySelector<HTMLElement>('[data-slot="sidebar-menu-icon"]')!
      const label = button.querySelector<HTMLElement>('[data-slot="sidebar-menu-label-content"]')!
      const css = getComputedStyle(button)
      return { h: button.getBoundingClientRect().height, inset: parseFloat(css.paddingLeft), gap: parseFloat(css.gap),
        size: parseFloat(css.fontSize), weight: parseFloat(css.fontWeight), line: parseFloat(css.lineHeight), family: css.fontFamily, smoothing: css.getPropertyValue("-webkit-font-smoothing"), icon: icon.getBoundingClientRect().width,
        iconX: icon.getBoundingClientRect().x, textX: label.getBoundingClientRect().x,
        slots: node.querySelectorAll('[data-left-trailing]').length }
    }))
    for (const value of values) {
      expect(value.h).toBe(FRAME.rail.rowHeight)
      expect(value.inset).toBe(FRAME.rail.inset)
      expect(value.gap).toBe(FRAME.rail.gap)
      expect(value.icon).toBe(FRAME.rail.icon)
      expect(value.size).toBe(FRAME.rail.label)
      expect(value.weight).toBe(400)
      expect(value.line).toBe(FRAME.rail.line)
      expect(value.family).toContain('Geist')
      expect(value.smoothing).not.toBe('antialiased')
      expect(value.slots).toBe(1)
    }
    const group = await page.locator('[data-left-group-text]').evaluate(el => ({
      x: el.getBoundingClientRect().x,
      size: parseFloat(getComputedStyle(el).fontSize),
      weight: parseFloat(getComputedStyle(el).fontWeight),
    }))
    expect(group.size).toBe(FRAME.rail.label)
    expect(group.weight).toBe(FRAME.rail.groupWeight)
    expect(Math.abs(group.x - values[0]!.iconX)).toBeLessThanOrEqual(1)
    const controls = await page.locator('[data-left-top] button').evaluateAll(nodes => nodes.map(el => ({
      width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height,
    })))
    expect(controls).toHaveLength(4)
    for (const control of controls) {
      expect(control.width).toBe(FRAME.bar.iconButton)
      expect(control.height).toBe(FRAME.bar.iconButton)
    }
    const selected = page.locator('[data-left-row] [data-active="true"]')
    const fill = await selected.evaluate(el => {
      const expected = document.createElement('div')
      expected.style.background = 'var(--hd-selected)'
      el.append(expected)
      const result = [getComputedStyle(el).backgroundColor, getComputedStyle(expected).backgroundColor]
      expected.remove()
      return result
    })
    expect(fill[0]).toBe(fill[1])
    expect((await page.locator('[data-left-top]').boundingBox())!.height).toBe(FRAME.bar.height)
    expect((await page.locator('[data-left-seat]').locator('..').boundingBox())!.height).toBe(FRAME.bar.height)
    const seatTextX = await page.locator('[data-left-seat]').evaluate(seat => {
      const walker = document.createTreeWalker(seat, NodeFilter.SHOW_TEXT)
      let node: Node | null
      while ((node = walker.nextNode())) {
        if (node.textContent?.trim() === 'Jane Doe') {
          const range = document.createRange()
          range.selectNodeContents(node)
          return range.getBoundingClientRect().x
        }
      }
      throw new Error('Missing synthetic seat name')
    })
    expect(Math.abs(seatTextX - values[0]!.textX), 'seat and row ink share an edge').toBeLessThanOrEqual(1)
    for (const field of ['iconX', 'textX'] as const) {
      const xs = values.map(value => value[field])
      expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(1)
    }
  })
  }
}

// D2's standalone column proof; the shell-bottom/fold integration waits for B.
for (const theme of WALL_THEMES) {
  test(`D2 left header, page doors and seat in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation', theme)
    const column = page.locator('[data-left-column]:visible')
    const top = column.locator('[data-left-top]')
    await expect(top.locator('[data-slot="bar"]')).toHaveCount(1)
    expect((await top.boundingBox())!.height).toBe(FRAME.bar.height)
    await expect(top.locator('[data-role="wordmark"]')).toHaveCount(0)
    await expect(top.locator('[data-work-panel-toggle]')).toHaveCount(0)
    const rows = column.locator('[aria-label="Main sections"] [data-left-row]')
    await expect(rows).toHaveCount(5)
    const anatomy = await rows.evaluateAll(nodes => nodes.map(node => {
      const button = node.querySelector<HTMLElement>('[data-slot="sidebar-menu-button"]')!
      const css = getComputedStyle(button)
      return { name: button.getAttribute('aria-label'), height: button.getBoundingClientRect().height,
        size: parseFloat(css.fontSize), slots: node.querySelectorAll('[data-left-trailing]').length }
    }))
    expect(anatomy.map(row => row.name)).toEqual(['Teams', 'Agents', 'Library', 'Plugins', 'Dashboard'])
    for (const row of anatomy) {
      expect(row.height).toBe(FRAME.rail.rowHeight)
      expect(row.size).toBe(FRAME.rail.label)
      expect(row.slots).toBe(1)
    }
    const seat = column.locator('[data-left-seat]')
    expect((await seat.locator('..').boundingBox())!.height).toBe(FRAME.bar.height)
    await expect(seat.getByRole('button', { name: 'Settings', exact: true })).toHaveAttribute('aria-pressed', 'false')
    const start = column.getByRole('button', { name: 'New session', exact: true })
    await expect(start.locator('..').locator('[data-left-trailing] button')).toHaveCount(1)
  })
}


for (const theme of WALL_THEMES) {
  test(`D2 existing Settings rail shares row and group anatomy in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=settings', theme)
    const nav = page.getByRole('navigation', { name: 'Settings navigation' })
    const group = nav.locator('[data-left-group]').first()
    const rows = group.locator('[data-left-row]')
    await expect(rows).toHaveCount(4)
    const anatomy = await rows.evaluateAll(nodes => nodes.map(node => {
      const button = node.querySelector('[data-slot="sidebar-menu-button"]')!
      const icon = button.querySelector('[data-slot="sidebar-menu-icon"]')!
      const css = getComputedStyle(button)
      return { height: button.getBoundingClientRect().height, icon: icon.getBoundingClientRect().width,
        iconX: icon.getBoundingClientRect().x, size: parseFloat(css.fontSize) }
    }))
    for (const row of anatomy) {
      expect(row.height).toBe(FRAME.rail.rowHeight)
      expect(row.icon).toBe(FRAME.rail.icon)
      expect(row.size).toBe(FRAME.rail.label)
    }
    const ink = await group.locator('[data-left-group-text]').boundingBox()
    expect(ink!.x).toBe(anatomy[0]!.iconX)
    const general = rows.first().getByRole('button')
    await expect(general).toHaveAttribute('aria-current', 'page')
    await general.focus()
    await page.keyboard.press('ArrowDown')
    await expect(rows.nth(1).getByRole('button')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(rows.nth(1).getByRole('button')).toHaveAttribute('aria-current', 'page')
    await nav.getByRole('searchbox', { name: 'Search settings' }).fill('keyboard')
    await expect(nav.locator('[data-left-group] [data-left-row]')).toHaveCount(1)
    await expect(nav.getByRole('button', { name: 'Keyboard shortcuts', exact: true })).toBeVisible()
    await expect(nav.getByRole('button', { name: 'Back', exact: true })).toBeVisible()
  })
}

for (const theme of WALL_THEMES) {
  test(`D3 Teams are single rows in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=left-work', theme)
    const team = page.getByRole('button', { name: 'Room Ship checkout retry', exact: true })
    await expect(team).toBeVisible()
    expect((await team.boundingBox())!.height).toBe(FRAME.rail.rowHeight)
    await expect(team.locator('..').locator('[data-left-trailing]')).toHaveCount(1)
    await expect(page.locator('[data-left-column] [data-nested="true"]')).toHaveCount(0)
    await expect(page.locator('[data-left-column] [aria-label*="agents in"]')).toHaveCount(0)
    await team.click()
    await expect(team).toHaveAttribute('aria-current', 'page')
  })
}

for (const theme of WALL_THEMES) {
  test(`D4 all work rows share the same text and icon edges in ${theme}`, async ({ page }) => {
    await openFrame(page, 'sidebar-structure', theme)
    const column = page.locator('#sidebar-structure')
    const rows = column.locator('[data-left-row]:visible:not(:has([data-draggable]))')
    expect(await rows.count()).toBeGreaterThan(3)
    const values = await rows.evaluateAll(nodes => nodes.map(node => {
      const button = node.querySelector<HTMLElement>('[data-slot="sidebar-menu-button"]')!
      const icon = button.querySelector<HTMLElement>('[data-slot="sidebar-menu-icon"]')!
      const text = button.querySelector<HTMLElement>('[data-slot="sidebar-menu-label-content"]')!
      return { h: button.getBoundingClientRect().height, text: text.getBoundingClientRect().x, icon: icon.getBoundingClientRect().x }
    }))
    for (const row of values) expect(row.h).toBe(FRAME.rail.rowHeight)
    for (const field of ['text', 'icon'] as const) {
      const xs = values.map(row => row[field])
      expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(1)
    }
    const labels = await column.locator('[data-left-group] > [data-slot="group-label"] [data-left-group-text]:visible')
      .evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().x))
    for (const x of labels) expect(Math.abs(x - values[0].icon)).toBeLessThanOrEqual(1)
    const groupType = await column.locator('[data-left-group] > [data-slot="group-label"] [data-left-group-text]:visible')
      .evaluateAll(nodes => nodes.map(node => ({ size: parseFloat(getComputedStyle(node).fontSize), weight: parseInt(getComputedStyle(node).fontWeight, 10) })))
    for (const group of groupType) { expect(group.size).toBe(FRAME.rail.label); expect(group.weight).toBe(FRAME.rail.groupWeight) }
    await expect(column.locator('[data-nested="true"]')).toHaveCount(0)
    await expect(column.locator('[aria-label*="agents in"]')).toHaveCount(0)
  })
}

for (const theme of WALL_THEMES) {
  test(`D4 trailing substitution and keyboard menus in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=left-work', theme)
    const column = page.locator('[data-left-column]:visible')
    const project = column.getByRole('button', { name: 'atlas', exact: true })
    const projectRow = project.locator('..')
    await page.mouse.move(0, 0)
    await expect(projectRow.locator('[data-left-mark]')).toBeVisible()
    await project.hover()
    await expect(projectRow.getByRole('button', { name: 'New session in atlas', exact: true })).toBeVisible()
    await expect(projectRow.locator('[data-left-mark]')).toBeHidden()
    await expect(projectRow.getByRole('button', { name: 'Actions for atlas', exact: true })).toHaveCount(0)
    await project.focus()
    await page.keyboard.press('Shift+F10')
    await expect(page.getByRole('menu').last()).toBeVisible()
    await page.keyboard.press('Escape')
    await project.focus()
    await project.dispatchEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true })
    await expect(page.getByRole('menu').last()).toBeVisible()
    await page.keyboard.press('Escape')
    const session = column.getByRole('button', { name: 'Release notes', exact: true })
    expect((await session.boundingBox())!.height).toBe(FRAME.rail.rowHeight)
    await session.hover()
    const more = session.locator('..').getByRole('button', { name: 'Actions for Release notes', exact: true })
    await expect(more).toBeVisible()
    await session.focus()
    await page.keyboard.press('Shift+F10')
    await expect(page.getByRole('menu').last()).toBeVisible()
    await page.keyboard.press('Escape')
    await session.focus()
    await session.dispatchEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true })
    await expect(page.getByRole('menu').last()).toBeVisible()
    await page.keyboard.press('Escape')
    await session.hover()
    await more.click()
    await page.getByRole('menuitem', { name: /^Rename/ }).click()
    const rename = column.locator('[data-left-rename]')
    expect((await rename.boundingBox())!.height).toBe(FRAME.rail.rowHeight)
    await rename.locator('input').press('Escape')
    expect((await session.boundingBox())!.height).toBe(FRAME.rail.rowHeight)
  })
}


for (const theme of WALL_THEMES) {
  test(`D4 work catalogue uses the same regions and fixed rename in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=left-work-pattern', theme)
    const column = page.locator('[data-left-column]')
    const rows = column.locator('[data-left-row]')
    await expect(rows).toHaveCount(2)
    const ordinary = rows.filter({ hasNot: page.locator('[data-draggable]') })
    const project = rows.filter({ has: page.locator('[data-draggable]') })
    const iconX = (await ordinary.locator('[data-slot="sidebar-menu-icon"]').boundingBox())!.x
    expect((await project.locator('[data-slot="sidebar-menu-label-content"]').boundingBox())!.x,
      'project name starts at the ordinary icon edge').toBe(iconX)
    expect((await ordinary.locator('[data-slot="sidebar-menu-label-content"]').boundingBox())!.x - iconX,
      'ordinary row text keeps its icon and gap').toBe(FRAME.rail.icon + FRAME.rail.gap)
    for (const row of await rows.all()) expect((await row.boundingBox())!.height).toBe(FRAME.rail.rowHeight)
    expect((await column.locator('[data-left-rename]').boundingBox())!.height).toBe(FRAME.rail.rowHeight)
    expect((await column.getByRole('textbox', { name: 'Rename example' }).boundingBox())!.height).toBe(FRAME.rail.rowHeight)
    await expect(column).toContainText('No conversations yet')
  })
}

for (const theme of WALL_THEMES) {
  test(`D5 preference groups and search in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=settings-middle', theme)
    const nav = page.locator('[data-left-settings]')
    const labels = await nav.locator('[data-left-group-text]').allTextContents()
    expect(labels).toEqual(['General', 'Conversations', 'Agents', 'Access'])
    for (const row of await nav.locator('[data-left-row]').all()) {
      expect((await row.boundingBox())!.height).toBe(FRAME.rail.rowHeight)
    }
    await expect(nav.getByRole('button', { name: 'Back', exact: true })).toBeVisible()
    await expect(nav.getByRole('button', { name: 'Library', exact: true })).toHaveCount(0)
    await expect(nav.getByRole('button', { name: 'Plugins', exact: true })).toHaveCount(0)
    await nav.getByRole('searchbox', { name: 'Search settings' }).fill('mute')
    await expect(nav.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible()
    await expect(nav.getByRole('button', { name: 'General', exact: true })).toHaveCount(0)
    await nav.getByRole('searchbox', { name: 'Search settings' }).fill('zzzz')
    await expect(nav).toContainText('Nothing in settings matches')
  })
}


for (const theme of WALL_THEMES) {
  test(`D5 controlled keyboard, Back and full search field in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=settings-middle', theme)
    const nav = page.locator('[data-left-settings]')
    const back = nav.getByRole('button', { name: 'Back', exact: true })
    const general = nav.getByRole('button', { name: 'General', exact: true })
    const appearance = nav.getByRole('button', { name: 'Appearance', exact: true })
    await expect(general).toHaveAttribute('aria-current', 'page')
    await back.focus()
    await page.keyboard.press('ArrowDown')
    await expect(general).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(appearance).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(appearance).toHaveAttribute('aria-current', 'page')
    await back.focus()
    await page.keyboard.press('Enter')
    await expect(general).toHaveAttribute('aria-current', 'page')
    const search = nav.getByRole('searchbox', { name: 'Search settings' })
    await search.focus()
    await page.keyboard.press('ArrowDown')
    await expect(search).toBeFocused()
    const field = (await nav.locator('[data-slot="search"]').boundingBox())!
    const middle = (await nav.boundingBox())!
    expect(field.x).toBe(middle.x)
    expect(field.width).toBe(middle.width)
    await search.fill('no matching preference with a deliberately long search phrase')
    const empty = await nav.locator('p').evaluate(node => ({
      height: node.getBoundingClientRect().height,
      line: parseFloat(getComputedStyle(node).lineHeight),
      width: node.clientWidth,
      scroll: node.scrollWidth,
    }))
    expect(empty.height).toBeGreaterThan(empty.line)
    expect(empty.scroll).toBeLessThanOrEqual(empty.width)
  })
}

import type { Locator } from '@playwright/test'

const menuMetrics = async (surface: Locator) => surface.evaluate((el) => {
  const css = getComputedStyle(el)
  const box = el.getBoundingClientRect()
  return { width: box.width, radius: css.borderTopLeftRadius, pad: [css.paddingTop, css.paddingRight, css.paddingBottom, css.paddingLeft], border: css.borderTopWidth, overflow: el.scrollWidth > el.clientWidth || [...el.querySelectorAll<HTMLElement>('[data-menu-label],[data-menu-hint],[data-menu-meter],[data-info-note]')].some(node => node.scrollWidth > node.clientWidth) }
})
const rowMetrics = async (surface: Locator) => surface.evaluate(surface => [...surface.querySelectorAll('[data-menu-row]')].filter(el => el.closest('[data-popup-kind]') === surface).map(el => {
  const css = getComputedStyle(el)
  const label = el.querySelector('[data-menu-label]')!
  const hint = el.querySelector('[data-menu-hint]')
  const icon = el.querySelector('[data-menu-icon]')
  return { height: el.getBoundingClientRect().height, radius: css.borderTopLeftRadius, padTop: parseFloat(css.paddingTop), padBottom: parseFloat(css.paddingBottom), labelHeight: label.getBoundingClientRect().height, labelSize: getComputedStyle(label).fontSize, labelLine: getComputedStyle(label).lineHeight, labelWeight: getComputedStyle(label).fontWeight, font: getComputedStyle(label).fontFamily, smoothing: getComputedStyle(label).getPropertyValue('-webkit-font-smoothing'), hintHeight: hint?.getBoundingClientRect().height ?? 0, meterHeight: el.querySelector('[data-menu-meter]')?.getBoundingClientRect().height ?? 0, hintSize: hint ? getComputedStyle(hint).fontSize : null, hintLine: hint ? getComputedStyle(hint).lineHeight : null, icon: Boolean(icon), iconWidth: icon?.getBoundingClientRect().width ?? 0, gap: parseFloat(css.columnGap), iconTop: icon?.getBoundingClientRect().top ?? 0, labelTop: label.getBoundingClientRect().top }
}))
const expectMenuPlateGeometry = async (surface: Locator) => {
  const m = await menuMetrics(surface)
  expect(m.width).toBeGreaterThanOrEqual(FRAME_MENU.min)
  expect(m.width).toBeLessThanOrEqual(FRAME_MENU.max)
  expect(m.pad).toEqual(Array(4).fill(`${FRAME_MENU.padding}px`))
  expect(m.radius).toBe(`${FRAME_MENU.radius}px`)
  expect(m.border).toBe('0px')
  expect(m.overflow).toBe(false)
}
const expectMenuGeometry = async (surface: Locator) => {
  await expectMenuPlateGeometry(surface)
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
  await expectMenuAnatomy(surface, rows[0]!.icon)
}
const expectMenuAnatomy = async (surface: Locator, icons: boolean) => {
  const anatomy = await surface.evaluate(el => {
    const secondary = getComputedStyle(el).getPropertyValue('--hd-secondary-foreground').trim()
    const probe = document.createElement('span'); probe.style.color = secondary; el.append(probe)
    const secondaryColor = getComputedStyle(probe).color; probe.remove()
    const own = (node: Element) => node.closest('[data-popup-kind]') === el
    return {
      groups: [...el.querySelectorAll('[data-menu-group]')].filter(own).map(node => { const css = getComputedStyle(node); return { size: css.fontSize, weight: css.fontWeight, color: css.color } }),
      hints: [...el.querySelectorAll('[data-menu-hint]')].filter(own).map(node => getComputedStyle(node).color),
      separators: [...el.querySelectorAll('[data-menu-separator]')].filter(own).map(node => { const css = getComputedStyle(node); return { height: node.getBoundingClientRect().height, margins: [css.marginTop, css.marginRight, css.marginBottom, css.marginLeft] } }),
      secondaryColor,
    }
  })
  for (const group of anatomy.groups) expect(group).toEqual({ size: `${FRAME_MENU.groupSize}px`, weight: String(FRAME_MENU.groupWeight), color: anatomy.secondaryColor })
  const hintInk = await surface.evaluate(el => {
    const probe = document.createElement('span'); probe.style.color = 'var(--hd-muted-foreground)'; el.append(probe)
    const muted = getComputedStyle(probe).color; probe.remove()
    const enabled: string[] = []; const refused: string[] = []
    for (const hint of el.querySelectorAll('[data-menu-hint]')) {
      if (hint.closest('[data-popup-kind]') !== el) continue
      (hint.closest('[data-menu-row]:is([data-disabled],[aria-disabled="true"],:disabled)') ? refused : enabled).push(getComputedStyle(hint).color)
    }
    return { muted, enabled, refused }
  })
  for (const color of hintInk.refused) expect(color).toBe(hintInk.muted)
  anatomy.hints = hintInk.enabled
  for (const color of anatomy.hints) expect(color).toBe(anatomy.secondaryColor)
  for (const separator of anatomy.separators) expect(separator).toEqual({ height: FRAME_MENU.separator, margins: Array(4).fill(`${FRAME_MENU.padding}px`) })
  const edge = await surface.evaluate(el => {
    const box = el.getBoundingClientRect()
    const labels = [...el.querySelectorAll<HTMLElement>('[data-menu-label],[data-menu-group],[data-menu-note],[data-menu-footer],[data-menu-search]')]
    return labels.filter(n => n.offsetParent !== null && n.closest('[data-popup-kind]') === el).map(n => {
      const css = getComputedStyle(n)
      return n.getBoundingClientRect().left + parseFloat(css.paddingLeft) - box.left
    })
  })
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

// The independent Composer subset of C2; More/Undo follows B after the merge.
for (const theme of WALL_THEMES) for (const width of [1440, 1100, 720]) {
  test(`C2 Composer Add at ${width} in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation', theme, width)
    await page.getByRole('button', { name: 'Add', exact: true }).first().click()
    const surface = page.locator('[data-popup-kind="menu"]:visible').last()
    await expect(surface).toBeVisible()
    await expectMenuGeometry(surface)
    const rows = surface.locator('[data-menu-row]')
    expect(await rows.count()).toBeGreaterThanOrEqual(4)
    await expect(surface.getByRole('menuitem', { name: 'Add a file @', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: 'Add', exact: true }).first()).toBeFocused()
  })
}

for (const theme of ['light', 'dark'] as const) for (const width of [1440, 1100, 720]) {
  test(`E1a navigation model preserves the work frame ${width} ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=team', theme, width)
    const bar = page.locator('[data-slot="top-bar"]:visible')
    expect((await bar.locator('..').boundingBox())!.height).toBe(FRAME.bar.height)
    await expect(page.locator('[data-slot="status-bar"], [data-shell-host="status"]')).toHaveCount(0)
  })
}

for (const theme of WALL_THEMES) for (const width of WALL_WIDTHS) {
  test(`B11a reconcile step rails stay below dots and stop at group ends at ${width} in ${theme}`, async ({ page }, testInfo) => {
    await openFrame(page, 'frame-wall=team-run-recorded', theme, width)
    await selectFrameTab(page, 'run')
    const timeline = page.locator('[aria-label="Run timeline"]')
    await expect(timeline.locator('[data-slot="timeline-item"]')).toHaveCount(5)
    const geometry = await timeline.evaluate(node => [...node.children].map(item => {
      const rect = item.getBoundingClientRect(), rail = item.querySelector<HTMLElement>(':scope > [data-slot="timeline-rail"]')!
      const line = rail.getBoundingClientRect()
      return { slot: item.getAttribute('data-slot'), x: rect.x, y: rect.y, height: rect.height,
        rail: { display: getComputedStyle(rail).display, x: line.x, y: line.y, bottom: line.bottom, width: line.width },
        last: item.nextElementSibling?.getAttribute('data-slot') !== 'timeline-item' }
    }))
    await testInfo.attach('step-rail-geometry', { body: JSON.stringify(geometry, null, 2), contentType: 'application/json' })
    for (const item of geometry) {
      if (item.slot === 'timeline-section' || item.last) expect(item.rail.display).toBe('none')
      else {
        expect(item.rail.y - item.y).toBe(22)
        expect(item.rail.x - item.x).toBe(9)
        expect(item.rail.bottom).toBe(item.y + item.height)
        expect(item.rail.width).toBe(1)
      }
    }
  })
  test(`B11a reconcile missing Run facts use secondary 12px type on the key edge at ${width} in ${theme}`, async ({ page }, testInfo) => {
    await openFrame(page, 'frame-wall=team-run-recorded', theme, width)
    await selectFrameTab(page, 'run')
    await page.locator('[data-slot="top-bar"]:visible').getByRole('button', { name: 'Details', exact: true }).click()
    const panel = page.locator('[data-slot="tool-body"]:visible')
    const note = panel.locator('[data-slot="tool-prose"]').filter({ hasText: 'Not recorded for this Run:' })
    await expect(note).toBeVisible()
    const geometry = await note.evaluate(node => {
      const text = node.querySelector<HTMLElement>('[data-slot="text"]')!, style = getComputedStyle(text)
      const key = node.parentElement!.querySelector('dt')!
      const probe = document.createElement('span'); probe.style.color = 'var(--hd-secondary-foreground)'; node.append(probe)
      const secondaryColor = getComputedStyle(probe).color; probe.remove()
      const range = document.createRange(); range.selectNodeContents(text)
      return { x: range.getBoundingClientRect().x, y: range.getBoundingClientRect().y, keyX: key.getBoundingClientRect().x,
        size: parseFloat(style.fontSize), color: style.color, secondaryColor }
    })
    await testInfo.attach('missing-facts-geometry', { body: JSON.stringify(geometry, null, 2), contentType: 'application/json' })
    expect(geometry.size).toBe(12)
    expect(geometry.color).toBe(geometry.secondaryColor)
    expect(geometry.x).toBe(geometry.keyX)
  })
}

for (const theme of WALL_THEMES) {
  test(`B11a reconcile disabled start menu retains icons and mutes the whole row in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation', theme)
    await page.locator('[data-left-column]').getByRole('button', { name: 'More ways to start', exact: true }).click()
    const row = page.getByRole('menuitem', { name: /New worktree/ })
    await expect(row).toBeDisabled()
    await expect(row.locator('[data-menu-icon]')).toHaveCount(1)
    const ink = await row.evaluate(node => [node, ...node.querySelectorAll('[data-menu-icon],[data-menu-label],[data-menu-hint]')].map(one => getComputedStyle(one).color))
    expect(new Set(ink).size).toBe(1)
  })
}

for (const theme of WALL_THEMES) {
  test(`B11m merged seams clamp to both approved drag endpoints in ${theme}`, async ({ page }, testInfo) => {
    await openFrame(page, 'frame-wall=conversation', theme, 1800)
    const left = page.locator('[data-frame-region="left"]:visible')
    const panel = page.locator('[data-frame-region="right"]:visible')
    const measurements: Record<string, number> = {}
    const drag = async (name: string, delta: number) => {
      const seam = page.getByRole('separator', { name, exact: true })
      const box = (await seam.boundingBox())!
      await page.mouse.move(box.x + box.width / 2, 400)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width / 2 + delta, 400, { steps: 8 })
      await page.mouse.up()
    }
    await drag('Resize the sidebar', 500)
    await expect.poll(async () => (await left.boundingBox())!.width).toBe(FRAME.sidebar.max)
    measurements.leftMax = (await left.boundingBox())!.width
    await drag('Resize the sidebar', -500)
    await expect.poll(async () => (await left.boundingBox())!.width).toBe(FRAME.sidebar.min)
    measurements.leftMin = (await left.boundingBox())!.width
    await page.locator('[data-work-tool="details"]').click()
    await drag('Resize the right panel', -800)
    await expect.poll(async () => (await panel.boundingBox())!.width).toBe(FRAME.rightPanel.max)
    measurements.rightMax = (await panel.boundingBox())!.width
    await drag('Resize the right panel', 800)
    await expect.poll(async () => (await panel.boundingBox())!.width).toBe(FRAME.rightPanel.min)
    measurements.rightMin = (await panel.boundingBox())!.width
    await testInfo.attach('merged-seam-endpoints', { body: JSON.stringify(measurements), contentType: 'application/json' })
  })
}
for (const theme of WALL_THEMES) {
  test(`D6a owner top order and seat bell in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation', theme)
    const column = page.locator('[data-left-column]:visible')
    expect((await column.boundingBox())!.width).toBe(FRAME.sidebar.width)
    const top = column.locator('[data-left-top]')
    expect(await top.locator('button').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))))
      .toEqual(['Hide sidebar', 'Search everything', 'Back', 'Forward'])
    await expect(top.locator('[data-slot="inbox-button"]')).toHaveCount(0)
    const seat = column.locator('[data-left-seat]')
    const bell = seat.locator('[data-slot="inbox-button"]').locator('..')
    await expect(bell).toBeVisible()
    expect((await bell.boundingBox())!.width).toBe(FRAME.bar.iconButton)
    expect((await bell.boundingBox())!.height).toBe(FRAME.bar.iconButton)
    const gear = seat.getByRole('button', { name: 'Settings', exact: true })
    expect((await gear.boundingBox())!.x).toBeGreaterThan((await bell.boundingBox())!.x)
    await bell.click()
    await expect(page.getByRole('dialog', { name: 'Inbox', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
  })
}

test('D6 active Settings column owns the gear and keyboard focus', async ({ page }) => {
  await openFrame(page, 'frame-wall=settings', 'light')
  const modal = page.locator('[data-slot="app-window"]:visible')
  const column = modal.locator('[data-left-column]:visible')
  await expect(column).toHaveCount(1)
  await expect(column.locator('[data-left-seat] button[aria-label="Settings"]')).toHaveAttribute('aria-pressed', 'true')
  await column.getByRole('button', { name: 'Appearance', exact: true }).focus()
  await page.keyboard.press('ArrowDown')
  await expect(column.getByRole('button', { name: 'Notifications', exact: true })).toBeFocused()
  await expect(page.locator('[data-frame-region="left"] [data-left-column]:visible')).toHaveCount(0)
})

for (const theme of WALL_THEMES) {
  for (const width of [1440, 1100, 720]) {
    test(`D6 Settings is a visible aligned mode at ${width} in ${theme}`, async ({ page }) => {
      await openFrame(page, 'frame-wall=settings-navigation', theme, width)
      const modal = page.locator('[data-slot="app-window"]:visible')
      let column = modal.locator('[data-left-column]:visible')
      if (await column.count() === 0) {
        await modal.getByRole('button', { name: 'Show sidebar', exact: true }).click()
      }
      column = modal.locator('[data-left-column]:visible')
      await expect(column).toHaveCount(1)
      const top = column.locator('[data-left-top] [data-slot="bar"]')
      const main = modal.locator('[data-shell-host="top"] [data-slot="bar"]')
      const topBox = (await top.boundingBox())!, mainBox = (await main.boundingBox())!
      expect(topBox.height).toBe(FRAME.bar.height)
      expect(Math.abs(topBox.y + topBox.height - mainBox.y - mainBox.height)).toBeLessThanOrEqual(1)
      const seatBox = (await column.locator('[data-left-seat]').locator('..').boundingBox())!
      await expect(modal.locator('[data-slot="status-bar"], [data-shell-host="status"]')).toHaveCount(0)
      const windowBox = (await modal.boundingBox())!
      expect(seatBox.height).toBe(FRAME.bar.height)
      expect(Math.abs(seatBox.y + seatBox.height - windowBox.y - windowBox.height)).toBeLessThanOrEqual(1)
      await expect(column.locator('[data-left-seat]').getByRole('button', { name: 'Settings', exact: true }))
        .toHaveAttribute('aria-pressed', 'true')
      const values = await column.locator('[data-left-row]:visible').evaluateAll(nodes => nodes.map(node => {
        const button = node.querySelector<HTMLElement>('[data-slot="sidebar-menu-button"]')!
        return { height: button.getBoundingClientRect().height,
          icon: button.querySelector<HTMLElement>('[data-slot="sidebar-menu-icon"]')!.getBoundingClientRect().x,
          text: button.querySelector<HTMLElement>('[data-slot="sidebar-menu-label-content"]')!.getBoundingClientRect().x }
      }))
      expect(values.length).toBeGreaterThan(10)
      await expect(column.getByRole('button', { name: 'New session', exact: true })).toHaveCount(0)
      await expect(column.locator('[aria-label="Main sections"]:visible')).toHaveCount(0)
      for (const row of values) expect(row.height).toBe(FRAME.rail.rowHeight)
      for (const edge of ['text', 'icon'] as const) {
        const xs = values.map(row => row[edge])
        expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(1)
      }
      await column.getByRole('searchbox', { name: 'Search settings' }).fill('mute')
      await expect(column.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible()
      await expect(column.getByRole('button', { name: 'General', exact: true })).toHaveCount(0)
      await column.getByRole('searchbox', { name: 'Search settings' }).fill('')
      await column.getByRole('button', { name: 'Appearance', exact: true }).click()
      await expect(column.getByRole('button', { name: 'Appearance', exact: true })).toHaveAttribute('aria-current', 'page')
      await column.getByRole('button', { name: 'Settings', exact: true }).click()
      await expect(column.getByRole('button', { name: 'Appearance', exact: true })).toHaveAttribute('aria-current', 'page')
      await column.locator('[data-left-settings]').getByRole('button', { name: 'Back', exact: true }).click()
      await expect(page.locator('[data-slot="app-window"]:visible')).toHaveCount(0)
    })
  }
  for (const destination of ['library', 'plugins']) {
    test(`D6 ${destination} keeps its Sessions door in ${theme}`, async ({ page }) => {
      await openFrame(page, `frame-wall=${destination}`, theme)
      const column = page.locator('[data-slot="app-window"]:visible [data-left-column]:visible')
      const label = destination === 'library' ? 'Library' : 'Plugins'
      await expect(column.getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-current', 'page')
      await expect(column.locator('[data-left-seat]').getByRole('button', { name: 'Settings', exact: true }))
        .toHaveAttribute('aria-pressed', 'false')
      await expect(column.locator('[data-left-settings]:visible')).toHaveCount(0)
    })
  }
}
test('D6 Escape closes the Settings float before the window and restores its lead focus', async ({ page }) => {
  await openFrame(page, 'frame-wall=settings-navigation', 'light', 720)
  const modal = page.locator('[data-slot="app-window"]:visible')
  const show = modal.getByRole('button', { name: 'Show sidebar', exact: true })
  await show.click()
  const column = modal.locator('[data-left-column]:visible')
  await expect(column).toHaveCount(1)
  const back = column.locator('[data-left-settings]').getByRole('button', { name: 'Back', exact: true })
  await back.focus()
  await page.keyboard.press('Escape')
  await expect(modal).toHaveCount(1)
  await expect(modal.locator('[data-left-column]:visible')).toHaveCount(0)
  await expect(show).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-slot="app-window"]:visible')).toHaveCount(0)
})
test('D6 float keeps portalled account actions and traps its boundary', async ({ page }) => {
  await openFrame(page, 'frame-wall=settings-navigation', 'light', 720)
  const modal = page.locator('[data-slot="app-window"]:visible')
  const show = modal.getByRole('button', { name: 'Show sidebar', exact: true })
  await show.click()
  const column = modal.locator('[data-left-column]:visible')
  const hide = column.getByRole('button', { name: 'Hide sidebar', exact: true })
  const gear = column.locator('[data-left-seat]').getByRole('button', { name: 'Settings', exact: true })
  await gear.focus(); await page.keyboard.press('Tab'); await expect(hide).toBeFocused()
  await page.keyboard.press('Shift+Tab'); await expect(gear).toBeFocused()
  await column.locator('[data-left-seat] [data-slot="popover-trigger"]:not(:has([data-slot="inbox-button"]))').click()
  await page.locator('[data-layout="profile"]:visible').click()
  await expect(column).toBeVisible()
  await expect(modal.locator('input[aria-label="Your name"]')).toBeVisible()
  await column.locator('[data-left-seat] [data-slot="popover-trigger"]:not(:has([data-slot="inbox-button"]))').click()
  await page.keyboard.press('Escape')
  await expect(column).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(column).toBeHidden(); await expect(show).toBeFocused()
  await show.click()
  await modal.locator('[data-app-window-left-frame]').click({ position: { x: 500, y: 150 } })
  await expect(column).toBeHidden(); await expect(modal).toBeVisible()
})

for (const theme of WALL_THEMES) {
  for (const foundation of ['desk', 'studio'] as const) {
  for (const destination of ['conversation', 'settings-navigation']) {
    for (const width of [200, 239, 240, FRAME.sidebar.width, 360]) {
      test(`D7 ${destination} left width ${width} in ${theme}/${foundation}`, async ({ page }) => {
        await openFrame(page, `frame-wall=${destination}`, theme)
        await page.locator('body').evaluate((body, value) => { body.dataset.hdInterface = value }, foundation)
        await page.evaluate(value => {
          (window as Window & { __hdFrameWall: { resizeLeft: (width: number) => void } }).__hdFrameWall.resizeLeft(value)
        }, width)
        const column = page.locator('[data-left-column]:visible')
        await expect(column).toHaveCount(1)
        const region = destination === 'settings-navigation' ? page.locator('[data-app-window-left]:visible') : column
        expect(Math.abs((await region.boundingBox())!.width - width)).toBeLessThanOrEqual(1)
        const history = column.locator('[data-left-history]')
        if (width < 240) await expect(history).toBeHidden()
        else await expect(history).toBeVisible()
        const top = (await column.locator('[data-left-top] [data-slot="bar"]').boundingBox())!
        expect(top.height).toBe(FRAME.bar.height)
        const geometry = await column.locator('[data-left-row]:not([data-left-project]):visible').evaluateAll(nodes => nodes.map(node => {
          const button = node.querySelector<HTMLElement>('[data-slot="sidebar-menu-button"]')!
          return { height: button.getBoundingClientRect().height,
            text: button.querySelector<HTMLElement>('[data-slot="sidebar-menu-label-content"]')!.getBoundingClientRect().x,
            icon: button.querySelector<HTMLElement>('[data-slot="sidebar-menu-icon"]')!.getBoundingClientRect().x }
        }))
        expect(geometry.length).toBeGreaterThan(2)
        for (const row of geometry) expect(row.height).toBe(FRAME.rail.rowHeight)
        for (const field of ['text', 'icon'] as const) {
          const xs = geometry.map(row => row[field])
          expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(1)
        }
        const seat = column.locator('[data-left-seat]')
        expect((await seat.locator('..').boundingBox())!.height).toBe(FRAME.bar.height)
        await expect(seat.getByRole('button', { name: 'Settings', exact: true }))
          .toHaveAttribute('aria-pressed', destination === 'settings-navigation' ? 'true' : 'false')
      })
    }
  }
  }
}

for (const theme of WALL_THEMES) {
  test(`D7 Settings opened from the work float restores its own lead in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation', theme, 720)
    await page.locator('[data-slot="top-bar"]').getByRole('button', { name: 'Show sidebar', exact: true }).click()
    await page.locator('[data-left-column]:visible [data-left-seat]').getByRole('button', { name: 'Settings', exact: true }).click()
    const modal = page.locator('[data-slot="app-window"]:visible')
    const column = modal.locator('[data-left-column]:visible')
    await expect(column).toBeVisible()
    await column.locator('[data-left-seat] [data-slot="popover-trigger"]:not(:has([data-slot="inbox-button"]))').click()
    await page.keyboard.press('Escape')
    await expect(column).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(column).toBeHidden()
    await expect(modal.getByRole('button', { name: 'Show sidebar', exact: true })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(modal).toHaveCount(0)
  })
}

// D7a is additive. Measure painted list content, rather than the containing
// backgrounds and hit targets, whose inset deliberately precedes their ink.
const d7a = test.extend({})
d7a.use({ screenshot: 'off', trace: 'off' })
d7a.describe('D7a heading disclosure', () => {
  for (const theme of WALL_THEMES) for (const width of WALL_WIDTHS) {
    for (const mode of ['left-work', 'settings-navigation'] as const) {
      d7a(`D7a ${mode} list ink respects the gutter and disclosures follow names at ${width} in ${theme}`, async ({ page }) => {
        await openFrame(page, `frame-wall=${mode}`, theme, width)
        await applyLeftColumnActions(page, { leftOpen: true })
        const column = page.locator('[data-left-column]:visible')
        // Include the default and both clamp endpoints in standing and floating modes.
        for (const leftWidth of [256, 200, 360]) {
          await applyLeftColumnActions(page, { leftOpen: true, leftWidth })
          await column.evaluate(node => { if (node.contains(document.activeElement)) (document.activeElement as HTMLElement).blur() })
          await page.mouse.move(width - 1, 899)
          const gutter = await column.evaluate(node => node.getBoundingClientRect().left) + 16
          const escaped = await column.evaluate((column, gutter) => {
            const visible = (node: Element) => {
              for (let ancestor: Element | null = node; ancestor; ancestor = ancestor.parentElement) {
                const css = getComputedStyle(ancestor)
                if (css.display === 'none' || css.visibility !== 'visible' || css.opacity === '0') return false
              }
              return node.getBoundingClientRect().width > 0
            }
            const failures: { text: string; x: number }[] = []
            for (const root of column.querySelectorAll('[data-region="sidebar-content"], nav[aria-label="Workspace actions"], [data-left-head]')) {
              for (const node of root.querySelectorAll('svg, img')) {
                if (visible(node) && node.getBoundingClientRect().left < gutter) failures.push({ text: node.getAttribute('data-slot') ?? node.tagName, x: node.getBoundingClientRect().left })
              }
              const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
              while (walker.nextNode()) {
                const text = walker.currentNode
                if (!text.textContent?.trim() || !text.parentElement || !visible(text.parentElement) || text.parentElement.closest('svg')) continue
                const range = document.createRange(); range.selectNodeContents(text)
                const box = range.getBoundingClientRect()
                if (box.width && box.left < gutter) failures.push({ text: text.textContent, x: box.left })
              }
            }
            return failures
          }, gutter)
          expect(escaped, `${mode}/${leftWidth}: every visible list glyph and text starts at the gutter or later`).toEqual([])
          if (mode === 'settings-navigation') continue
          const headings = column.locator('[data-slot="sidebar-menu-button"][aria-expanded]')
          expect(await headings.count()).toBeGreaterThan(2)
          for (const heading of await headings.all()) {
            const arrow = heading.locator('[data-slot="disclosure-chevron"]')
            const name = heading.locator('[data-left-fold-name]')
            const row = heading.locator('..')
            const action = row.locator('[data-slot="sidebar-menu-action"]')
            const open = await heading.getAttribute('aria-expanded') === 'true'
            if (open) await expect(arrow).toBeHidden()
            else await expect(arrow).toBeVisible()
            await row.hover()
            await expect(arrow).toBeVisible()
            if (await action.count()) await expect(action).toBeVisible()
            const measured = await heading.evaluate(heading => {
              const name = heading.querySelector('[data-left-fold-name]')!
              const range = document.createRange(); range.selectNodeContents(name)
              const arrow = heading.querySelector('[data-slot="disclosure-chevron"]')!.getBoundingClientRect()
              const box = name.getBoundingClientRect()
              return { name: box.left, arrow: arrow.left, end: Math.min(range.getBoundingClientRect().right, box.right), right: arrow.right }
            })
            expect(measured.name).toBe(gutter)
            expect(measured.arrow - measured.end).toBeGreaterThanOrEqual(0)
            expect(measured.arrow - measured.end).toBeLessThanOrEqual(10)
            if (await action.count()) expect(measured.right).toBeLessThanOrEqual((await action.boundingBox())!.x)
            if (leftWidth === 256) console.log(`D7a ${width}/${theme} ${await name.textContent()}: gutter=${gutter}, name=${measured.name}, arrow=${measured.arrow}`)
            // Traverse the real tree with arrow keys to return keyboard focus
            // to this heading, including headings outside the sole Tab stop.
            await page.mouse.move(width - 1, 899)
            await heading.focus()
            await page.keyboard.press('ArrowUp')
            await page.keyboard.press('ArrowDown')
            await expect(heading).toBeFocused()
            expect(await heading.evaluate(node => node.matches(':focus-visible'))).toBe(true)
            await expect(arrow).toBeVisible()
            if (await action.count()) await expect(action).toBeVisible()
            // End keyboard focus before testing a fresh pointer focus. A click
            // on the already keyboard-focused button retains focus-visible.
            await heading.evaluate(node => (node as HTMLElement).blur())
            await name.click()
            await expect(heading).toHaveAttribute('aria-expanded', String(!open))
            await arrow.click()
            await expect(heading).toHaveAttribute('aria-expanded', String(open))
            await page.mouse.move(width - 1, 899)
            if (open) await expect(arrow).toBeHidden()
            else await expect(arrow).toBeVisible()
            if (await action.count()) await expect(action).toBeHidden()
            await heading.evaluate(node => (node as HTMLElement).blur())
          }
          // Truncate an actual project label in-place without changing its action or semantics.
          const project = column.locator('[data-project-root] button[data-draggable]').first()
          const name = project.locator('[data-left-fold-name]')
          const original = await name.textContent()
          await name.evaluate(node => { node.textContent = 'A deliberately long project name · 長い名前'.repeat(4) })
          await project.hover()
          await expect(project.locator('[data-slot="disclosure-chevron"]')).toBeVisible()
          const long = await project.evaluate(node => {
            const name = node.querySelector<HTMLElement>('[data-left-fold-name]')!
            const arrow = node.querySelector('[data-slot="disclosure-chevron"]')!.getBoundingClientRect()
            const action = node.parentElement!.querySelector('[data-slot="sidebar-menu-action"]')!.getBoundingClientRect()
            return { truncated: name.scrollWidth > name.clientWidth, end: name.getBoundingClientRect().right, arrow: arrow.left, right: arrow.right, action: action.left }
          })
          expect(long.truncated).toBe(true)
          expect(long.arrow - long.end).toBeGreaterThanOrEqual(0)
          expect(long.arrow - long.end).toBeLessThanOrEqual(10)
          expect(long.right).toBeLessThanOrEqual(long.action)
          await name.evaluate((node, value) => { node.textContent = value }, original!)
          await project.click({ button: 'right' })
          await expect(page.getByRole('menu')).toBeVisible()
          await expect(page.getByRole('menuitem', { name: /^(Pin|Unpin)$/ })).toBeVisible()
          await page.keyboard.press('Escape')
        }
        if (mode === 'left-work') {
          const project = column.locator('[data-project-root] button[data-draggable]').first()
          const action = project.locator('..').locator('[data-slot="sidebar-menu-action"]')
          await applyLeftColumnActions(page, { leftOpen: true, leftWidth: 256, leftHeading: 'hover-open' })
          await expect(action).toBeVisible()
          await applyLeftColumnActions(page, { leftOpen: true, leftHeading: 'folded' })
          await expect(action).toBeHidden()
        }
      })
    }
  }
})
for (const theme of WALL_THEMES) for (const width of [1440, 1100, 720]) {
  test(`C2 Undo is outside More at ${width} in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation&frame-conversation-actions=1', theme, width)
    await openWallDestination(page, { undo: true })
    await expect(page.getByRole('alertdialog', { name: 'Undo the last turn?' })).toBeVisible()
    await expect(page.locator('[data-popup-kind="menu"]:visible')).toHaveCount(0)
    await page.getByRole('button', { name: 'Keep', exact: true }).click()
    await expect(page.getByRole('alertdialog')).toBeHidden()
  })
}

for (const theme of WALL_THEMES) for (const width of [1440, 1100, 720]) {
  test(`C4 wide menu search and footer at ${width} in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation&popup=wide', theme, width)
    await page.getByRole('button', { name: 'Frame wide menu', exact: true }).click()
    const surface = page.locator('[data-popup-kind="wide-menu"]:visible').last()
    await expectMenuGeometry(surface)
    const input = surface.locator('[data-menu-search] input')
    expect((await input.boundingBox())!.height).toBe(FRAME_MENU.searchHeight)
    const footer = surface.locator('[data-menu-footer]')
    await expect(footer).toBeVisible()
    expect(await footer.evaluate(el => el.previousElementSibling?.getAttribute('role'))).toBe('separator')
    const firstLabel = surface.locator('[data-menu-label]').first()
    expect((await firstLabel.boundingBox())!.height).toBeGreaterThan(FRAME_MENU.labelLine)
    expect(await firstLabel.evaluate(el => getComputedStyle(el).whiteSpace)).not.toBe('nowrap')
    await input.fill('发布')
    await expect(surface.locator('[data-menu-row]')).toHaveCount(1)
    await expectMenuGeometry(surface)
  })
  test(`C4 missing usage keeps its reading column at ${width} in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation&popup=metered', theme, width)
    await page.getByRole('button', { name: 'Frame metered menu', exact: true }).click()
    const surface = page.locator('[data-popup-kind="wide-menu"]:visible').last()
    await expectMenuGeometry(surface)
    const xs = await surface.locator('[data-slot="usage-meter-row"]').evaluateAll(rows => rows.map(row => row.querySelector('[data-meter-column="reading"]')!.getBoundingClientRect().left))
    expect(xs).toHaveLength(2)
    expect(xs[0]).toBe(xs[1])
  })
  for (const plan of ['anchor', 'rest']) {
    test(`C4 actual plan usage ${plan} at ${width} in ${theme}`, async ({ page }) => {
      await openFrame(page, `frame-wall=conversation&popup=${plan === 'rest' ? 'other-agents' : 'plan-usage'}`, theme, width)
      const trigger = page.locator('[data-left-seat] [data-slot="popover-trigger"]:not(:has([data-slot="inbox-button"]))')
      await openWallDestination(page, { plan: plan as 'anchor' | 'rest' })
      const surface = page.locator('[data-popup-kind="wide-menu"]:visible').last()
      await expectMenuGeometry(surface)
      await expect(surface.locator('[data-slot="usage-meter-row"]')).not.toHaveCount(0)
      const columns = await surface.locator('[data-slot="usage-meter-row"]').evaluateAll(rows => rows.map(row => ({ reading: row.querySelector('[data-meter-column="reading"]')!.getBoundingClientRect().left, reset: row.querySelector('[data-meter-column="reset"]')?.getBoundingClientRect().left ?? null })))
      if (plan === 'rest') await expect(surface.locator('[data-menu-hint]').filter({ hasText: 'No usage reported' })).toHaveCount(1)
      const resets = columns.map(row => row.reset).filter(x => x !== null)
      expect(new Set(resets).size).toBeLessThanOrEqual(1)
      const details = surface.locator('[data-usage-details]')
      await expect(details.getByRole('menuitem', { name: 'Open usage', exact: true })).toBeVisible()
      await expect(details.locator('[data-menu-note]').last()).toBeVisible()
      expect((await details.locator('[data-menu-note]').last().innerText()).trim().length).toBeGreaterThan(4)
      expect(await page.locator('[data-popup-kind="info-card"]:visible').count()).toBe(0)
      await page.keyboard.press('Escape')
      await expect(trigger).toBeFocused()
    })
  }
}

const expectInfoGeometry = async (card: Locator) => {
  await expect(card).toBeVisible()
  await expect.poll(async () => (await card.boundingBox())?.width).toBe(FRAME.infoCard.width)
  const m = await menuMetrics(card)
  expect(m.width).toBe(FRAME.infoCard.width)
  expect(m.pad).toEqual(Array(4).fill(`${FRAME.infoCard.padding}px`))
  expect(m.radius).toBe(`${FRAME.menu.radius}px`)
  expect(m.overflow).toBe(false)
  await expect(card.locator('button,a[href],input,select,textarea,[role="button"],[role^="menuitem"],[role="switch"]')).toHaveCount(0)
  const edges = await card.evaluate(el => {
    const x = el.getBoundingClientRect().left
    return [...el.querySelectorAll<HTMLElement>('[data-info-title],[data-info-facts],[data-info-note]')].map(node => node.getBoundingClientRect().left - x)
  })
  for (const x of edges) expect(x).toBe(FRAME.infoCard.padding)
  const keys = await card.locator('[data-info-facts] dt').evaluateAll(keys => keys.map(key => key.getBoundingClientRect().width))
  for (const width of keys) expect(width).toBe(FRAME.summaryKey.infoCard)
}
for (const theme of WALL_THEMES) for (const width of [1440, 1100, 720]) {
  test(`C7 info card hover and focus at ${width} in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation&popup=info', theme, width)
    const trigger = page.getByRole('button', { name: 'Storefront catalogue review', exact: true })
    await trigger.hover()
    const card = page.locator('[data-popup-kind="info-card"]:visible').last()
    await expectInfoGeometry(card)
    await page.mouse.move(0, 0)
    await expect(card).toBeHidden()
    await page.keyboard.press('Tab')
    await trigger.focus()
    await expectInfoGeometry(card)
  })
  test(`C7 menu cancels a pending facts card at ${width} in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation&popup=info-and-menu', theme, width)
    await page.getByRole('button', { name: 'Storefront catalogue review', exact: true }).hover()
    await page.getByRole('button', { name: 'Frame menu', exact: true }).click()
    await expect(page.locator('[data-popup-kind="menu"]:visible')).toBeVisible()
    await page.waitForTimeout(500)
    await expect(page.locator('[data-popup-kind="info-card"]:visible')).toHaveCount(0)
    await expect(page.locator('[data-popup-kind="menu"]:visible')).toBeVisible()
    await expect(page.locator('[data-popup-kind="info-card"]:visible')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-popup-kind="menu"]')).toHaveCount(0)
    const facts = page.getByRole('button', { name: 'Storefront catalogue review', exact: true })
    await facts.focus()
    await expect(page.locator('[data-popup-kind="info-card"]:visible')).toHaveCount(1)
    await page.getByRole('button', { name: 'Frame menu', exact: true }).click()
    await expect(page.locator('[data-popup-kind="info-card"]:visible')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-popup-kind="menu"]')).toHaveCount(0)
    await expect(page.locator('[data-popup-kind="info-card"]:visible')).toHaveCount(0)
    await facts.focus()
    await expect(page.locator('[data-popup-kind="info-card"]:visible')).toHaveCount(1)
  })
}

for (const theme of WALL_THEMES) for (const width of [1440, 1100, 720]) for (const source of ['context', 'member', 'budget']) {
  test(`C8 production ${source} info adapter at ${width} in ${theme}`, async ({ page }) => {
    const query = source === 'context' ? 'frame-wall=conversation' : `frame-wall=conversation&popup=${source}-info`
    await openFrame(page, query, theme, width)
    const trigger = source === 'budget' ? page.getByRole('button', { name: 'Run budget', exact: true }) : page.locator(`[data-info-source="${source}"]`).first()
    await trigger.hover()
    await expectInfoGeometry(page.locator('[data-popup-kind="info-card"]:visible').last())
  })
}

for (const theme of WALL_THEMES) for (const width of [1440, 1100, 720]) {
  test(`C6 account menu and separate consent at ${width} in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation', theme, width)
    await openWallDestination(page, { account: true })
    await expectMenuGeometry(page.locator('[data-popup-kind="wide-menu"]:visible').last())
    await expect(page.locator('[data-popup-kind="info-card"]:visible')).toHaveCount(0)
    await page.getByRole('menuitem', { name: /^Sign out of/ }).click()
    await expect(page.getByRole('alertdialog')).toBeVisible()
    await expect(page.locator('[data-popup-kind="wide-menu"]:visible')).toHaveCount(0)
    await page.getByRole('button', { name: 'Keep signed in', exact: true }).click()
    await expect(page.getByRole('alertdialog')).toBeHidden()
  })
}


for (const theme of WALL_THEMES) for (const width of [1440, 1100, 720]) {
  test(`C5 branch search and entry at ${width} in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation', theme, width)
    await openWallDestination(page, { git: true, branch: true })
    const flyout = page.locator('[data-slot="dropdown-menu-sub-content"]:visible').last()
    await expectMenuGeometry(flyout)
    const input = flyout.locator('[data-menu-search] input')
    await expect(input).toBeFocused()
    expect((await input.boundingBox())!.height).toBe(FRAME_MENU.searchHeight)
    await input.fill('发布')
    await expect(flyout.locator('[data-menu-row][role="menuitemradio"]')).toHaveCount(1)
    await expect(flyout.locator('[data-menu-label]').filter({ hasText: 'feature/发布前检查' })).toHaveCount(1)
    await input.fill('missing')
    await expect(flyout.locator('[data-menu-note]')).toContainText(['No branch matches.', 'Checking out a branch keeps the existing folder.'])
    await page.getByRole('menuitem', { name: 'Create and checkout new branch…', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Create and checkout new branch' })).toBeVisible()
    await expect(page.locator('[data-popup-kind]:visible')).toHaveCount(0)
    await page.getByRole('button', { name: 'Keep current branch', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeHidden()
  })

}
for (const theme of ['light', 'dark'] as const) for (const width of [1440, 1100, 720]) {
  test(`C9 suggestion listbox uses the only row at ${width} ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation&popup=suggestions', theme, width)
    const list = page.getByRole('listbox')
    await expect(list).toBeVisible()
    await expect(list).toHaveAttribute('data-popup-kind', 'wide-menu')
    await expectMenuGeometry(list)
    await expect(list.getByRole('option')).toHaveCount(3)
    await expect(list.getByRole('option').last()).toHaveAttribute('aria-disabled', 'true')
    await page.getByRole('textbox', { name: 'Frame suggestion anchor' }).focus()
    await expect(page.getByRole('textbox', { name: 'Frame suggestion anchor' })).toBeFocused()
  })
  test(`C9 Select preserves selection with canonical geometry at ${width} ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation&popup=select', theme, width)
    await page.getByRole('combobox', { name: 'Frame Select' }).click()
    const plate = page.locator('[data-slot="select-content"]')
    await expectMenuGeometry(plate)
    await page.getByRole('option', { name: 'Catalogue diagnostics and checkout retry policy' }).click()
    await expect(page.getByRole('combobox', { name: 'Frame Select' })).toContainText('Catalogue diagnostics and checkout retry policy')
    await expect(plate).toBeHidden()
    const trigger = page.getByRole('combobox', { name: 'Frame Select' })
    await trigger.focus()
    await page.keyboard.press('Enter')
    await expect(plate).toBeVisible()
    await page.keyboard.press('Home')
    await page.keyboard.press('Enter')
    await expect(trigger).toContainText('Scout — Storefront compatibility review')
    await expect(plate).toBeHidden()
    await expect(trigger).toBeFocused()
  })
}

for (const theme of WALL_THEMES) for (const width of [1440, 720]) {
  test(`C3 refused rows retain icons and mute every text track at ${width} in ${theme}`, async ({ page }) => {
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
const expectRefusedMenuRow = async (row: Locator) => {
  const colors = await row.evaluate(el => {
    const resolve = document.createElement('span'); resolve.style.color = 'var(--hd-muted-foreground)'; el.append(resolve)
    const muted = getComputedStyle(resolve).color; resolve.remove()
    return { muted, tracks: [el, ...el.querySelectorAll('[data-menu-icon],[data-menu-label],[data-menu-hint]')].map(node => getComputedStyle(node).color) }
  })
  expect(colors.tracks.length).toBe(4)
  for (const color of colors.tracks) expect(color).toBe(colors.muted)
  const icon = row.locator('[data-menu-icon] svg')
  await expect(icon).toHaveCount(1)
  const box = (await icon.boundingBox())!
  expect([box.width, box.height]).toEqual([16, 16])
  const hint = row.locator('[data-menu-hint]')
  expect(await hint.evaluate(el => [getComputedStyle(el).fontSize, getComputedStyle(el).lineHeight])).toEqual(['12px', '16px'])
}

for (const theme of WALL_THEMES) for (const width of [1440, 1100, 720]) for (const mode of ['none', 'icons']) {
  test(`C3 dropdown ${mode} at ${width} in ${theme}`, async ({ page }) => {
    await openFrame(page, `frame-wall=conversation&popup=dropdown-${mode}`, theme, width)
    await page.getByRole('button', { name: 'Frame dropdown', exact: true }).click()
    await expectMenuGeometry(page.locator('[data-popup-kind="menu"]:visible').last())
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

for (const theme of WALL_THEMES) for (const width of [1440, 1100, 720]) {
  test(`C10 inbox retains expanded facts and actions at ${width} ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation&popup=inbox', theme, width)
    await page.getByRole('button', { name: 'Inbox, 1 unread', exact: true }).click()
    const plate = page.locator('[data-popup-kind="wide-menu"]:visible')
    await expectMenuGeometry(plate)
    await page.getByRole('menuitem', { name: /The Storefront catalogue compatibility check/ }).click()
    await expect(plate).toContainText('workspace/storefront/project.config.json')
    await expect(plate).toContainText('tools.search.timeout')
    await expect(page.getByRole('menuitem', { name: 'Open the findings', exact: true })).toBeVisible()
    await expectMenuGeometry(plate)
    await page.getByRole('menuitem', { name: 'Open the findings', exact: true }).click()
    await expect(plate).toBeHidden()
  })
}

const expectDestinationPopupContracts = async (page: Page, destination: typeof WALL_DESTINATIONS[number], theme: 'light' | 'dark', width: number) => test.step(destination.id, async () => {
  await openFrame(page, destination.query, theme, width)
  await applyFrameActions(page, destination)
  await applyLeftColumnActions(page, destination)
  await applySettingsNavigationActions(page, destination)
  await openWallDestination(page, destination)
  const kinds = new Set<string>()
  const rich = page.locator('[data-slot="popover-popup"]:visible,[data-slot="popover-surface"]:visible,[data-slot="dropdown-menu-popup"][data-popup-kind]:visible,[data-slot="dropdown-menu-content"]:visible,[data-slot="dropdown-menu-sub-content"]:visible,[data-slot="hover-card-content"]:visible,[data-slot="select-content"]:visible')
  for (let at = 0; at < await rich.count(); at += 1) {
    const popup = rich.nth(at)
    await expect(popup).not.toHaveAttribute('data-starting-style', '')
    const kind = await popup.getAttribute('data-popup-kind')
    expect(['menu', 'wide-menu', 'info-card']).toContain(kind)
    kinds.add(kind!)
    if (kind === 'info-card') {
      await expectInfoGeometry(popup)
      expect(await popup.locator('button,a,input,select,[role="menuitem"],[role="switch"]').count()).toBe(0)
    } else if (destination.id === 'left-inbox') {
      // The sidebar's empty Inbox has facts and a footer, with exactly zero actions.
      await expect(popup).toHaveAttribute('data-popup-kind', 'wide-menu')
      await expect(popup).toHaveAttribute('data-menu-icons', 'none')
      await expect(popup.locator('[data-menu-row]')).toHaveCount(0)
      await expect(popup.locator('[data-menu-note]')).toHaveText('Nothing kept yet. Messages an Agent sends you wait here.')
      await expect(popup.locator('[data-menu-footer]')).toHaveText('Kept until you clear them.')
      await expectMenuPlateGeometry(popup)
      await expectMenuAnatomy(popup, false)
    } else await expectMenuGeometry(popup)
  }
  return kinds
})

// Small batches keep the normal test timeout without dropping a wall destination.
const popupContractDestinations = WALL_DESTINATIONS.filter(destination => !destination.gitRef)
for (const theme of WALL_THEMES) for (const width of WALL_WIDTHS) {
  for (let offset = 0; offset < popupContractDestinations.length; offset += 5) {
    const destinations = popupContractDestinations.slice(offset, offset + 5)
    test(`C10 exhaustive popup contracts ${destinations.map(destination => destination.id).join(', ')} at ${width} in ${theme}`, async ({ page }) => {
      for (const destination of destinations) await expectDestinationPopupContracts(page, destination, theme, width)
    })
  }
  test(`C10 all three popup kinds are exercised at ${width} in ${theme}`, async ({ page }) => {
    const kinds = new Set<string>()
    for (const id of ['popup-menu-none', 'popup-wide-menu', 'popup-info-card']) {
      const destination = WALL_DESTINATIONS.find(destination => destination.id === id)!
      const found = await expectDestinationPopupContracts(page, destination, theme, width)
      expect(found.size).toBeGreaterThan(0)
      for (const kind of found) kinds.add(kind)
    }
    expect([...kinds].sort()).toEqual(['info-card', 'menu', 'wide-menu'])
  })
  for (const destination of WALL_DESTINATIONS.filter(destination => destination.gitRef)) {
    test(`C10 exhaustive popup contracts ${destination.id} at ${width} in ${theme}`, async ({ page }) => {
      test.fixme(true, 'Controller decision pending: refs rail requires a panel at least 640px wide; the preview allocates 400px.')
      await expectDestinationPopupContracts(page, destination, theme, width)
    })
  }
}

for (const theme of WALL_THEMES) {
  test(`E1b retained work shares the terminal and notice in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=team&frame-terminal=1', theme)
    await expect(page.locator('[data-slot="retained-work"]')).toBeVisible()
    await expect(page.locator('[data-slot="top-bar"]:visible')).toHaveCount(1)
    await expect(page.locator('[data-slot="status-bar"], [data-shell-host="status"]')).toHaveCount(0)
    await expect(page.locator('[data-shell-host="main-notice"]')).toHaveCount(1)
    await expect(page.locator('[data-slot="retained-work"] [data-shell-host="main-notice"]')).toHaveCount(0)
    const terminal = page.locator('[data-frame-region="bottom"] [data-terminal-id]').first()
    await expect(terminal).toBeVisible()
    await terminal.evaluate(node => { node.setAttribute('data-retention-witness', 'E1b') })
    await selectFrameTab(page, 'overview')
    await expect(terminal).toHaveAttribute('data-retention-witness', 'E1b')
  })
  for (const width of [1440,720]) {
    test(`E1b linked ancestors remain clickable at the final fold ${width} ${theme}`, async ({ page }) => {
      await openFrame(page, 'frame-wall=topbar&frame-parents=1', theme, width)
      const bar = page.locator('[data-slot="top-bar"]')
      await expect(bar.locator('[data-topbar="place"] button')).toHaveCount(width===1440 ? 3 : 1)
      const labels = await bar.locator('[data-topbar="place"] button').allTextContents()
      expect(labels).toEqual(width===1440 ? ['Settings ›','Runtimes ›','Alpha ›'] : ['Alpha ›'])
      expect((await bar.locator('[data-topbar-title]').boundingBox())!.width).toBeGreaterThanOrEqual(FRAME.bar.titleMin)
      await bar.getByRole('button',{name:'Alpha ›',exact:true}).click()
      const receipt = page.locator('[data-parent-choice]')
      await expect(receipt).toHaveAttribute('data-parent-choice','Alpha')
      if (width===720) {
        await expect(bar).toHaveAttribute('data-fold','3')
        await bar.getByRole('button',{name:'More',exact:true}).click()
        const menu = page.getByRole('menu')
        await expect(menu.getByRole('menuitem').first()).toHaveText('Start a conversation with this account')
        await menu.getByRole('menuitem',{name:'Settings',exact:true}).click()
      } else await bar.getByRole('button',{name:'Settings ›',exact:true}).click()
      await expect(receipt).toHaveAttribute('data-parent-choice','Settings')
    })
    test(`E1b bar controls resolve to no-drag ${width} ${theme}`, async ({ page }) => {
      await openFrame(page, 'frame-wall=topbar&frame-parents=1', theme, width)
      const bar = page.locator('[data-slot="top-bar"]')
      expect(await bar.locator('..').evaluate(node=>getComputedStyle(node).getPropertyValue('-webkit-app-region'))).toBe('drag')
      const controls = bar.locator('button:visible, a:visible, input:visible, select:visible, textarea:visible, [role="tab"]:visible, [role="button"]:visible')
      const regions = await controls.evaluateAll(nodes=>nodes.map(node=>({label:node.getAttribute('aria-label')??node.textContent,region:getComputedStyle(node).getPropertyValue('-webkit-app-region')})))
      expect(regions.length).toBeGreaterThan(2)
      for (const control of regions) expect(control.region,control.label??'bar control').toBe('no-drag')
    })
  }
}

for (const theme of ['light', 'dark'] as const) for (const width of [1440, 1100, 720]) {
  test(`E2a Profile choices remain inside the frame ${width} ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=settings&frame-section=profile', theme, width)
    const choices = page.getByRole('radiogroup', { name: 'Picture', exact: true })
    await expect(choices).toBeVisible()
    await expect(choices).toHaveAttribute('data-slot', 'picture-choices')
    expect(await choices.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    expect((await page.locator('[data-slot="top-bar"]:visible').locator('..').boundingBox())!.height).toBe(FRAME.bar.height)
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`E2a narrow page options keep long current choices within the body in ${theme}`, async ({ page }) => {
    await page.setViewportSize({width:720,height:900})
    await page.emulateMedia({colorScheme:theme})
    await page.goto(`/design.html?view=page-options&theme=${theme}`)
    const options = page.locator('[data-slot="page-options"]').nth(2)
    await expect(options).toBeVisible()
    const trigger = options.locator('[data-slot="popover-trigger"]')
    await expect(trigger).toContainText('チェックアウトのレビュー')
    expect(await trigger.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
    expect(await options.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
  })
}

for (const theme of ['light', 'dark'] as const) {
  for (const width of [2200, 1440, 1100, 720]) {
    for (const section of ['general', 'appearance', 'notifications', 'shortcuts', 'workspaces', 'history', 'storage', 'archive', 'runtimes', 'models', 'skills', 'extensions', 'permissions', 'browser']) {
      test(`E2 Settings ${section} is reading at ${width} in ${theme}`, async ({ page }) => {
        await measureDestination(page, `frame-wall=settings&frame-section=${section}`, 'reading', theme, width)
        await expect(page.locator('[data-slot="app-window"]:visible')).toHaveCount(0)
        await expect(page.locator('[data-left-column]:visible')).toHaveCount(width < 1000 ? 0 : 1)
      })
    }
  }
  test(`E2 keyboard history keeps work and terminal under Settings in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=navigation&frame-terminal=1', theme)
    const work = page.locator('[data-slot="retained-work"]')
    const transcript = work.locator('[data-transcript]').first()
    const terminal = page.locator('[data-frame-region="bottom"] [data-terminal-id]').first()
    await expect(transcript).toBeVisible()
    await transcript.evaluate(el => { el.dataset.retentionWitness = 'transcript'; el.scrollTop = 120 })
    const scroll = await transcript.evaluate(el => el.scrollTop)
    await terminal.evaluate(el => { el.dataset.retentionWitness = 'terminal' })
    const terminalId = await terminal.getAttribute('data-terminal-id')
    await page.keyboard.press('Meta+,')
    await expect(page.locator('[data-page-destination="settings"]')).toBeVisible()
    await expect(work).toBeHidden()
    await expect(work).toHaveAttribute('inert', '')
    await expect(terminal).toHaveAttribute('data-terminal-id', terminalId!)
    await expect(terminal).toHaveAttribute('data-retention-witness', 'terminal')
    const terminalInput=terminal.locator('.xterm-helper-textarea')
    await terminalInput.focus();await expect(terminalInput).toBeFocused()
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent('harnessdesk:preview-connection',{detail:'reconnecting'})))
    await expect(page.locator('[data-shell-host="main-notice"]')).toContainText('Reconnecting to HarnessDesk.')
    await expect(page.locator('[data-page-destination="settings"]')).toBeVisible()
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent('harnessdesk:preview-connection',{detail:'open'})))
    await expect(page.locator('[data-shell-host="main-notice"] [role="status"]')).toHaveCount(0)
    await page.keyboard.press('Meta+[')
    await expect(work).toBeVisible()
    await expect(transcript).toHaveAttribute('data-retention-witness', 'transcript')
    expect(await transcript.evaluate(el => el.scrollTop)).toBe(scroll)
    await page.keyboard.press('Meta+]')
    await expect(page.locator('[data-page-destination="settings"]')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-page-destination="settings"]')).toBeVisible()
    await page.keyboard.press('Meta+w')
    await expect(work).toBeVisible()
    await expect(terminal).toHaveAttribute('data-retention-witness', 'terminal')
  })
}

for (const theme of ['light', 'dark'] as const) for (const width of [2200, 1440, 1100, 720]) {
  for (const child of ['runtime', 'account', 'project', 'skill']) test(`E2 Settings child ${child} ${width} ${theme}`, async ({ page }) => {
    await measureDestination(page, `frame-wall=settings&frame-detail=${child}`, 'reading', theme, width)
    const bar = page.locator('[data-slot="top-bar"]:visible')
    const parents = bar.locator('[data-topbar="place"] button')
    await expect(parents.last()).toBeVisible()
    if (width >= 1440) await expect(bar.getByRole('button', { name: 'Settings ›', exact: true })).toBeVisible()
  })
  test(`E2 Add runtime ${width} ${theme}`, async ({ page }) => {
    await measureDestination(page, 'frame-wall=settings&frame-section=runtimes&frame-focus=add', 'reading', theme, width)
    await expect(page.locator('[data-slot="top-bar"]:visible')).toContainText('Add a runtime')
  })
}

for(const width of [1440,720]) test(`E2 Settings door preserves normal history and the retained work ${width}`, async ({ page }) => {
  await expectPageJourney(page,'Settings','settings',width)
})
test('E2 Settings More offers Terminal only with a folder', async ({ page }) => {
  await openFrame(page, 'frame-wall=settings&frame-section=general&frame-no-folder=1', 'light')
  await page.locator('[data-slot="top-bar"]:visible').getByRole('button', {name:'More',exact:true}).click()
  await expect(page.getByRole('menuitemradio', {name:/Terminal/})).toHaveCount(0)
  await expect(page.getByRole('menuitem', {name:'Back to app',exact:true})).toHaveCount(0)
  await openFrame(page,'frame-wall=settings&frame-section=general','light')
  await page.locator('[data-slot="top-bar"]:visible').getByRole('button',{name:'More',exact:true}).click()
  await expect(page.getByRole('menuitemradio',{name:/Terminal/})).toHaveCount(1)
  await expect(page.getByRole('menuitem',{name:'Back to app',exact:true})).toHaveCount(0)
})

for(const theme of ['light','dark'] as const) for(const width of [2200,1440,1100,720]) test(`E2 Settings Profile is reading at ${width} in ${theme}`,async({page})=>{
  await measureDestination(page,'frame-wall=settings&frame-section=profile','reading',theme,width)
})
