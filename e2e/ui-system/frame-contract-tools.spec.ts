import { applyLeftColumnActions } from './left-column-actions'
import { expect, test } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'
import { WALL_THEMES, WALL_WIDTHS } from './frame-wall-destinations'
import { openFrame } from './frame-contract-helpers'


// Contract runs measure the preview; the final wall owns images and recordings.
test.use({ screenshot: 'off', trace: 'off', video: 'off' })


{

  for (const [item0, width] of ([1440, 1100]).entries()) test(`R10.30 terminal occupies main while the right panel keeps its frame height [item ${[item0].join('-')}]`, async ({ page }) => {

    await openFrame(page, 'frame-wall=conversation&frame-terminal=1', 'light', width)
    await page.locator('[data-work-tool="details"]').click()
    const main = page.locator('[data-frame-region="main"]')
    const right = page.locator('[data-frame-region="right"]')
    const bottom = page.locator('[data-frame-region="bottom"]')
    await expect(bottom.locator('[data-terminal-id]')).toBeVisible()
    await expect(right).toBeVisible()
    const geometry = await page.evaluate(() => {
      const box = (selector: string) => {
        const rect = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect()
        return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom }
      }
      return {
        shell: box('[data-slot="fixed-shell"]'),
        main: box('[data-frame-region="main"]'),
        right: box('[data-frame-region="right"]'),
        bottom: box('[data-frame-region="bottom"]'),
        floating: document.querySelector('[data-slot="fixed-shell"]')!.getAttribute('data-panel-floats') === 'true',
      }
    })
    expect(Math.abs(geometry.bottom.x - geometry.main.x), 'terminal starts with main').toBeLessThanOrEqual(1)
    expect(Math.abs(geometry.bottom.right - geometry.main.right), 'terminal ends with main').toBeLessThanOrEqual(1)
    if (width >= FRAME.fold.panelFloats) {
      expect(Math.abs(geometry.right.x - geometry.main.right), 'standing panel follows main').toBeLessThanOrEqual(1)
      expect(Math.abs(geometry.right.bottom - geometry.shell.bottom), 'standing panel reaches the shell bottom').toBeLessThanOrEqual(1)
    } else {
      expect(geometry.floating).toBe(true)
      expect(Math.abs(geometry.right.bottom - geometry.bottom.y), 'floating panel stops above terminal').toBeLessThanOrEqual(1)
    }


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
  test(`Owner fix 2 modal tools preserve work intent and preserve File and terminal nodes in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation&frame-tool=file&frame-tool-path=%2Frepo%2FREADME.md&frame-terminal=1&frame-status=tasks', theme)
    const tools = page.locator('[data-slot="work-tools"]')
    const editor = tools.locator('.cm-content')
    await expect(tools.getByRole('heading', { name: 'Storefront', exact: true })).toBeVisible()
    await expect(editor).toHaveCount(0)
    await tools.getByRole('button', { name: 'Edit', exact: true }).click()
    await expect(editor).toContainText('Storefront')
    await expect(editor).toHaveAttribute('contenteditable', 'true')
    await editor.fill('Keep this dirty checkout note')
    await editor.evaluate(node => { node.dataset.b10Retained = 'file' })
    const terminal = page.locator('[data-terminal-id]')
    await expect(terminal).toBeVisible()
    const terminalId = await terminal.getAttribute('data-terminal-id')
    await terminal.evaluate(node => { node.dataset.b10Retained = 'terminal' })
    await page.locator('[data-frame-region="left"]').getByRole('button', { name: 'Agents', exact: true }).click()
    const destinationPage = page.locator('[data-page-destination="agents"]:visible')
    await expect(destinationPage).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(editor).toBeHidden()
    await expect(terminal).toBeHidden()
    await expect(page.locator('[data-slot="fixed-shell"]')).toHaveAttribute('data-bottom-open', 'false')
    await expect(terminal).toHaveAttribute('data-terminal-id', terminalId!)
    const bar = page.locator('[data-slot="top-bar"]:visible')
    await expect(bar.locator('[data-work-tool]')).toHaveCount(0)
    await expect(page.locator('[data-slot="work-tools"]')).toBeHidden()
    await expect(bar.getByRole('button', { name: 'More', exact: true })).toHaveCount(0)
    await destinationPage.getByRole('button', { name: /Code reviewer / }).click()
    const more = bar.getByRole('button', { name: 'More', exact: true })
    await expect(more).toHaveCount(1)
    await more.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('menu')).toBeVisible()
    await expect(page.getByRole('menuitemradio', { name: /Terminal/ })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(destinationPage).toBeVisible()
    await expect(more).toBeFocused()
    await page.keyboard.press('Meta+w')
    await expect(destinationPage).toHaveCount(0)
    await page.locator('[data-slot="top-bar"]:visible').getByRole('button', { name: 'More', exact: true }).click()
    await expect(page.getByRole('menuitemradio', { name: /Terminal/ })).toHaveCount(1)
    await expect(page.getByRole('menuitemradio', { name: /Terminal/ })).toHaveAttribute('aria-checked', 'true')
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-slot="work-tools"]')).toBeVisible()
    await expect(page.locator('[data-b10-retained="file"]')).toHaveCount(1)
    await expect(editor).toContainText('Keep this dirty checkout note')
    await expect(terminal).toHaveAttribute('data-terminal-id', terminalId!)
    await expect(terminal).toHaveAttribute('data-b10-retained', 'terminal')
    await expect(terminal).toBeVisible()
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
  test(`B8 Agents layout measures allocated rows and keeps names inside their column in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=team', theme)
    await page.locator('[data-work-tool="details"]').click()
    await expect(page.locator('[data-frame-region="right"]:visible')).toBeVisible()
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
      if (width < FRAME.fold.panelFloats) {
        const sidebar = width < FRAME.fold.sidebarFloats ? 0 : FRAME.sidebar.width
        expect(panel.width).toBe(Math.min(FRAME.rightPanel.width, Math.max(FRAME.rightPanel.min, width - sidebar - FRAME.main.min - 2)))
        expect(panel.width).toBeGreaterThanOrEqual(FRAME.rightPanel.min)
        expect((await main.boundingBox())!.x + (await main.boundingBox())!.width).toBeLessThanOrEqual(panel.x)
      }
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
