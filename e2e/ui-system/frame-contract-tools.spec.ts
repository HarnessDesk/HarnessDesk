import { applyLeftColumnActions } from './left-column-actions'
import { expect, test } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'
import { WALL_THEMES, WALL_WIDTHS } from './frame-wall-destinations'
import { openFrame } from './frame-contract-helpers'

// Contract runs measure the preview; the final wall owns images and recordings.
test.use({ screenshot: 'off', trace: 'off', video: 'off' })

for (const width of [1440, 1100]) {
  test(`R10.30 terminal pane owns a full-height region beside main at ${width}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation&frame-terminal=1', 'light', width)
    const right = page.locator('[data-frame-region="right"]')
    const main = page.locator('[data-frame-region="main"]')
    const terminal = right.locator('[data-terminal-id]')
    await expect(terminal).toBeVisible()
    await expect(page.locator('[data-frame-region="bottom"]')).toBeHidden()
    await expect(right.locator('[data-work-pane-header]')).toHaveCount(1)
    await expect(page.locator('[data-frame-region="rail"]')).toBeVisible()
    const panel = (await right.boundingBox())!
    const reading = (await main.boundingBox())!
    const top = (await page.locator('[data-frame-region="top"]').boundingBox())!
    expect(panel.y).toBe(0)
    expect(panel.height).toBe(900)
    expect(panel.x + panel.width).toBe(width)
    expect(reading.x + reading.width).toBeLessThanOrEqual(panel.x)
    expect(top.x + top.width).toBe(panel.x)
  })
}

for (const theme of WALL_THEMES) {
  test(`R5.5 message action reveal stays with the hovered message in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation&frame-conversation-actions=1', theme)
    const userMessage = page.locator('[data-part="prompt"] [data-slot="message"]').first()
    const userActions = page.locator('[data-message-actions="user"]').first()
    const answerMessage = page.locator('[data-part="answer"] [data-slot="message"]').first()
    const answerActions = page.locator('[data-message-actions="assistant"]').last()

    const answerBox = (await answerMessage.boundingBox())!
    await page.mouse.move(answerBox.x + answerBox.width / 2, answerBox.y + answerBox.height / 2)
    await expect(answerActions).toHaveCSS('opacity', '1')
    await expect(userActions).toHaveCSS('opacity', '0')

    const userBox = (await userMessage.boundingBox())!
    await page.mouse.move(userBox.x + userBox.width / 2, userBox.y + userBox.height / 2)
    await expect(userActions).toHaveCSS('opacity', '1')
    await expect(answerActions).toHaveCSS('opacity', '0')
  })

  test(`terminal tabs hold shell actions and per-shell close in one row in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation&frame-terminal=1', theme)
    const row = page.locator('[data-terminal-shell-tabs]')
    const tabs = row.getByRole('tab')
    await expect(row).toBeVisible()
    await expect(tabs).toHaveCount(1)

    const tab = tabs.first()
    const tabClose = row.locator('[data-slot="dock-panel-tab-close"]')
    const newShell = row.getByRole('button', { name: 'New shell' })
    const closeTerminal = row.getByRole('button', { name: 'Close terminal' })
    await expect(tabClose).toHaveCSS('opacity', '0')
    await tab.hover()
    await expect(tabClose).toHaveCSS('opacity', '1')
    const tooltip = (await newShell.getAttribute('title'))!
    expect(tooltip).toMatch(/^New shell in /)
    expect(tooltip).not.toContain('\n')
    expect(tooltip.length).toBeLessThanOrEqual(42)
    expect((await tab.getAttribute('title'))!.length).toBeLessThanOrEqual(32)
    await expect(page.locator('[data-terminal-id] [data-slot="tool-pane-bar"]')).toHaveCount(0)

    const rowBox = (await row.boundingBox())!
    const tabBox = (await tab.boundingBox())!
    const newBox = (await newShell.boundingBox())!
    const closeBox = (await closeTerminal.boundingBox())!
    const center = (box: { y: number; height: number }) => box.y + box.height / 2
    for (const box of [tabBox, newBox, closeBox]) expect(Math.abs(center(box) - center(rowBox))).toBeLessThanOrEqual(1)
    expect(newBox.x).toBeGreaterThan(tabBox.x + tabBox.width)
    expect(closeBox.x).toBeGreaterThan(newBox.x)
    expect(closeBox.x + closeBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width)
  })

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
  test(`Owner fix 2 page navigation preserves File and terminal nodes, menus and focus in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation&frame-explorer=plain&frame-tool=file&frame-tool-path=%2Fwork%2Fstorefront-branch%2Fsrc%2FREADME.md&frame-status=tasks', theme)
    const tools = page.locator('[data-slot="work-tools"]')
    const editor = tools.locator('.cm-content')
    await expect(tools.getByRole('heading', { name: 'Storefront', exact: true })).toBeVisible()
    await expect(editor).toHaveCount(0)
    await tools.getByRole('button', { name: 'Edit', exact: true }).click()
    await expect(editor).toContainText('Storefront')
    await expect(editor).toHaveAttribute('contenteditable', 'true')
    await editor.fill('Keep this dirty checkout note')
    await editor.evaluate(node => { node.dataset.b10Retained = 'file' })

    await page.locator('[data-slot="top-bar"]').getByRole('button', { name: 'Terminal', exact: true }).click()
    const terminal = page.locator('[data-terminal-id]')
    await expect(terminal).toBeVisible()
    const terminalId = await terminal.getAttribute('data-terminal-id')
    await terminal.evaluate(node => { node.dataset.b10Retained = 'terminal' })
    await page.locator('[data-frame-region="left"]').getByRole('button', { name: 'Agents', exact: true }).click()
    const destinationPage = page.locator('[data-page-destination="agents"]:visible')
    await expect(destinationPage).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(editor).toBeHidden()
    await expect(terminal).toBeVisible()
    await expect(page.locator('[data-slot="fixed-shell"]')).toHaveAttribute('data-right-open', 'true')
    await expect(terminal).toHaveAttribute('data-terminal-id', terminalId!)
    const bar = page.locator('[data-slot="top-bar"]:visible')
    await expect(bar.locator('[data-work-tool]')).toHaveCount(0)
    await expect(tools).toBeHidden()
    await expect(bar.getByRole('button', { name: 'More', exact: true })).toHaveCount(1)
    await destinationPage.getByRole('button', { name: /Code reviewer / }).click()
    const more = bar.getByRole('button', { name: 'More', exact: true })
    await expect(more).toHaveCount(1)
    await more.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('menu')).toBeVisible()
    await expect(page.getByRole('menuitemradio', { name: /Terminal/ })).toHaveAttribute('aria-checked', 'true')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(destinationPage).toBeVisible()
    await expect(more).toBeFocused()
    await page.keyboard.press('Meta+w')
    await expect(destinationPage).toHaveCount(0)
    await bar.getByRole('button', { name: 'More', exact: true }).click()
    await expect(page.getByRole('menuitemradio', { name: /Terminal/ })).toHaveCount(1)
    await expect(page.getByRole('menuitemradio', { name: /Terminal/ })).toHaveAttribute('aria-checked', 'true')
    await page.keyboard.press('Escape')
    await expect(terminal).toBeVisible()
    await expect(terminal).toHaveAttribute('data-terminal-id', terminalId!)
    await expect(terminal).toHaveAttribute('data-b10-retained', 'terminal')

    await bar.getByRole('button', { name: 'Files', exact: true }).click()
    const files = page.locator('[data-shell-files-tree]')
    await expect(files).toBeVisible()
    await files.getByRole('button', { name: 'README.md', exact: true }).click()
    await expect(tools).toBeVisible()
    await expect(editor).toBeVisible()
    await expect(page.locator('[data-b10-retained="file"]')).toHaveCount(1)
    await expect(editor).toContainText('Keep this dirty checkout note')
    await expect(terminal).toBeHidden()
    await expect(terminal).toHaveAttribute('data-terminal-id', terminalId!)
    await expect(terminal).toHaveAttribute('data-b10-retained', 'terminal')
    await bar.getByRole('button', { name: 'Terminal', exact: true }).click()
    await expect(terminal).toBeVisible()
    await expect(terminal).toHaveAttribute('data-terminal-id', terminalId!)
  })
}

