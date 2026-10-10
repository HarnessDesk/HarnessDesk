import { expect, test, type Page } from '@playwright/test'
import { FRAME, FRAME_TOKENS } from '../../packages/ui/src/design/frame'
import { WALL_THEMES } from './frame-wall-destinations'
import { selectFrameTab } from './frame-actions'

/**
 * The rendered check (spec, "How it is checked"): the app measured against
 * the frame contract in `packages/ui/src/design/frame.ts`. Each phase of the
 * frame work adds what it moved; nothing here is a literal of its own.
 */
const openFrame = async (page: Page, query: string, theme: 'light' | 'dark', width = 1440) => {
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

for (const theme of WALL_THEMES) {
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
    // the same timeline without reselecting or releasing the retained cache.
    await page.locator('[data-slot="top-bar"]').getByRole('button', { name: 'Toggle right panel', exact: true }).click()
    await expect(main).toBeVisible()
    await expect(main).toContainText('Round 1')
    // The ordinary wall Run truthfully records no Flow steps. Use the existing
    // synthetic recorded-Flow rig for its narrow Steps visibility boundary.
    await openFrame(page, 'run-dock', theme, 720)
    await selectFrameTab(page, 'run')
    await main.getByRole('radio', { name: 'Flow', exact: true }).click()
    await expect(main.locator('[data-slot="flow-list"]')).toHaveAttribute('data-placement', 'below')
    // The canonical toggle restores remembered Details on one press; retained
    // legacy Steps stay hidden and Flow keeps its own Steps and Rules below.
    await page.getByRole('button', { name: 'Toggle right panel', exact: true }).click()
    await expect(page.locator('[data-slot="tool-body"]:visible')).toContainText('Seats')
    await expect(page.locator('[data-slot="run-steps"]:visible')).toHaveCount(0)
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
