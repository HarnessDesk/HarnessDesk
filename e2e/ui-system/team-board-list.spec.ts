import { expect, test } from '@playwright/test'
import { COLLECT, textReasons } from '../../script/shots/audit.mjs'

for (const theme of ['light', 'dark'] as const) {
  test(`the Board and List share jobs and keep table geometry and controls in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/preview.html?board-list')
    const pane = page.locator('[data-frame-id="board-list-page"]')
    await pane.getByRole('radio', { name: 'List', exact: true }).click()
    const table = pane.getByRole('table', { name: 'Jobs' })
    await expect(table.locator('tbody tr')).toHaveCount(5)
    await expect(pane.getByRole('button', { name: 'All 5', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(table.locator('tbody tr').first()).toContainText('Choose the target')
    await page.evaluate(() => document.fonts.ready)
    const geometry = await pane.evaluate(root => {
      const table = root.querySelector('table')!
      const rect = table.getBoundingClientRect()
      const pane = root.getBoundingClientRect()
      return {
        titleEdge: root.querySelector('[data-slot=tool-pane-header] > div > span')!.getBoundingClientRect().left,
        jobEdge: root.querySelector('thead th')!.getBoundingClientRect().left + parseFloat(getComputedStyle(root.querySelector('thead th')!).paddingLeft),
        head: root.querySelector('thead')!.getBoundingClientRect().height,
        rows: [...root.querySelectorAll('tbody tr')].map(row => row.getBoundingClientRect().height),
        numeric: [...root.querySelectorAll('td[data-align="end"]')].map(cell => getComputedStyle(cell).textAlign),
        left: rect.left - pane.left, right: pane.right - rect.right,
      }
    })
    expect(Math.abs(geometry.titleEdge - geometry.jobEdge)).toBeLessThan(1)
    expect(geometry.head).toBe(40)
    for (const height of geometry.rows) expect(height).toBeGreaterThanOrEqual(56)
    expect(geometry.numeric.every(align => align === 'right')).toBe(true)
    expect(geometry.left).toBeGreaterThanOrEqual(24)
    expect(geometry.right).toBeGreaterThanOrEqual(24)
    await expect(table.getByRole('checkbox')).toHaveCount(0)
    const actions = table.locator('tbody tr').first().getByRole('button', { name: 'What to do with #2', exact: true })
    await actions.focus()
    const reveal = table.locator('tbody tr').first().locator('td:last-child > span > span')
    await page.mouse.move(0, 0)
    await pane.getByRole('searchbox').focus()
    await expect(reveal).toHaveCSS('opacity', '0')
    await actions.focus()
    await expect(reveal).toHaveCSS('opacity', '1')
    await actions.press('Enter')
    await expect(page.getByRole('menuitem', { name: 'Mark done', exact: true })).toBeVisible()
    await page.mouse.move(0, 0)
    await expect(reveal).toHaveCSS('opacity', '1')
    await page.keyboard.press('Escape')
    await expect(actions).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByRole('menu')).toHaveCount(0)
    await pane.getByRole('searchbox').click()
    await expect(reveal).toHaveCSS('opacity', '0')
    await table.locator('tbody tr').first().hover({ position: { x: 10, y: 10 } })
    await expect(reveal).toHaveCSS('opacity', '1')
    await pane.locator('[data-slot=tool-pane-header]').click({ position: { x: 150, y: 22 } })
    expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
    if (process.env.HD_BOARD_LIST_FRAMES) {
      await pane.screenshot({ path: `${process.env.HD_BOARD_LIST_FRAMES}/list-${theme}.png` })
    }
    await pane.getByRole('button', { name: 'Needs you 1', exact: true }).click()
    await expect(table.locator('tbody tr')).toHaveCount(1)
    await pane.getByRole('button', { name: 'All 5', exact: true }).click()
    await pane.getByRole('searchbox', { name: 'Filter jobs', exact: true }).fill('Retry the checkout')
    await expect(table.locator('tbody tr')).toHaveCount(1)
    await pane.getByRole('searchbox', { name: 'Filter jobs', exact: true }).fill('no matching job')
    await expect(pane.getByText('No jobs match', { exact: true })).toBeVisible()
    await pane.getByRole('searchbox', { name: 'Filter jobs', exact: true }).fill('')
    await pane.getByRole('button', { name: 'View: columns and sort', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Most recent', exact: true }).click()
    await expect(table.locator('tbody tr').first()).toContainText('Land the reviewed commit')
    await pane.getByRole('button', { name: 'View: columns and sort', exact: true }).click()
    await page.getByRole('switch', { name: 'Changes', exact: true }).click()
    await expect(table.getByRole('columnheader', { name: 'Changes', exact: true })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await pane.getByRole('radio', { name: 'Board', exact: true }).click()
    await expect(pane.locator('[data-slot="board-card"]')).toHaveCount(5)
    if (process.env.HD_BOARD_LIST_FRAMES) {
      await pane.screenshot({ path: `${process.env.HD_BOARD_LIST_FRAMES}/board-${theme}.png` })
      await page.goto('/preview.html')
      const observed = page.locator('[data-frame-id="board-observed"]')
      await observed.evaluate(el => { const width = el.getBoundingClientRect().width; document.body.replaceChildren(el); (el as HTMLElement).style.width = `${width}px` })
      expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
      await observed.screenshot({ path: `${process.env.HD_BOARD_LIST_FRAMES}/after-${theme}.png` })
    }
  })
}

for (const theme of ['light', 'dark'] as const) {
  for (const width of [900, 1440, 560]) {
    test(`list repair: actions and long copy fit a ${width}px pane in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.goto('/preview.html?board-list')
      const pane = page.locator('[data-frame-id="board-list-page"]')
      await pane.getByRole('radio', { name: 'List', exact: true }).click()
      await page.evaluate(() => document.fonts.ready)
      const frame = pane.locator('[data-slot="table-container"]')
      const bounds = await frame.boundingBox()
      for (const cell of await pane.locator('tbody tr td:last-child').all()) {
        const box = await cell.boundingBox()
        expect(box!.x + box!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width + 1)
      }
      expect(await frame.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
      const title = pane.locator('[data-job="4"] td').first().locator('[title]').first()
      await expect(title).toHaveAttribute('title', /resumeAfterCompaction/)
      const note = pane.locator('[data-job="4"] td').first().locator('[title]').last()
      await expect(note).toHaveCSS('-webkit-line-clamp', '2')
      const noteHeight = await note.evaluate(el => ({ height: el.getBoundingClientRect().height, line: parseFloat(getComputedStyle(el).lineHeight) }))
      expect(noteHeight.height).toBeLessThanOrEqual(noteHeight.line * 2 + 1)
      await expect(pane.locator('[data-job="2"]')).toContainText('stopped')
      expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
      if (process.env.HD_BOARD_LIST_FRAMES && width !== 560) await pane.screenshot({ path: `${process.env.HD_BOARD_LIST_FRAMES}/list-${width}-${theme}.png` })
    })
  }
  for (const evidence of ['pending', 'failed']) {
    test(`list repair: ${evidence} evidence keeps the reading gutter in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: 900, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.goto(`/preview.html?board-list&evidence=${evidence}`)
      const pane = page.locator('[data-frame-id="board-list-page"]')
      await pane.getByRole('radio', { name: 'List', exact: true }).click()
      const banner = pane.getByRole(evidence === 'failed' ? 'alert' : 'status')
      await expect(banner).toBeVisible()
      const left = (await banner.boundingBox())!.x
      const filterLeft = (await pane.getByRole('searchbox').boundingBox())!.x
      expect(Math.abs(left - filterLeft)).toBeLessThan(1)
    })
  }
}