for (const theme of WALL_THEMES) {
  test(`R5.6 Browser address placeholder fits the tool field in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation', theme, 1100)
    await page.locator('[data-slot="top-bar"]:visible').getByRole('button', { name: 'Browser', exact: true }).click()
    const address = page.getByRole('textbox', { name: 'Address', exact: true })
    await expect(address).toHaveAttribute('placeholder', 'Enter a URL or query')
    for (const width of [1100, 720]) {
      await page.setViewportSize({ width, height: 900 })
      const fit = await address.evaluate((input: HTMLInputElement) => {
        const style = getComputedStyle(input)
        const canvas = document.createElement('canvas')
        const context = canvas.getContext('2d')!
        context.font = style.font
        const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
        return { text: context.measureText(input.placeholder).width, room: input.clientWidth - padding }
      })
      expect(fit.text).toBeLessThanOrEqual(fit.room)
    }
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
  test(`B8 Team wide column caps allocated rows and contains names in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=team', theme)
    const overview = page.locator('[data-slot="team-overview"]')
    const seats = overview.locator('[aria-label="Seats"]')
    const column = overview.locator('[data-slot="page"]')
    await expect(column).toHaveAttribute('data-width', 'wide')
    // Seats become a table at 800px; larger windows still cap the wide page.
    for (const width of [1100, 1440, 1800, 2200]) {
      await page.setViewportSize({ width, height: 900 })
      const columnWidth = Math.min((await overview.boundingBox())!.width, FRAME.page.wide + 2 * FRAME.page.gutter)
      const seatsWidth = columnWidth - 2 * FRAME.page.gutter
      await expect.poll(async () => (await column.boundingBox())!.width).toBe(columnWidth)
      await expect.poll(async () => (await seats.boundingBox())!.width).toBe(seatsWidth)
      const narrow = seatsWidth < 800
      await expect(overview).toHaveAttribute('data-layout', narrow ? 'narrow' : 'table')
      await expect(seats.getByRole('table')).toHaveCount(narrow ? 0 : 1)
      for (const name of ['Alpha', 'Beta']) {
        const action = seats.getByRole('button', { name: `Open ${name}`, exact: true })
        await expect(action).toBeVisible()
        const cell = action.locator(`xpath=ancestor::*[@data-slot="${narrow ? 'list-row-title' : 'table-cell'}"]`)
        const bounds = (await cell.boundingBox())!
        const label = (await action.boundingBox())!
        expect(label.x).toBeGreaterThanOrEqual(bounds.x)
        expect(label.x + label.width).toBeLessThanOrEqual(bounds.x + bounds.width)
      }
    }
  })
  for (const width of [1280, 1279, 1000, 999, 720]) {
    test(`B8 tool pane replaces main below the narrow fold at ${width} in ${theme}`, async ({ page }) => {
      await openFrame(page, 'frame-wall=conversation', theme, width)
      await page.getByRole('button', { name: 'Browser', exact: true }).click()
      const shell = page.locator('[data-slot="fixed-shell"]')
      const narrow = width < FRAME.fold.panelFloats
      await expect(shell).toHaveAttribute('data-panel-floats', String(narrow))
      await expect(shell).toHaveAttribute('data-left-floats', String(width < FRAME.fold.sidebarFloats))
      const main = page.locator('[data-frame-region="main"]')
      expect(await main.evaluate(node => node.closest('[inert]') !== null)).toBe(narrow)
      await expect(page.locator('[data-region="sidebar"] [data-slot="dock-panel"]')).toHaveCount(0)
      const panel = (await page.locator('[data-frame-region="right"]').boundingBox())!
      expect(panel.y).toBe(0)
      expect(panel.height).toBe(900)
      expect(panel.x).toBeGreaterThanOrEqual(0)
      expect(panel.x + panel.width).toBe(width)
      if (narrow) {
        await expect(main).toBeHidden()
        expect(panel.width).toBe(width)
        await expect(page.getByRole('button', { name: 'Return to main', exact: true }).first()).toBeVisible()
      } else {
        await expect(main).toBeVisible()
        const reading = (await main.boundingBox())!
        const floor = Math.min(FRAME.main.min, width - FRAME.sidebar.width - FRAME.rightPanel.min - 2)
        expect(reading.width).toBeGreaterThanOrEqual(floor)
        expect(reading.x + reading.width).toBeLessThanOrEqual(panel.x)
      }
    })
  }
  test(`B8 terminal pane resizes on the right and retains its resource across closing and short windows in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation&frame-terminal=1', theme)
    const panel = page.locator('[data-frame-region="right"]')
    const terminal = page.locator('[data-terminal-id]')
    const id = await terminal.getAttribute('data-terminal-id')
    await expect(terminal).toBeVisible()
    await expect(page.getByRole('separator', { name: 'Resize the bottom panel' })).toHaveCount(0)
    const seam = page.getByRole('separator', { name: 'Resize the right panel', exact: true })
    await seam.focus()
    await seam.press('ArrowLeft')
    const nudge = Math.round((FRAME.rightPanel.max - FRAME.rightPanel.min) * 0.02)
    await expect.poll(async () => (await panel.boundingBox())!.width).toBe(FRAME.rightPanel.width + nudge)
    await expect(seam).toBeFocused()
    await seam.press('ArrowRight')
    await expect.poll(async () => (await panel.boundingBox())!.width).toBe(FRAME.rightPanel.width)
    await seam.press('End')
    await expect.poll(async () => (await panel.boundingBox())!.width).toBe(FRAME.rightPanel.max)
    await expect(seam).toBeFocused()
    await seam.press('Home')
    await expect.poll(async () => (await panel.boundingBox())!.width).toBe(FRAME.rightPanel.min)
    await expect(seam).toBeFocused()
    await seam.dblclick()
    expect((await panel.boundingBox())!.width).toBe(FRAME.rightPanel.width)
    for (const height of [240, 239, 900]) {
      await page.setViewportSize({ width: 1440, height })
      await expect.poll(async () => (await panel.boundingBox())!.height).toBe(height)
      await expect(terminal).toBeVisible()
      await expect(terminal).toHaveAttribute('data-terminal-id', id!)
    }
    await page.getByRole('button', { name: 'Close pane', exact: true }).click()
    await expect(terminal).toBeHidden()
    await expect(terminal).toHaveAttribute('data-terminal-id', id!)
    await page.getByRole('button', { name: 'Terminal', exact: true }).click()
    await expect(terminal).toBeVisible()
    await expect(terminal).toHaveAttribute('data-terminal-id', id!)
  })
}

for (const theme of WALL_THEMES) for (const tool of ['terminal', 'changes', 'browser', 'files']) {
  test(`B7a ${tool} has one pane header and a flat body in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation', theme)
    await page.locator(`[data-work-tool="${tool}"]`).click()
    const panel = page.locator('[data-frame-region="right"]')
    const body = panel.locator(tool === 'terminal' ? '[data-terminal-id]' : tool === 'files' ? '[data-shell-files-tree]' : '[data-slot="work-tools"]')
    await expect(body).toBeVisible()
    await expect(panel.locator('[data-work-pane-header]')).toHaveCount(1)
    for (const slot of ['dock-panel-tabs', 'dock-panel-bar', 'inspector-tools', 'tool-pane-header', 'card-header']) {
      expect(await body.locator(`[data-slot="${slot}"]`).count(), `${tool}: ${slot} retired from the body`).toBe(0)
    }
    const bounds = (await panel.boundingBox())!
    expect(bounds.y).toBe(0)
    expect(bounds.height).toBe(900)
  })
}

