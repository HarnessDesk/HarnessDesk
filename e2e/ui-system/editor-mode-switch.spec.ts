import { expect, test } from '@playwright/test'
import { openFrame } from './frame-contract-helpers'
import { applyLeftColumnActions } from './left-column-actions'

for (const theme of ['light', 'dark'] as const) {
  for (const width of [1440, 720]) test(`mode switch survives a narrow column at ${width} in ${theme}`, async ({ page }, testInfo) => {
    await openFrame(page, 'frame-wall=conversation', theme, width)
    await applyLeftColumnActions(page, { leftOpen: true, leftWidth: 200 })
    const column = page.locator('[data-left-column]:visible'), top = column.locator('[data-left-top]')
    const conversation = top.getByRole('button', { name: 'Conversation mode', exact: true })
    const editor = top.getByRole('button', { name: 'Editor mode', exact: true })
    await top.evaluate(node => { (node as HTMLElement).style.setProperty('--titlebar-inset', 'var(--hd-titlebar-lights)') })
    await expect(conversation).toHaveAttribute('aria-pressed', 'true')
    await expect(editor).toBeVisible()
    await expect(top.getByRole('button', { name: 'Back', exact: true })).toBeHidden()
    await expect(top.getByRole('button', { name: 'Forward', exact: true })).toBeHidden()
    const boxes = await top.evaluate(node => {
      const track = node.querySelector<HTMLElement>('[data-mode-switch]')!, box = node.getBoundingClientRect()
      return { right: box.right, cells: [...track.querySelectorAll('button')].map(button => {
        const cell = button.getBoundingClientRect()
        return { width: cell.width, height: cell.height, right: cell.right }
      }) }
    })
    expect(boxes.cells.map(({ width, height }) => ({ width, height }))).toEqual([{ width: 26, height: 22 }, { width: 26, height: 22 }])
    expect(boxes.cells.at(-1)!.right).toBeLessThan(boxes.right)
    await editor.click()
    await expect(editor).toHaveAttribute('aria-pressed', 'true')
    const selection = await editor.evaluate(node => ({ fill: getComputedStyle(node).backgroundColor, shadow: getComputedStyle(node).boxShadow }))
    expect(selection.shadow).not.toBe('none')
    await page.screenshot({ path: testInfo.outputPath(`switch-${theme}-${width}.png`) })
    // Focus can stay in a text field; the app still owns this mode command.
    const composer = page.locator('[data-slot="composer-text"]:visible').first()
    await composer.focus()
    await page.keyboard.press('Meta+g')
    await expect(conversation).toHaveAttribute('aria-pressed', 'true')
  })

  test(`mode switch is greyed on page doors and omitted in Settings in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation', theme)
    const top = page.locator('[data-left-column]:visible [data-left-top]')
    await top.getByRole('button', { name: 'Editor mode', exact: true }).click()
    for (const label of ['Teams', 'Agents', 'Library', 'Plugins', 'Dashboard']) {
      await page.getByRole('navigation', { name: 'Workspace actions' }).getByRole('button', { name: label, exact: true }).click()
      const editor = top.getByRole('button', { name: 'Editor mode', exact: true })
      await expect(editor).toBeDisabled()
      await expect(editor).toHaveAttribute('title', "Editor mode opens a conversation's files")
      await expect(top.getByRole('button', { name: 'Conversation mode', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await page.keyboard.press('Meta+g')
      await page.keyboard.press('Meta+[')
      await expect(editor).toHaveAttribute('aria-pressed', 'true')
    }
    await page.locator('[data-left-seat]').getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(top.locator('[data-mode-switch]')).toHaveCount(0)
  })
}
