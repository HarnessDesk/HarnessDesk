import { installFramePreviewFixture } from './frame-preview-fixture'
import { selectRunView } from './run-frame-actions'
import { expect, test, type Page } from '@playwright/test'
import { FRAME, FRAME_TOKENS } from '../../packages/ui/src/design/frame'
import { WALL_DESTINATIONS, WALL_THEMES } from './frame-wall-destinations'
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
    const buttons = menu.getByRole('button')
    const count = await buttons.count()
    expect(count).toBeGreaterThan(1)
    for (let index = 0; index < count; index++) {
      await expect(buttons.nth(index)).toBeFocused()
      await page.keyboard.press('Tab')
    }
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
    await expect(page.getByRole('button', { name: 'Compact now', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Save as an Agent…', exact: true })).toBeVisible()
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
const B6_WORK_DESTINATIONS = WALL_DESTINATIONS.filter(destination => destination.id !== 'topbar-probe' && !B10_NONWORK.test(destination.query))
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
