import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { COLLECT, textReasons } from '../../script/shots/audit.mjs'

test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } })

for (const theme of ['light', 'dark'] as const) {
  for (const width of [1440, 1000, 900, 760, 640, 560]) {
    test(`board rearranges in a ${width}px pane in ${theme}`, async ({ page }) => {
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
      const columns = board.locator('[data-slot="board-column"]:not([data-collapsed])')
      await expect(columns).toHaveCount(width === 1440 ? 5 : width === 900 ? 3 : 4)
      for (const column of await columns.all()) expect((await column.boundingBox())!.width).toBeGreaterThanOrEqual(220)
      expect(await board.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
      if (width <= 760) {
        const needs = await board.locator('[data-column="needs"]').boundingBox()
        const working = await board.locator('[data-column="working"]').boundingBox()
        const review = await board.locator('[data-column="review"]').boundingBox()
        const todo = await board.locator('[data-column="todo"]').boundingBox()
        expect(needs!.y).toBe(working!.y)
        expect(review!.y).toBe(todo!.y)
        expect(review!.y).toBeGreaterThan(needs!.y)
      }
      if (width === 900) await expect(board.getByRole('button', { name: 'To do 1 — Open column', exact: true })).toBeVisible()
      if (width !== 1440) await expect(board.getByRole('button', { name: 'Ready 1 — Open column', exact: true })).toBeVisible()
    })
  }
  test(`folded rails open and close in place with the keyboard in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 1000 })
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/preview.html?board-list')
    const pane = page.locator('[data-frame-id="board-list-page"]')
    const ready = pane.locator('[data-column="ready"]')
    const rail = ready.getByRole('button', { name: 'Ready 1 — Open column', exact: true })
    await rail.focus()
    await rail.press('Enter')
    await expect(ready).not.toHaveAttribute('data-collapsed')
    expect((await ready.boundingBox())!.width).toBeGreaterThanOrEqual(220)
    await expect(pane.locator('[data-slot="board-card"]')).toHaveCount(4)
    await expect(ready.locator('[data-slot="board-card"]')).toBeVisible()
    await expect(pane.locator('[data-column="todo"]')).toHaveAttribute('data-collapsed', 'true')
    expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
    if (process.env.HD_BOARD_WIDTH_FRAMES) await pane.screenshot({ path: `${process.env.HD_BOARD_WIDTH_FRAMES}/opened-${theme}.png` })
    await ready.getByRole('button', { name: 'Fold Ready', exact: true }).press('Enter')
    await expect(rail).toBeVisible()
    await expect(rail).toBeFocused()
    await rail.press('Enter')
    await page.setViewportSize({ width: 1440, height: 1000 })
    await expect(ready.getByRole('button', { name: 'Fold Ready', exact: true })).toHaveCount(0)
  })
  test(`board follows the pane when the window stays wide in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/preview.html?board-list')
    const pane = page.locator('[data-frame-id="board-list-page"]')
    await pane.evaluate(el => { el.style.width = '560px' })
    await expect(pane.getByRole('table', { name: 'Jobs' })).toHaveAttribute('data-hd-table', 'compact')
    await pane.evaluate(el => { el.style.width = '1000px' })
    await expect(pane.locator('[data-slot="board"]')).toBeVisible()
    await expect(pane.getByRole('button', { name: 'Ready 1 — Open column', exact: true })).toBeVisible()
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`folded columns keep the dense inset in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 1000 })
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/preview.html?board-list')
    const rail = page.locator('[data-column="ready"]')
    await expect(rail).toHaveAttribute('data-collapsed', 'true')
    const insets = await rail.evaluate(el => {
      const style = getComputedStyle(el)
      return [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft]
    })
    expect(insets).toEqual(['8px', '8px', '8px', '8px'])
  })

  test(`compact Board choice explains its width and keeps the preference in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 1000 })
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/preview.html?board-list')
    const board = page.getByRole('radio', { name: 'Board', exact: true })
    const list = page.getByRole('radio', { name: 'List', exact: true })
    await list.click()
    await page.setViewportSize({ width: 560, height: 1000 })
    await expect(board).toBeDisabled()
    await expect(board).toHaveAttribute('title', 'Board needs a pane at least 600px wide')
    await page.setViewportSize({ width: 1000, height: 1000 })
    await expect(board).toBeEnabled()
    await expect(list).toBeChecked()
    await board.click()
    await expect(board).toBeChecked()
  })

  test(`scrolling board keeps its gutters at fold thresholds in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/preview.html?board-list')
    await page.addStyleTag({ content: '*::-webkit-scrollbar { display: block !important; width: 8px !important; } [data-slot="tool-pane-body"] { overflow-y: scroll !important; scrollbar-gutter: stable; }' })
    const board = page.locator('[data-slot="board"]')
    const body = page.locator('[data-slot="tool-pane-body"]')
    await expect.poll(() => body.evaluate(el => el.offsetWidth - el.clientWidth)).toBe(8)
    for (const width of [812, 814, 988, 990, 1164, 1166]) {
      await page.setViewportSize({ width, height: 300 })
      await expect.poll(() => board.evaluate(el => {
        const open = [...el.querySelectorAll('[data-slot="board-column"]:not([data-collapsed])')]
        return el.scrollWidth - el.clientWidth <= 1 && open.every(column => column.getBoundingClientRect().width >= 220)
      })).toBe(true)
    }
    // Removing and restoring a scrollbar remeasures without changing the pane's border box.
    await page.setViewportSize({ width: 990, height: 1000 })
    const todo = board.locator('[data-column="todo"]')
    await expect(todo).toHaveAttribute('data-collapsed', 'true')
    await page.addStyleTag({ content: '[data-slot="tool-pane-body"] { overflow-y: hidden !important; scrollbar-gutter: auto; }' })
    await expect.poll(() => body.evaluate(el => el.offsetWidth - el.clientWidth)).toBe(0)
    await expect(todo).not.toHaveAttribute('data-collapsed')
    await page.addStyleTag({ content: '[data-slot="tool-pane-body"] { overflow-y: scroll !important; scrollbar-gutter: stable; }' })
    await expect.poll(() => body.evaluate(el => el.offsetWidth - el.clientWidth)).toBe(8)
    await expect(todo).toHaveAttribute('data-collapsed', 'true')
    await expect.poll(() => board.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
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

test.describe('board fit with the app scrollbar skin', () => {

  for (const theme of ['light', 'dark'] as const) {
    test(`scrollbar-dependent layouts settle at fold and compact thresholds in ${theme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme })
      await page.setViewportSize({ width: 984, height: 1000 })
      await page.goto('/preview.html?board-list&tall=todo')
      const pane = page.locator('[data-frame-id="board-list-page"]')
      await expect(pane.locator('[data-column="todo"] [data-slot="board-card"]')).toHaveCount(13)
      for (const width of Array.from({ length: 17 }, (_, index) => 984 + index)) {
        await page.setViewportSize({ width, height: 1000 })
        await expect.poll(() => pane.evaluate(el => el.getBoundingClientRect().width)).toBe(width)
        // Allow the resize commit, then sample the actual layout on successive
        // paints. No forced overflow: the column itself decides whether to scroll.
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
        expect(states[0]!.overflow, `${width}px`).toBeLessThanOrEqual(1)
      }
      await page.setViewportSize({ width: 990, height: 1000 })
      await expect(pane.locator('[data-column="todo"]')).toHaveAttribute('data-collapsed', 'true')
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

    test(`only columns that will fold offer Fold and retain focus in ${theme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme })
      await page.setViewportSize({ width: 900, height: 1000 })
      await page.goto('/preview.html?board-list')
      const todo = page.locator('[data-column="todo"]')
      const ready = page.locator('[data-column="ready"]')
      await todo.getByRole('button', { name: 'To do 1 — Open column', exact: true }).press('Enter')
      await expect(todo.getByRole('button', { name: 'Fold To do', exact: true })).toBeFocused()
      await todo.getByRole('button', { name: 'Fold To do', exact: true }).press('Enter')
      await expect(todo.getByRole('button', { name: 'To do 1 — Open column', exact: true })).toBeFocused()
      await todo.getByRole('button', { name: 'To do 1 — Open column', exact: true }).press('Enter')
      await ready.getByRole('button', { name: 'Ready 1 — Open column', exact: true }).press('Enter')
      await expect(todo.getByRole('button', { name: 'Fold To do', exact: true })).toHaveCount(0)
      await expect(ready.getByRole('button', { name: 'Fold Ready', exact: true })).toBeFocused()
      expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
      if (process.env.HD_BOARD_WIDTH_FRAMES) await page.locator('[data-frame-id="board-list-page"]').screenshot({ path: `${process.env.HD_BOARD_WIDTH_FRAMES}/two-opened-${theme}.png` })
      await ready.getByRole('button', { name: 'Fold Ready', exact: true }).press('Enter')
      await expect(ready.getByRole('button', { name: 'Ready 1 — Open column', exact: true })).toBeFocused()
      await todo.getByRole('button', { name: 'Fold To do', exact: true }).press('Enter')
      await expect(todo.getByRole('button', { name: 'To do 1 — Open column', exact: true })).toBeFocused()
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
      await expect(ready).toHaveAttribute('data-collapsed', 'true')
      await page.addStyleTag({ content: 'body { --hd-space-2: 0.5rem; --hd-space-3: 0.75rem; }' })
      // Trigger a measure after the foundation changes without changing the final width.
      await page.setViewportSize({ width: 1111, height: 1000 })
      await page.evaluate(async () => { for (let frame = 0; frame < 3; frame++) await new Promise(requestAnimationFrame) })
      await page.setViewportSize({ width: 1112, height: 1000 })
      await page.evaluate(async () => { for (let frame = 0; frame < 3; frame++) await new Promise(requestAnimationFrame) })
      await expect(ready).toHaveAttribute('data-collapsed', 'true')
      const box = await page.locator('[data-slot="board"]').evaluate(el => ({ gap: getComputedStyle(el).columnGap, overflow: el.scrollWidth - el.clientWidth }))
      expect(box.gap).toBe('12px')
      expect(box.overflow).toBeLessThanOrEqual(1)
    })
  }
})
