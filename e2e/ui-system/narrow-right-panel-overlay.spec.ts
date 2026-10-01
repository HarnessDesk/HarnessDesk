import { expect, test } from '@playwright/test'

test('a narrow right-panel overlay hides the covered conversation and returns focus', async ({ page }) => {
  await page.goto('/narrow-overlay.html')
  const main = page.locator('[data-slot="workbench-main"]')
  const tab = page.getByRole('tab', { name: /Trajectory/ })
  const meters = page.getByRole('group', { name: 'Plan usage' })
  await expect(tab).toBeVisible()
  await expect(meters).toContainText(/out/i)

  for (const width of [510, 710]) {
    await page.setViewportSize({ width, height: 900 })
    await expect(main).toHaveAttribute('data-right-panel-overlay', '')
    await expect(main).toHaveAttribute('inert', '')
    await expect.poll(() => main.evaluate((node) => getComputedStyle(node).visibility)).toBe('hidden')
    const tabIsClear = await tab.evaluate((node) => {
      const rect = node.getBoundingClientRect()
      const hits = document.elementsFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      return hits.every((hit) => !hit.closest('[aria-label="Plan usage"]'))
    })
    expect(tabIsClear, `conversation meter should not hit-test beneath the tab at ${width}px`).toBe(true)

    await tab.focus()
    for (let step = 0; step < 16; step += 1) {
      await page.keyboard.press('Tab')
      expect(await main.evaluate((node) => node.contains(document.activeElement))).toBe(false)
    }
  }

  await page.setViewportSize({ width: 720, height: 900 })
  await expect(main).not.toHaveAttribute('data-right-panel-overlay', '')
  await expect(main).not.toHaveAttribute('inert', '')
  await expect.poll(() => main.evaluate((node) => getComputedStyle(node).visibility)).toBe('visible')

  const composer = page.locator('textarea').first()
  await composer.focus()
  await expect(composer).toBeFocused()
  await page.setViewportSize({ width: 710, height: 900 })
  await expect(main).toHaveAttribute('inert', '')
  const panelInput = page.getByPlaceholder('Filter steps')
  await panelInput.focus()
  const dockedFocus = await page.evaluate(() => {
    const store = (window as Window & {
      __narrowOverlayStore: { getSnapshot: () => { workbench: { focus: string | null } } }
    }).__narrowOverlayStore
    return store.getSnapshot().workbench.focus
  })
  expect(dockedFocus).not.toBeNull()
  await page.getByRole('button', { name: 'Hide this panel' }).click()
  await expect(main).not.toHaveAttribute('inert', '')
  await expect(composer).toBeFocused()
  const logicalFocus = await page.evaluate(() => {
    const store = (window as Window & {
      __narrowOverlayStore: { getSnapshot: () => { workbench: { focus: string | null; main: { focused: string } } } }
    }).__narrowOverlayStore
    const snapshot = store.getSnapshot()
    return { dock: snapshot.workbench.focus, main: snapshot.workbench.main.focused }
  })
  expect(logicalFocus).toEqual({ dock: null, main: await composer.evaluate((node) => node.closest<HTMLElement>('[data-pane-id]')?.dataset.paneId) })
})