for (const theme of WALL_THEMES) {
  test(`B7 shell owns the retained tool pane independently of the rail in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation', theme)
    await page.locator('[data-work-tool="changes"]').click()
    await expect(page.locator('[data-slot="dock-panel-tabs"]')).toHaveCount(0)
    await expect(page.locator('[data-slot="inspector-tools"]')).toHaveCount(0)
    const tool = page.locator('[data-slot="work-tools"]')
    await expect(tool).toBeVisible()
    expect(Math.round((await page.locator('[data-slot="top-bar"]').locator('..').boundingBox())!.height)).toBe(FRAME.bar.height)
    const mounts = await page.locator('[data-tool-mount]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-tool-mount')))
    await page.getByRole('button', { name: 'Close pane', exact: true }).click()
    await expect(tool).toBeHidden()
    await expect(page.locator('[data-frame-region="rail"]')).toBeVisible()
    await page.locator('[data-work-tool="changes"]').click()
    await expect(tool).toBeVisible()
    expect(await page.locator('[data-tool-mount]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-tool-mount')))).toEqual(mounts)
  })
}

for (const theme of WALL_THEMES) {
  test(`B2 legacy tools open on the right without changing work in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation&frame-tool=tasks', theme)
    const main = page.locator('[data-slot="workbench-main"]')
    await expect(main).toBeVisible()
    await expect(page.locator('[data-slot="work-tools"]:visible')).toBeVisible()
    expect((await main.boundingBox())!.width).toBeGreaterThanOrEqual(FRAME.main.min)
  })
}

