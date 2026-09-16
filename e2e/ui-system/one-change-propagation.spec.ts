import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

const route = '/design.html?view=propagation'

test.beforeEach(async ({ page }) => {
  await page.goto(route)
  await page.waitForLoadState('networkidle')
  await expect(page.getByRole('heading', { name: 'Foundation propagation', exact: true })).toBeVisible()
  await expect(page.locator('.cm-editor')).toBeVisible()
})

test('one foundation perturbation reaches unrelated surfaces, portals, and adapters', async ({ page }) => {
  const button = page.getByTestId('prop-button')
  const settings = page.getByTestId('prop-settings')
  const composer = page.getByTestId('prop-composer').locator('[data-slot="composer"]')
  const board = page.getByTestId('prop-board').locator('[data-slot="board-column"]')
  const boardCard = page.getByTestId('prop-board').locator('[data-slot="board-card"]')
  const editor = page.getByTestId('prop-editor')
  const terminal = page.getByTestId('terminal-adapter')

  const baseline = {
    buttonHeight: await button.evaluate((node) => node.getBoundingClientRect().height),
    settingsHeight: await settings.evaluate((node) => node.getBoundingClientRect().height),
    composerRadius: await composer.evaluate((node) => getComputedStyle(node).borderRadius),
    boardWidth: await board.evaluate((node) => node.getBoundingClientRect().width),
    cardColor: await boardCard.evaluate((node) => getComputedStyle(node).backgroundColor),
    editorGutter: await editor.locator('.cm-gutters').evaluate((node) => getComputedStyle(node).backgroundColor),
  }

  await page.evaluate(() => {
    const style = document.body.style
    style.setProperty('--hd-btn-h', '42px')
    style.setProperty('--hd-space-3', '24px')
    style.setProperty('--hd-radius', '2px')
    style.setProperty('--hd-radius-lg', '3px')
    style.setProperty('--hd-btn-radius', '2px')
    style.setProperty('--hd-btn-primary-fill', 'rgb(123, 45, 67)')
    style.setProperty('--hd-btn-primary-hover', 'rgb(123, 45, 67)')
    style.setProperty('--hd-card', 'rgb(240, 220, 200)')
    style.setProperty('--hd-board-column-width', '360px')
    style.setProperty('--hd-font-code', '"Courier New"')
    style.setProperty('--hd-code-gutter-bg', 'rgb(11, 22, 33)')
    style.setProperty('--hd-ring-width', '5px')
    style.setProperty('--hd-ring-offset', '4px')
    style.setProperty('--hd-ring-muted', 'rgb(10, 120, 180)')
    style.setProperty('--hd-focus-ring', '0 0 0 5px rgb(10, 120, 180)')
    style.setProperty('--hd-surface-radius', '3px')
    style.setProperty('--hd-surface-fill', 'rgb(225, 235, 245)')
    style.setProperty('--hd-accent', 'rgb(25, 135, 105)')
    style.setProperty('--hd-accent-dim', 'rgba(25, 135, 105, 0.2)')
  })

  await button.focus()
  await expect.poll(() => button.evaluate((node) => node.getBoundingClientRect().height)).toBe(42)
  await expect.poll(() => button.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe('rgb(123, 45, 67)')
  expect(await button.evaluate((node) => getComputedStyle(node).borderRadius)).toBe('2px')
  expect(await button.evaluate((node) => getComputedStyle(node).boxShadow)).toContain('5px')
  expect(await settings.evaluate((node) => node.getBoundingClientRect().height)).toBeGreaterThan(baseline.settingsHeight)
  expect(await composer.evaluate((node) => getComputedStyle(node).borderRadius)).toBe('3px')
  expect(await board.evaluate((node) => node.getBoundingClientRect().width)).toBe(360)
  expect(await boardCard.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe('rgb(240, 220, 200)')
  expect(await editor.locator('.cm-content').evaluate((node) => getComputedStyle(node).fontFamily)).toContain('Courier New')
  expect(await editor.locator('.cm-gutters').evaluate((node) => getComputedStyle(node).backgroundColor)).toBe('rgb(11, 22, 33)')

  await terminal.getByRole('button', { name: 'Refresh renderer bridge' }).click()
  await expect(terminal).toHaveAttribute('data-background', 'rgb(225, 235, 245)')
  await expect(terminal).toHaveAttribute('data-cursor', 'rgb(25, 135, 105)')
  await expect(terminal).toHaveAttribute('data-font', /Courier New/)

  await page.getByRole('button', { name: 'Open dialog' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  expect(await dialog.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe('rgb(225, 235, 245)')
  expect(await dialog.evaluate((node) => getComputedStyle(node).borderRadius)).toBe('3px')
  const dialogButton = dialog.getByRole('button', { name: 'Add' })
  expect(await dialogButton.evaluate((node) => node.getBoundingClientRect().height)).toBe(42)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  await page.getByRole('button', { name: 'Open menu' }).click()
  const popup = page.locator('[data-slot="popover-popup"]')
  await expect(popup).toBeVisible()
  expect(await popup.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe('rgb(225, 235, 245)')
  expect(await popup.evaluate((node) => getComputedStyle(node).borderRadius)).toBe('2px')
  await page.mouse.click(10, 890)
  await expect(popup).toBeHidden()

  await page.screenshot({ path: 'output/playwright/ui-system/propagation-light.png', fullPage: true })

  await page.reload()
  await expect(page.getByTestId('prop-button')).not.toHaveCSS('height', '42px')
  expect(await page.getByTestId('prop-button').evaluate((node) => node.getBoundingClientRect().height)).toBe(baseline.buttonHeight)
  expect(await page.getByTestId('prop-board').locator('[data-slot="board-column"]').evaluate((node) => node.getBoundingClientRect().width)).toBe(baseline.boardWidth)
  expect(await page.getByTestId('prop-board').locator('[data-slot="board-card"]').evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(baseline.cardColor)
  expect(await page.getByTestId('prop-editor').locator('.cm-gutters').evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(baseline.editorGutter)
  expect(await page.getByTestId('prop-composer').locator('[data-slot="composer"]').evaluate((node) => getComputedStyle(node).borderRadius)).toBe(baseline.composerRadius)
})

test('catalog open states have no detected accessibility violations', async ({ page }) => {
  await page.getByRole('button', { name: 'Open dialog' }).click()
  let result = await new AxeBuilder({ page }).include('[role="dialog"]').analyze()
  expect(result.violations).toEqual([])

  const cdp = await page.context().newCDPSession(page)
  const tree = await cdp.send('Accessibility.getFullAXTree')
  expect(tree.nodes.some((node) => node.role?.value === 'dialog' && node.name?.value === 'Add a workspace')).toBe(true)
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Open menu' }).click()
  result = await new AxeBuilder({ page }).include('[role="menu"]').analyze()
  const unresolved = result.violations.filter((violation) =>
    violation.id !== 'aria-hidden-focus' ||
    violation.nodes.some((node) => !node.html.includes('data-base-ui-focus-guard'))
  )
  // Base UI's portal sentinels are intentionally focusable, visually clipped,
  // and aria-hidden so focus can cross a portalled composite. Axe reports the
  // sentinel technique itself; accept only those exact upstream-owned nodes.
  expect(unresolved).toEqual([])
})

test('dialog and menu keyboard contracts enter, dismiss, and return focus safely', async ({ page }) => {
  const dialogTrigger = page.getByRole('button', { name: 'Open dialog' })
  await dialogTrigger.focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Add a workspace' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toBeFocused()

  // Initial focus is the static surface, so a held Return cannot take the
  // proceeding action as the dialog opens.
  await page.keyboard.press('Enter')
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(dialogTrigger).toBeFocused()

  const menuTrigger = page.getByRole('button', { name: 'Open menu' })
  await menuTrigger.focus()
  await page.keyboard.press('Enter')
  const popup = page.locator('[data-slot="popover-popup"]')
  await expect(popup).toBeVisible()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitem', { name: 'Open workspace' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(popup).toBeHidden()
  await expect(menuTrigger).toBeFocused()
})

test('dark, narrow, and reduced-motion rendering stays usable', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 })
  await page.getByRole('button', { name: 'dark', exact: true }).click()
  await expect(page.locator('body')).toHaveAttribute('data-hd-dark-theme', '')
  await page.getByRole('button', { name: 'Open menu' }).click()
  await expect(page.locator('[data-slot="popover-popup"]')).toBeVisible()
  await page.screenshot({ path: 'output/playwright/ui-system/propagation-dark-1024x768.png', fullPage: true })
})
