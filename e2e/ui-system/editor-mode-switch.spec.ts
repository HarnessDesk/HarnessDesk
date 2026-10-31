import { expect, test } from '@playwright/test'
import { openFrame, resolvedPx } from './frame-contract-helpers'
import { applyLeftColumnActions } from './left-column-actions'

// Keep automatic recordings off; explicit geometry captures remain below.
test.use({ screenshot: 'off', trace: 'off', video: 'off' })

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
    for (const name of ['Back', 'Forward']) {
      const history = top.getByRole('button', { name, exact: true })
      if (width === 720) await expect(history).toBeVisible()
      else await expect(history).toBeHidden()
    }
    const boxes = await top.evaluate(node => {
      const track = node.querySelector<HTMLElement>('[data-mode-switch]')!, box = node.getBoundingClientRect()
      return { right: box.right, cells: [...track.querySelectorAll('button')].map(button => {
        const cell = button.getBoundingClientRect()
        return { width: cell.width, height: cell.height, right: cell.right }
      }) }
    })
    const cell = { width: await resolvedPx(page, '--hd-mode-switch-cell-w'), height: await resolvedPx(page, '--hd-mode-switch-cell-h') }
    expect(boxes.cells.map(({ width, height }) => ({ width, height }))).toEqual([cell, cell])
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
    for (const label of ['Teams', 'Agents', 'Customize', 'Customize · Plugins', 'Dashboard']) {
      await page.keyboard.press('Meta+k')
      const palette = page.getByRole('dialog', { name: 'Command palette' })
      const action = label === 'Teams' ? 'Show Teams' : label
      await palette.locator('input').fill(action)
      await palette.getByRole('option').filter({ has: page.getByText(action, { exact: true }) }).click()
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

for (const theme of ['light', 'dark'] as const) for (const windowWidth of [1440, 720]) {
  test(`native corner reserves distinct history and mode targets at ${windowWidth} in ${theme}`, async ({ page }, testInfo) => {
    await openFrame(page, 'frame-wall=conversation', theme, windowWidth)
    await applyLeftColumnActions(page, { leftOpen: true })
    const column = page.locator('[data-left-column]:visible'), top = column.locator('[data-left-top]')
    const editor = top.getByRole('button', { name: 'Editor mode', exact: true })
    await editor.click()
    // A real visit and return enable Forward, so a stolen pointer has an observable consequence.
    await column.locator('[data-left-seat]').getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(page.locator('[data-page-destination="settings"]:visible')).toHaveCount(1)
    await page.keyboard.press('Meta+[')
    await expect(page.locator('[data-page-destination="settings"]:visible')).toHaveCount(0)
    for (const width of [239, 240, 256, 267, 268, 280]) {
      await applyLeftColumnActions(page, { leftOpen: true, leftWidth: width })
      await expect.poll(async () => (await top.boundingBox())?.width).toBe(width)
      await top.evaluate(node => { (node as HTMLElement).style.setProperty('--titlebar-inset', 'var(--hd-titlebar-lights)') })
      const targets = await top.evaluate(node => [...node.querySelectorAll('button')]
        .filter(button => button.getBoundingClientRect().width > 0).map(button => {
          const box = button.getBoundingClientRect()
          return { label: button.getAttribute('aria-label'), disabled: button.disabled, x: box.x, right: box.right, y: box.y, bottom: box.bottom,
            centerHit: document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('button')?.getAttribute('aria-label') }
        }))
      const overlaps = targets.flatMap((target, index) => targets.slice(index + 1)
        .filter(other => target.x < other.right && other.x < target.right && target.y < other.bottom && other.y < target.bottom)
        .map(other => [target.label, other.label]))
      expect.soft(overlaps, `overlaps at ${width}px`).toEqual([])
      for (const target of targets.filter(target => !target.disabled)) expect.soft(target.centerHit, `${target.label} owns its centre at ${width}px`).toBe(target.label)
      const forward = top.getByRole('button', { name: 'Forward', exact: true })
      const historyVisible = windowWidth === 720 || width >= 256
      expect.soft(await forward.isVisible(), `history remains reachable at ${width}px`).toBe(historyVisible)
      if (historyVisible) {
        await expect(forward).toBeEnabled()
        const box = (await forward.boundingBox())!
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
        await expect(page.locator('[data-page-destination="settings"]:visible')).toHaveCount(1)
        await expect(page.locator('[data-left-top]:visible [data-mode-switch]')).toHaveCount(0)
        await page.keyboard.press('Meta+[')
        await expect(page.locator('[data-page-destination="settings"]:visible')).toHaveCount(0)
        await applyLeftColumnActions(page, { leftOpen: true, leftWidth: width })
        await expect(editor).toHaveAttribute('aria-pressed', 'true')
      }
      // Exercise the mode cells by coordinate too, not a locator's automatic obstruction handling.
      const conversation = top.getByRole('button', { name: 'Conversation mode', exact: true })
      const conversationBox = (await conversation.boundingBox())!
      await page.mouse.click(conversationBox.x + conversationBox.width / 2, conversationBox.y + conversationBox.height / 2)
      await expect(conversation).toHaveAttribute('aria-pressed', 'true')
      const editorBox = (await editor.boundingBox())!
      await page.mouse.click(editorBox.x + editorBox.width / 2, editorBox.y + editorBox.height / 2)
      await expect(editor).toHaveAttribute('aria-pressed', 'true')
      await expect(top.getByRole('button', { name: 'Hide sidebar', exact: true })).toBeVisible()
      await expect(top.getByRole('button', { name: 'Search everything', exact: true })).toBeVisible()
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      if (width === 240 || width === 256) await page.screenshot({ path: testInfo.outputPath(`native-${theme}-${windowWidth}-${width}.png`) })
    }
  })
}
