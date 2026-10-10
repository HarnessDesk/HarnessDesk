import { openWallDestination } from './frame-wall-actions'
import { installFramePreviewFixture } from './frame-preview-fixture'
import { selectRunView } from './run-frame-actions'
import { expect, test, type Page } from '@playwright/test'
import { FRAME, FRAME_TOKENS } from '../../packages/ui/src/design/frame'
import { WALL_DESTINATIONS, WALL_THEMES, WALL_WIDTHS } from './frame-wall-destinations'
import { applyFrameActions, selectFrameTab } from './frame-actions'

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

for (const theme of WALL_THEMES) for (const destination of ['settings', 'agents', 'teams', 'dashboard']) {
  test(`B10 ${destination} has one shell bar and a modal footer in ${theme}`, async ({ page }) => {
    await openFrame(page, `frame-wall=${destination}`, theme, 720)
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    const bar = dialog.locator('[data-slot="top-bar"]')
    const footer = dialog.locator('[data-slot="status-bar"]')
    await expect(bar).toHaveCount(1)
    await expect(footer).toHaveCount(1)
    await expect(page.locator('[data-slot="top-bar"]:visible')).toHaveCount(1)
    await expect(page.locator('[data-slot="status-bar"]:visible')).toHaveCount(1)
    await expect(bar.locator('[data-work-tool]')).toHaveCount(0)
    const top = (await bar.locator('..').boundingBox())!, foot = (await footer.boundingBox())!
    expect(top.height).toBe(FRAME.bar.height)
    expect(foot.height).toBe(FRAME.statusBar.height)
    expect(foot.x).toBe(0)
    expect(foot.width).toBe(720)
    expect(foot.y + foot.height).toBe(900)
    const terminal = footer.getByRole('button', { name: 'Open terminal', exact: true })
    await terminal.focus()
    await expect(terminal).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(page.locator('[data-slot="top-bar"]:visible')).toHaveCount(1)
    await expect(page.locator('[data-slot="status-bar"]:visible')).toHaveCount(1)
  })
}