for (const theme of WALL_THEMES) {
  test(`B4 embedded member retains scoped actions in the canonical Team bar in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=team&frame-member-actions=1', theme)
    const bar = page.locator('[data-slot="top-bar"]')
    const railToggle = bar.getByRole('button', { name: 'Toggle rail', exact: true })
    if (await railToggle.getAttribute('aria-pressed') !== 'true') await railToggle.click()
    await page.getByRole('button', { name: 'Actions for Alpha', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Open conversation', exact: true }).click()
    await expect(bar).toHaveCount(1)
    expect(await bar.locator('[data-work-tool]').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.workTool))).toEqual(['terminal', 'changes', 'browser', 'files'])
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
  test(`B3 rail Commit reaches its conversation after Browser focus in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation', theme)
    const bar = page.locator('[data-slot="top-bar"]')
    await bar.getByRole('button', { name: 'Browser', exact: true }).click()
    const address = page.getByRole('textbox', { name: 'Address', exact: true })
    await address.click()
    await expect(address).toBeFocused()
    const railToggle = bar.getByRole('button', { name: 'Toggle rail', exact: true })
    if (await railToggle.getAttribute('aria-pressed') !== 'true') await railToggle.click()
    await page.getByRole('button', { name: 'Folder actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Commit the changes', exact: true }).click()
    const composer = page.locator('[data-slot="workbench-main"] textarea')
    await expect(composer).toHaveValue('Commit the changes from this conversation with a clear message, then tell me the commit hash.')
    await expect(composer).toBeFocused()
    await expect(page.locator('input[aria-label="Address"]')).toHaveCount(1)
    await expect(page.locator('input[aria-label="Address"]')).toBeVisible()
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
        .toEqual(['terminal', 'changes', 'browser', 'files'])
      if (destination === 'draft') {
        await expect(top.getByRole('button', { name: 'Changes', exact: true })).toBeDisabled()
        await expect(top.getByRole('button', { name: 'Files', exact: true })).toBeEnabled()
      }
      const railToggle = top.getByRole('button', { name: 'Toggle rail', exact: true })
      if (await railToggle.getAttribute('aria-pressed') !== 'true') await railToggle.click()
      const details = page.locator('[data-slot="tool-body"]:visible')
      // A draft has no session and no plan yet, so its Plan section is not drawn.
      if (destination === 'draft') await expect(details.getByText('Plan', { exact: true })).toHaveCount(0)
      else await expect(details.getByText('Plan', { exact: true })).toBeVisible()
      await expect(details.locator('[data-slot="summary-card"]').first()).toHaveAttribute('data-surface', 'panel')
      const firstTool = (await top.locator('[data-work-rail-toggle]').boundingBox())!
      expect(firstTool.width).toBe(FRAME.bar.iconButton)
      const more = (await top.getByRole('button', { name: 'More', exact: true }).boundingBox())!
      expect(more.x + more.width + FRAME.bar.pad).toBe(1440)
      const keys = details.locator('[data-slot="summary-item"] dt')
      const widths = await keys.evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().width)))
      expect(widths).toEqual(widths.map(() => FRAME.summaryKey.panel))
    })
  }
}

