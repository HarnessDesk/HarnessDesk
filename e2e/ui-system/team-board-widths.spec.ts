import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'
import { COLLECT, textReasons } from '../../script/shots/audit.mjs'

test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } })

for (const theme of ['light', 'dark'] as const) {
  test(`B6 Board facts and canvas retain the existing content gap in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/preview.html?board-list')
    const pane = page.locator('[data-frame-id="board-list-page"]')
    const bar = pane.locator('[data-slot="top-bar"]').locator('xpath=ancestor::*[@data-slot="bar"][1]')
    const board = pane.locator('[data-slot="board"]')
    await expect(bar).toBeVisible()
    await expect(board).toBeVisible()
    await page.evaluate(() => document.fonts.ready)
    await expect.poll(async () => (await board.boundingBox())!.y - ((await bar.boundingBox())!.y + (await bar.boundingBox())!.height)).toBe(FRAME.page.canvasGutter)
  })
  for (const width of [1440, 1000, 900, 760, 640, 560]) {
    test(`board columns keep their width in a ${width}px pane in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 })
      await page.emulateMedia({ colorScheme: theme })
      await page.goto('/preview.html?board-list')
      const pane = page.locator('[data-frame-id="board-list-page"]')
      await page.evaluate(() => document.fonts.ready)
      expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
      if (process.env.HD_BOARD_WIDTH_FRAMES) await pane.screenshot({ path: `${process.env.HD_BOARD_WIDTH_FRAMES}/${width}-${theme}.png` })
      if (width < 600) {
        const table = pane.getByRole('table', { name: 'Jobs' })
        await expect(table).toHaveAttribute('data-hd-table', 'compact')
        await expect(pane.locator('[data-slot="board-list"]')).toHaveAttribute('data-grouped', 'true')
        await expect(table.locator('[data-state-group]').first()).toContainText('Needs you')
        await expect(table.locator('tbody tr[data-job]')).toHaveCount(4)
        return
      }
      const board = pane.locator('[data-slot="board"]')
      const columns = board.locator('[data-slot="board-column"]')
      await expect(columns).toHaveCount(5)
      await expect(board.locator('[data-slot="board-column"][data-collapsed]')).toHaveCount(0)
      for (const column of await columns.all()) expect((await column.boundingBox())!.width).toBeGreaterThanOrEqual(220)
      expect(await board.evaluate(el => el.scrollWidth - el.clientWidth)).toBeGreaterThan(0)
    })
  }
  test(`empty columns stay full width in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1000 })
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/preview.html?team-frame=board')
    const board = page.locator('[data-slot="board"]')
    const columns = board.locator('[data-slot="board-column"]')
    await expect(columns).toHaveCount(5)
    expect(await columns.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-column')))).toEqual(['needs', 'working', 'review', 'todo', 'ready'])
    await expect(board.locator('[data-slot="board-column"][data-collapsed]')).toHaveCount(0)
    for (const column of await columns.all()) expect((await column.boundingBox())!.width).toBeGreaterThanOrEqual(220)
    expect(await board.evaluate(el => el.scrollWidth - el.clientWidth)).toBeGreaterThan(0)
  })
  test(`board follows the pane when the window stays wide in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/preview.html?board-list')
    const pane = page.locator('[data-frame-id="board-list-page"]')
    await pane.evaluate(el => { el.style.width = '560px' })
    await expect(pane.getByRole('table', { name: 'Jobs' })).toHaveAttribute('data-hd-table', 'compact')
    await pane.evaluate(el => { el.style.width = '1000px' })
    await expect(pane.locator('[data-slot="board"]')).toBeVisible()
    await expect(pane.locator('[data-column="ready"] h3')).toBeVisible()
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`empty Board columns keep the standard width in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 1000 })
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/preview.html?board-list')
    const board = page.locator('[data-slot="board"]')
    const empty = board.locator('[data-column="ready"]')
    await expect(empty).not.toHaveAttribute('data-collapsed')
    expect((await empty.boundingBox())!.width).toBeGreaterThanOrEqual(220)
    expect(await board.evaluate(el => el.scrollWidth - el.clientWidth)).toBeGreaterThan(0)
  })

  test(`compact Board choice explains its width and keeps the preference in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 1000 })
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/preview.html?board-list')
    const pane = page.locator('[data-frame-id="board-list-page"]')
    const view = pane.getByRole('button', { name: 'View', exact: true })
    await view.click()
    await page.getByRole('menuitem', { name: 'List', exact: true }).click()
    await expect(pane.locator('[data-slot="board-list"]')).toBeVisible()
    await page.setViewportSize({ width: 604, height: 1000 })
    await view.click()
    const board = page.getByRole('menuitem').filter({ has: page.getByText('Board', { exact: true }) })
    await expect(board).toHaveAttribute('aria-disabled', 'true')
    expect(await page.locator('[data-slot="tool-pane-body"]').evaluate(el => el.clientWidth)).toBe(596)
    if (process.env.HD_BOARD_REPAIR_FRAMES) await page.screenshot({ path: `${process.env.HD_BOARD_REPAIR_FRAMES}/compact-${theme}.png` })
    await expect(board).toHaveAttribute('title', 'Board needs at least 600px of content width')
    await page.keyboard.press('Escape')
    await page.setViewportSize({ width: 1000, height: 1000 })
    await expect(pane.locator('[data-slot="board-list"]')).toBeVisible()
    await view.click()
    await expect(board).not.toHaveAttribute('aria-disabled', 'true')
    await board.click()
    await expect(pane.locator('[data-slot="board"]')).toBeVisible()
  })

  test(`scrolling Board keeps every column at full width through viewport changes in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/preview.html?board-list')
    await page.addStyleTag({ content: '*::-webkit-scrollbar { display: block !important; width: 8px !important; } [data-slot="tool-pane-body"] { overflow-y: scroll !important; scrollbar-gutter: stable; }' })
    const board = page.locator('[data-slot="board"]')
    const body = page.locator('[data-slot="tool-pane-body"]')
    await expect.poll(() => body.evaluate(el => el.offsetWidth - el.clientWidth)).toBe(8)
    for (const width of [812, 814, 988, 990, 1164, 1166]) {
      await page.setViewportSize({ width, height: 300 })
      await expect.poll(() => board.evaluate(el => {
        const columns = [...el.querySelectorAll('[data-slot="board-column"]')]
        return el.scrollWidth > el.clientWidth && columns.length === 5 && columns.every(column => !column.hasAttribute('data-collapsed') && column.getBoundingClientRect().width >= 220)
      })).toBe(true)
    }
    // Removing and restoring a scrollbar remeasures without changing the pane's border box.
    await page.setViewportSize({ width: 990, height: 1000 })
    const todo = board.locator('[data-column="todo"]')
    await expect(todo).not.toHaveAttribute('data-collapsed')
    await page.addStyleTag({ content: '[data-slot="tool-pane-body"] { overflow-y: hidden !important; scrollbar-gutter: auto; }' })
    await expect.poll(() => body.evaluate(el => el.offsetWidth - el.clientWidth)).toBe(0)
    await expect(todo).not.toHaveAttribute('data-collapsed')
    await page.addStyleTag({ content: '[data-slot="tool-pane-body"] { overflow-y: scroll !important; scrollbar-gutter: stable; }' })
    await expect.poll(() => body.evaluate(el => el.offsetWidth - el.clientWidth)).toBe(8)
    await expect(todo).not.toHaveAttribute('data-collapsed')
    await expect.poll(() => board.evaluate(el => el.scrollWidth - el.clientWidth)).toBeGreaterThan(0)
    expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
    if (process.env.HD_BOARD_WIDTH_FRAMES) await page.locator('[data-frame-id="board-list-page"]').screenshot({ path: `${process.env.HD_BOARD_WIDTH_FRAMES}/scrolling-990-${theme}.png` })
  })
}

test('the interface names board columns in their rendered order', async ({ page }) => {
  await page.goto('/preview.html?board-list')
  const names = await page.locator('[data-slot="board-column"] h3').allTextContents()
  const paragraph = readFileSync('docs/interface.md', 'utf8').split('**On a card.**')[1]!.split('A completed card')[0]!
  expect(paragraph).toContain(names.join(', '))
})

for (const theme of ['light', 'dark'] as const) {
    test(`tall board keeps full empty columns and their lines in the first viewport in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 800 })
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/preview.html?board-list&tall=todo')
    const pane = page.locator('[data-frame-id="board-list-page"]')
    await expect(pane.locator('[data-column="todo"] [data-slot="board-card"]')).toHaveCount(13)
    await page.evaluate(() => document.fonts.ready)
    expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
    if (process.env.HD_BOARD_REPAIR_FRAMES) await pane.screenshot({ path: `${process.env.HD_BOARD_REPAIR_FRAMES}/tall-${theme}.png` })
    const ready = pane.locator('[data-column="ready"]')
    await expect(ready).not.toHaveAttribute('data-collapsed')
    expect((await ready.boundingBox())!.width).toBeGreaterThanOrEqual(220)
    const empty = pane.locator('[data-slot="board-empty"]')
    await expect(empty).toHaveCount(2)
    for (const label of await empty.all()) {
      const bounds = await label.boundingBox()
      expect(bounds!.y).toBeGreaterThanOrEqual(0)
      expect.soft(bounds!.y + bounds!.height).toBeLessThanOrEqual(800)
    }
  })

  test(`neighboring Board columns keep their headers aligned in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 800 })
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/preview.html?board-list')
    const pane = page.locator('[data-frame-id="board-list-page"]')
    const ready = pane.locator('[data-column="ready"]')
    await page.evaluate(() => document.fonts.ready)
    expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
    expect((await ready.boundingBox())!.width).toBeGreaterThanOrEqual(220)
    await expect(ready).not.toHaveAttribute('data-collapsed')
    if (process.env.HD_BOARD_REPAIR_FRAMES) await pane.screenshot({ path: `${process.env.HD_BOARD_REPAIR_FRAMES}/aligned-${theme}.png` })
    const needs = pane.locator('[data-column="needs"]')
    for (const selector of ['header', 'h3', '[data-slot="board-card"]']) {
      const neighbor = (await needs.locator(selector).first().boundingBox())!
      const opened = (await ready.locator(selector).first().boundingBox())!
      expect(opened.y).toBe(neighbor.y)
      if (selector === 'header') expect(opened.height).toBe(neighbor.height)
    }
  })
}

test('the compact threshold is documented in content width', () => {
  const paragraph = readFileSync('docs/interface.md', 'utf8').split('**As the board narrows.**')[1]!.split('**As a list.**')[0]!
  expect(paragraph).toContain('Below 600px of content width')
})

test.describe('board fit with the app scrollbar skin', () => {

  for (const theme of ['light', 'dark'] as const) {
    test(`scrollbar-dependent layouts keep full columns and settle at compact threshold in ${theme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme })
      await page.setViewportSize({ width: 984, height: 1000 })
      await page.goto('/preview.html?board-list&tall=todo')
      const pane = page.locator('[data-frame-id="board-list-page"]')
      await expect(pane.locator('[data-column="todo"] [data-slot="board-card"]')).toHaveCount(13)
      for (const width of Array.from({ length: 17 }, (_, index) => 984 + index)) {
        await page.setViewportSize({ width, height: 1000 })
        await expect.poll(() => pane.evaluate(el => el.getBoundingClientRect().width)).toBe(width)
        // Allow the resize commit, then sample the actual layout on successive paints.
        const states = await pane.evaluate(async el => {
          const read = () => {
            const body = el.querySelector<HTMLElement>('[data-slot="tool-pane-body"]')!
            const board = el.querySelector<HTMLElement>('[data-slot="board"]')!
            return { width: body.clientWidth, folded: [...board.querySelectorAll('[data-collapsed]')].map(one => one.getAttribute('data-column')), overflow: board.scrollWidth - board.clientWidth }
          }
          for (let frame = 0; frame < 3; frame++) await new Promise(requestAnimationFrame)
          const frames = []
          for (let frame = 0; frame < 12; frame++) {
            await new Promise(requestAnimationFrame)
            frames.push(read())
          }
          return frames
        })
        expect(new Set(states.map(state => JSON.stringify(state))).size, `${width}px`).toBe(1)
        expect(states[0]!.folded, `${width}px`).toEqual([])
        expect(states[0]!.overflow, `${width}px`).toBeGreaterThan(0)
      }
      await page.setViewportSize({ width: 990, height: 1000 })
      await expect(pane.locator('[data-column="todo"]')).not.toHaveAttribute('data-collapsed')
      expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
      if (process.env.HD_BOARD_WIDTH_FRAMES) await pane.screenshot({ path: `${process.env.HD_BOARD_WIDTH_FRAMES}/stable-todo-${theme}.png` })
      await page.setViewportSize({ width: 603, height: 840 })
      await page.goto('/preview.html?board-list')
      await expect(pane.getByRole('table', { name: 'Jobs' })).toBeVisible()
      const views = await pane.evaluate(async el => {
        const frames = []
        for (let frame = 0; frame < 12; frame++) {
          await new Promise(requestAnimationFrame)
          frames.push(Boolean(el.querySelector('[data-slot="board"]')))
        }
        return frames
      })
      expect(views).toEqual(Array(12).fill(false))
    })

    test(`columns do not offer folding controls and keep full width in ${theme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme })
      await page.setViewportSize({ width: 900, height: 1000 })
      await page.goto('/preview.html?board-list')
      const columns = page.locator('[data-slot="board-column"]')
      await expect(columns).toHaveCount(5)
      await expect(page.getByRole('button', { name: /Open column|Fold / })).toHaveCount(0)
      await expect(page.locator('[data-slot="board-column"][data-collapsed]')).toHaveCount(0)
      for (const column of await columns.all()) expect((await column.boundingBox())!.width).toBeGreaterThanOrEqual(220)
      expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
      if (process.env.HD_BOARD_WIDTH_FRAMES) await page.locator('[data-frame-id="board-list-page"]').screenshot({ path: `${process.env.HD_BOARD_WIDTH_FRAMES}/full-columns-${theme}.png` })
      const add = page.getByRole('button', { name: /^New job/ })
      await add.focus()
      await page.setViewportSize({ width: 1000, height: 1000 })
      await expect(add).toBeFocused()
    })

    test(`resolved rem spacing fits the same columns as px spacing in ${theme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme })
      await page.setViewportSize({ width: 1112, height: 1000 })
      await page.goto('/preview.html?board-list')
      const ready = page.locator('[data-column="ready"]')
      await expect(ready).not.toHaveAttribute('data-collapsed')
      await page.addStyleTag({ content: 'body { --hd-space-2: 0.5rem; --hd-space-3: 0.75rem; }' })
      // Trigger a measure after the foundation changes without changing the final width.
      await page.setViewportSize({ width: 1111, height: 1000 })
      await page.evaluate(async () => { for (let frame = 0; frame < 3; frame++) await new Promise(requestAnimationFrame) })
      await page.setViewportSize({ width: 1112, height: 1000 })
      await page.evaluate(async () => { for (let frame = 0; frame < 3; frame++) await new Promise(requestAnimationFrame) })
      await expect(ready).not.toHaveAttribute('data-collapsed')
      const box = await page.locator('[data-slot="board"]').evaluate(el => ({ gap: getComputedStyle(el).columnGap, overflow: el.scrollWidth - el.clientWidth }))
      expect(box.gap).toBe('12px')
      expect(box.overflow).toBeGreaterThan(0)
      expect((await ready.boundingBox())!.width).toBeGreaterThanOrEqual(220)
    })
  }
})
