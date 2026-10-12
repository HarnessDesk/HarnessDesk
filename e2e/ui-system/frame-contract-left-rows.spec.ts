import { expect, test } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'
import { WALL_THEMES } from './frame-wall-destinations'
import { openFrame } from './frame-contract-helpers'
import { useFrameContractEvidence } from './frame-contract-split-setup'
import { expectColumnRowEdges } from './frame-contract-left-column-helpers'

useFrameContractEvidence()


for (const theme of WALL_THEMES) {
  test(`D4 all work rows share the same text and icon edges in ${theme}`, async ({ page }) => {
    await openFrame(page, 'sidebar-structure', theme)
    const column = page.locator('#sidebar-structure')
    const rows = column.locator('[data-left-row]:visible:not(:has([data-draggable]))')
    expect(await rows.count()).toBeGreaterThan(3)
    const values = await expectColumnRowEdges(rows)
    const labels = await column.locator('[data-left-group-text]:visible')
      .evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().x))
    for (const x of labels) expect(Math.abs(x - values[0].icon)).toBeLessThanOrEqual(1)
    const groupType = await column.locator('[data-left-group-text]:visible')
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
        const region = column
        await expect.poll(async () => Math.abs((await region.boundingBox())!.width - width)).toBeLessThanOrEqual(1)
        const history = column.locator('[data-left-history]')
        if (destination === 'settings-navigation') await expect(history).toHaveCount(0)
        else if (width < 240) await expect(history).toBeHidden()
        else await expect(history).toBeVisible()
        const top = (await column.locator('[data-left-top] [data-slot="bar"]').boundingBox())!
        expect(top.height).toBe(FRAME.bar.height)
        const rows = column.locator('[data-left-row]:not([data-left-project]):visible')
        expect(await rows.count()).toBeGreaterThan(2)
        await expectColumnRowEdges(rows)
        const seat = column.locator('[data-left-seat]')
        expect((await seat.locator('..').boundingBox())!.height).toBe(FRAME.bar.height)
        await expect(seat.getByRole('button', { name: 'Settings', exact: true }))
          .toHaveAttribute('aria-pressed', destination === 'settings-navigation' ? 'true' : 'false')
      })
    }
  }
  }
}