for (const theme of WALL_THEMES) {
  test(`B3 subject bar follows the live pane seam in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation', theme)
    const bar = page.locator('[data-slot="top-bar"]')
    await bar.getByRole('button', { name: 'Browser', exact: true }).click()
    const pane = page.locator('[data-frame-region="right"]')
    const more = bar.getByRole('button', { name: 'More', exact: true })
    const panelBefore = (await pane.boundingBox())!
    const moreBefore = (await more.boundingBox())!
    const seam = (await page.getByRole('separator', { name: 'Resize the right panel', exact: true }).boundingBox())!
    const start = seam.x + seam.width / 2
    await page.mouse.move(start, 400)
    await page.mouse.down()
    await page.mouse.move(start - 40, 400, { steps: 6 })
    await expect.poll(async () => Math.round((await pane.boundingBox())!.width)).toBe(Math.round(panelBefore.width) + 40)
    const painted = (await pane.boundingBox())!
    const liveMore = (await more.boundingBox())!
    expect(liveMore.x).toBe(moreBefore.x - 40)
    expect(liveMore.x + liveMore.width + FRAME.bar.pad).toBe(painted.x)
    await page.mouse.up()
    const committedMore = (await more.boundingBox())!
    expect(committedMore.x + committedMore.width + FRAME.bar.pad).toBe((await pane.boundingBox())!.x)
  })
}

for (const theme of WALL_THEMES) {
  test(`B11 rail and one tool pane retain work independently and refuse free docking in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation&frame-terminal=1', theme)
    await expect(page.locator('[data-slot="top-bar"] [data-work-tool]')).toHaveCount(4)
    const rail = page.locator('[data-frame-region="rail"]')
    const terminal = page.locator('[data-terminal-id]')
    const terminalId = await terminal.getAttribute('data-terminal-id')
    await expect(terminal).toBeVisible()
    await expect(rail.getByText('Plan', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Changes', exact: true }).click()
    await expect(rail).toBeVisible()
    await expect(terminal).toBeHidden()
    await expect(terminal).toHaveAttribute('data-terminal-id', terminalId!)
    await page.getByRole('button', { name: 'Toggle rail', exact: true }).click()
    await expect(rail).toBeHidden()
    await expect(page.locator('[data-slot="work-tools"]')).toBeVisible()
    await page.getByRole('button', { name: 'Terminal', exact: true }).click()
    await expect(terminal).toBeVisible()
    await expect(terminal).toHaveAttribute('data-terminal-id', terminalId!)
    await expect(rail).toBeHidden()
    await expect(page.locator('[draggable="true"][data-tool-mount]')).toHaveCount(0)
    await expect(page.locator('[data-slot="dock-panel-tabs"]')).toHaveCount(0)
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
    await page.getByRole('button', { name: 'Browser', exact: true }).click()
    await drag('Resize the right panel', -800)
    await expect.poll(async () => (await panel.boundingBox())!.width).toBe(FRAME.rightPanel.max)
    measurements.rightMax = (await panel.boundingBox())!.width
    await drag('Resize the right panel', 800)
    await expect.poll(async () => (await panel.boundingBox())!.width).toBe(FRAME.rightPanel.min)
    measurements.rightMin = (await panel.boundingBox())!.width
    await testInfo.attach('merged-seam-endpoints', { body: JSON.stringify(measurements), contentType: 'application/json' })
  })
}
