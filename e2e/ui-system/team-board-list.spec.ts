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
    await expect(pane.getByRole('button', { name: 'All jobs', exact: true })).toHaveAttribute('aria-pressed', 'true')
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
    await expect(actions).toBeVisible()
    await actions.press('Enter')
    await expect(page.getByRole('menuitem', { name: 'Put back in play', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await pane.locator('[data-slot=tool-pane-header]').click({ position: { x: 150, y: 22 } })
    expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
    if (process.env.HD_BOARD_LIST_FRAMES) {
      await pane.screenshot({ path: `${process.env.HD_BOARD_LIST_FRAMES}/list-${theme}.png` })
    }
    await pane.getByRole('button', { name: 'Needs you jobs', exact: true }).click()
    await expect(table.locator('tbody tr')).toHaveCount(1)
    await pane.getByRole('button', { name: 'All jobs', exact: true }).click()
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