for (const theme of WALL_THEMES) {
  test(`B10 modal footer usage menu returns to its next real Tab stop in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=settings', theme, 720)
    const dialog = page.getByRole('dialog')
    const trigger = dialog.locator('[data-slot="status-bar"]').getByRole('button', { name: /other agents/ })
    await trigger.focus()
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => {
      const next = document.activeElement
      if (!(next instanceof HTMLElement) || next === document.body) return false
      next.dataset.b10NextStop = ''
      return true
    })).toBe(true)
    const next = page.locator('[data-b10-next-stop]')
    await trigger.focus()
    await page.keyboard.press('Enter')
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    const rows = menu.getByRole('menuitem')
    const count = await rows.count()
    expect(count).toBeGreaterThan(1)
    await page.keyboard.press('ArrowDown')
    for (let index = 0; index < count; index++) {
      await expect(rows.nth(index)).toBeFocused()
      if (index + 1 < count) await page.keyboard.press('ArrowDown')
    }
    await page.keyboard.press('Tab')
    await expect(menu).toHaveCount(0)
    await expect(next).toBeFocused()
    await expect(dialog).toBeVisible()
    expect(await next.evaluate(node => Boolean(node.closest('[role="dialog"]')))).toBe(true)
  })
  test(`B10 modal tools record work intent and preserve File and terminal nodes in ${theme}`, async ({ page }) => {
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
    await dialog.locator('[data-slot="status-bar"]').getByRole('button', { name: '1 background task', exact: true }).click()
    await expect(dialog).toBeVisible()
    await expect(page.locator('[data-slot="work-tools"]')).toBeHidden()
    const more = dialog.getByRole('button', { name: 'More', exact: true })
    await more.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('menu')).toBeVisible()
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

for (const theme of WALL_THEMES) {
  for (const width of [1440, 720]) {
    test(`B9 app foot spans the window and retains its terminal across views at ${width} in ${theme}`, async ({ page }) => {
      await openFrame(page, 'frame-wall=team&frame-terminal=1', theme, width)
      const footer = page.locator('[data-slot="status-bar"]')
      await expect(footer).toHaveCount(1)
      const bounds = (await footer.boundingBox())!
      expect(bounds.x).toBe(0)
      expect(bounds.width).toBe(width)
      expect(bounds.height).toBe(FRAME.statusBar.height)
      expect(bounds.y + bounds.height).toBe(900)
      expect(await resolvedPx(page, '--hd-statusbar-h')).toBe(FRAME.statusBar.height)
      await expect(page.locator('[data-slot="top-bar"] [data-slot="plan-meter"]')).toHaveCount(0)
      await expect(footer.getByRole('button', { name: 'Close terminal', exact: true })).toHaveCount(1)
      await expect(page.locator('button[aria-label="Close terminal"][aria-pressed="true"]')).toHaveCount(1)
      const terminal = page.locator('[data-terminal-id]')
      const id = await terminal.getAttribute('data-terminal-id')
      await selectFrameTab(page, 'findings')
      await expect(terminal).toHaveAttribute('data-terminal-id', id!)
      await expect(terminal).toBeVisible()
      const controls = await footer.locator('button').evaluateAll(nodes => nodes.map(node => {
        const rect = node.getBoundingClientRect()
        return { label: node.getAttribute('aria-label') ?? node.textContent, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
      }))
      for (const control of controls) {
        expect(control.left, `${control.label}: left`).toBeGreaterThanOrEqual(0)
        expect(control.right, `${control.label}: right`).toBeLessThanOrEqual(width)
        expect(control.top, `${control.label}: top`).toBeGreaterThanOrEqual(bounds.y)
        expect(control.bottom, `${control.label}: bottom`).toBeLessThanOrEqual(900)
      }
      for (let index = 1; index < controls.length; index++) expect(controls[index].left).toBeGreaterThanOrEqual(controls[index - 1].right)
    })
  }
  test(`B9 app foot projects real tasks and the host connection in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation&frame-status=tasks', theme)
    const footer = page.locator('[data-slot="status-bar"]')
    await expect(footer.getByRole('button', { name: '1 background task', exact: true })).toBeEnabled()
    await footer.getByRole('button', { name: '1 background task', exact: true }).click()
    await expect(page.locator('[data-slot="work-tools"]')).toBeVisible()
    await openFrame(page, 'frame-wall=team&frame-status=reconnecting', theme, 720)
    await expect(page.locator('[data-slot="status-bar"]').getByText('Reconnecting', { exact: true })).toBeVisible()
    await expect(page.locator('[data-slot="status-bar"]').getByText('Connected', { exact: true })).toHaveCount(0)
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

  test(`B5 equivalent completed rounds expand into their original records in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=team-run-equivalent', theme)
    await selectFrameTab(page, 'run')
    const main = page.locator('[data-slot="workbench-main"]')
    const group = main.locator('[data-round-group]')
    await expect(group).toHaveCount(1)
    await expect(group).toHaveAttribute('data-expanded', 'false')
    await expect(group).toContainText('Rounds 1–2')
    await expect(main.locator('[data-row="round-1"]')).toHaveCount(0)
    await expect(main.locator('[data-row="round-2"]')).toHaveCount(0)
    await group.locator('[data-step-row]').click()
    await expect(group).toHaveAttribute('data-expanded', 'true')
    await expect(main.locator('[data-row="round-1"]')).toHaveCount(1)
    await expect(main.locator('[data-row="round-2"]')).toHaveCount(1)
    await main.locator('[data-row="card-2-2"]').click()
    await expect(main.locator('[data-row="card-2-2"]')).toHaveAttribute('aria-current', 'true')
    await expect(page.locator('[data-slot="tool-body"]:visible [data-slot="run-inspector"]')).toContainText('#2')
    await page.locator('[data-slot="top-bar"]:visible').getByRole('button', { name: 'Toggle right panel', exact: true }).click()
    await selectRunView(page.locator('[data-frame-id="frame-wall"]'), 'Flow')
    await selectRunView(page.locator('[data-frame-id="frame-wall"]'), 'Timeline')
    await expect(group).toHaveAttribute('data-expanded', 'true')
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
    for (const round of [1,2,3,4]) await expect(main.locator(`[data-row="round-${round}"]`)).toBeVisible()
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
      const divider = (await top.locator('[data-slot="bar-divider"]').boundingBox())!
      expect(Math.round(divider.width)).toBe(1)
      expect(Math.round(divider.height)).toBe(FRAME.bar.dividerHeight)
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
      expect(firstTool.x - panel.x).toBe(FRAME.bar.pad)
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
    expect((await first.boundingBox())!.x - painted.x).toBe(FRAME.bar.pad)
    expect((await more.boundingBox())!.x).toBe(moreBefore.x)
    await page.mouse.up()
    expect((await first.boundingBox())!.x - (await details.boundingBox())!.x).toBe(FRAME.bar.pad)
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
const B6_WORK_DESTINATIONS = WALL_DESTINATIONS.filter(destination => destination.surface !== 'pattern' && !B10_NONWORK.test(destination.query))
const B10_NONWORK_DESTINATIONS = WALL_DESTINATIONS.filter(destination => B10_NONWORK.test(destination.query))
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
          const rows = [...column.querySelectorAll('[data-left-row]:not(:has([data-draggable])) [data-slot="sidebar-menu-button"]')].map(row => {
            const style = getComputedStyle(row)
            return { height: row.getBoundingClientRect().height, icon: row.querySelector('[data-slot="sidebar-menu-icon"]')!.getBoundingClientRect().width, gap: parseFloat(style.gap) }
          })
          const disclosures = [...column.querySelectorAll('[data-draggable]')].map(row => ({
            iconRight: row.querySelector('[data-slot="sidebar-menu-icon"]')!.getBoundingClientRect().right,
            nameX: row.querySelector('[data-slot="sidebar-menu-label-content"]')!.getBoundingClientRect().x,
          }))
          return { firstIcon, names, gaps, rows, disclosures }
        })
        const modes = []
        for (const query of ['frame-wall=settings', 'frame-wall=settings-middle']) {
          await openFrame(page, query, theme, width)
          await page.locator('body').evaluate((body, value) => { body.dataset.hdInterface = value }, foundation)
          const navigation = page.locator(query === 'frame-wall=settings' ? '[aria-label="Window navigation"]' : '[data-left-settings]')
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
        for (const disclosure of sessions.disclosures) expect(disclosure.iconRight, 'disclosure keeps a separate gutter beside the name').toBeLessThanOrEqual(disclosure.nameX)
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
    expect(controls).toHaveLength(5)
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
    const nav = page.getByRole('navigation', { name: 'Window navigation' })
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
    await expect(nav.locator('[data-left-row]')).toHaveCount(1)
    await expect(nav.getByRole('button', { name: 'Keyboard shortcuts', exact: true })).toBeVisible()
    await expect(nav.getByRole('button', { name: 'Back to app', exact: true })).toBeVisible()
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
      const trigger = page.locator(`[data-plan-popup="${plan}"]`).locator('xpath=ancestor::button[1]')
      await trigger.click()
      const surface = page.locator('[data-popup-kind="wide-menu"]:visible').last()
      await expectMenuGeometry(surface)
      await expect(surface.locator('[data-slot="usage-meter-row"]')).not.toHaveCount(0)
      const columns = await surface.locator('[data-slot="usage-meter-row"]').evaluateAll(rows => rows.map(row => ({ reading: row.querySelector('[data-meter-column="reading"]')!.getBoundingClientRect().left, reset: row.querySelector('[data-meter-column="reset"]')?.getBoundingClientRect().left ?? null })))
      if (plan === 'rest') await expect(surface.locator('[data-meter-note]')).toHaveText('No usage reported')
      const resets = columns.map(row => row.reset).filter(x => x !== null)
      expect(new Set(resets).size).toBeLessThanOrEqual(1)
      await expect(surface.locator('[data-menu-footer]')).toBeVisible()
      expect(await page.locator('[data-popup-kind="info-card"]:visible').count()).toBe(0)
      await page.keyboard.press('Escape')
      await expect(trigger).toBeFocused()
    })
  }
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
