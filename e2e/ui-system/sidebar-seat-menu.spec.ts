import { expect, test } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'

const seatMenuBoard = (page: import('@playwright/test').Page) => page.locator('[data-catalog-case="seat-menu-width"]')

for (const theme of ['light', 'dark'] as const) test(`unavailable account keeps its readiness beside cached usage — ${theme}`, async ({ page }) => {
  await page.emulateMedia({ colorScheme: theme })
  await page.goto(`/preview.html?theme=${theme}`)
  const sidebar = page.locator('[data-frame-id="sidebar-column"]')
  await page.evaluate(() => {
    const { store } = (window as unknown as { __hdPreview: { store: {
      getSnapshot(): import('../../packages/ui/src/state/store').AppSnapshot
      patch(value: Partial<import('../../packages/ui/src/state/store').AppSnapshot>): void
    } } }).__hdPreview
    const snapshot = store.getSnapshot()
    store.patch({ healthByRuntime: { ...snapshot.healthByRuntime,
      [snapshot.activeRuntime!]: { state: 'unavailable', reason: 'crashed', message: 'exited' } } })
  })
  await sidebar.locator('button[class*="accountRow"]').click()
  const popup = page.locator('[data-popup-kind="wide-menu"][role="dialog"]')
  const current = popup.locator('[role="menuitem"][data-current]')
  await expect(current.locator('[data-menu-trailing]')).toHaveText('Unavailable')
  await expect(popup.getByText('Usage remaining', { exact: true })).toBeVisible()
  await expect(popup.locator('[data-menu-trailing]').filter({ hasText: /\d+%/ }).first()).toBeVisible()
})

test('seat menu keeps the design token width across sidebar widths and clamps to a narrow window', async ({ page }) => {
  await page.goto('/design.html?view=sidebar')
  const board = seatMenuBoard(page)
  await expect(board).toBeVisible()
  const trigger = board.locator('button[class*="accountRow"]')
  await expect(trigger).toBeVisible()

  for (const width of [200, 260, 320]) {
    await board.evaluate((node, value) => {
      ;(node as HTMLElement).style.width = `${value}px`
    }, width)
    await trigger.scrollIntoViewIfNeeded()
    await trigger.click()
    const popup = page.locator('[data-popup-kind="wide-menu"]')
    await expect(popup).toBeVisible()
    const foldedSeat = popup.locator('[role="menuitem"]:has([data-menu-account-name])[aria-expanded="false"]').first()
    if (await foldedSeat.count()) await foldedSeat.click()
    await expect(popup.locator('[data-menu-account-name]').getByText('legacy-account-with-a-long-label', { exact: true })).toBeVisible()
    const demoRows = popup.locator('[role="menuitem"]:has([data-menu-account-name])').filter({ hasText: 'shane' })
    await expect(demoRows.first().locator('[data-menu-account-name]')).toBeVisible()
    expect(await demoRows.first().evaluate((row) => row.querySelector('[data-menu-icon]')!.getBoundingClientRect().right <= row.querySelector('[data-menu-label]')!.getBoundingClientRect().left)).toBe(true)
    await expect(demoRows.first().locator('[data-menu-badge]')).toBeVisible()
    await expect(demoRows.first().locator('[data-menu-trailing]')).toBeVisible()
    const usageLabel = popup.getByText('Usage remaining', { exact: true })
    await expect(usageLabel).toBeVisible()
    expect(await usageLabel.evaluate((node) => {
      const text = node.firstChild
      if (!text) return 0
      const range = document.createRange()
      range.selectNodeContents(text)
      return range.getClientRects().length
    })).toBe(1)
    expect(await popup.evaluate((node) => [...node.querySelectorAll('*')].some((element) => {
      const style = getComputedStyle(element)
      return /[.!?](?:\s|$)/.test(element.textContent ?? '') && style.whiteSpace === 'nowrap' && style.textOverflow === 'ellipsis'
    }))).toBe(false)
    const longAccount = popup.locator('[role="menuitem"]:has([data-menu-account-name])').filter({ hasText: 'legacy-account-with-a-long-label' })
    const longName = longAccount.locator('[data-menu-account-name]')
    await expect(longName).toBeVisible()
    await expect(longAccount.locator('[data-menu-trailing]')).toBeVisible()
    expect(await longName.evaluate((node) => {
      const range = document.createRange()
      range.selectNodeContents(node)
      return range.getClientRects().length
    })).toBe(1)
    const measured = await popup.evaluate((node) => {
      const panel = node.getBoundingClientRect()
      const anchor = document.querySelector('[data-catalog-case="seat-menu-width"] button[class*="accountRow"]')!.getBoundingClientRect()
      return { width: panel.width, x: panel.x, anchorX: anchor.x }
    })
    // Phase A's approved wide-menu contract is FRAME.menu.max (340px).
    expect(measured.width).toBe(FRAME.menu.max)
    expect(measured.x).toBeCloseTo(measured.anchorX, 0)
    await page.keyboard.press('Escape')
    await expect(popup).toHaveCount(0)
    await expect(trigger).toBeFocused()
  }

  await page.setViewportSize({ width: 280, height: 900 })
  await trigger.scrollIntoViewIfNeeded()
  await trigger.click()
  const clamped = page.locator('[data-popup-kind="wide-menu"]')
  await expect(clamped).toBeVisible()
  await expect.poll(() => clamped.evaluate((node) => node.getBoundingClientRect().width)).toBeLessThanOrEqual(264)
  // Narrower is not enough: both edges stay inside the window, so the panel is
  // neither cut off on the left nor pushed past the right.
  await expect.poll(() => clamped.evaluate((node) => node.getBoundingClientRect().left)).toBeGreaterThanOrEqual(0)
  await expect.poll(() => clamped.evaluate((node) => window.innerWidth - node.getBoundingClientRect().right)).toBeGreaterThanOrEqual(0)
})

test('other real sidebar menus keep content width across sidebar widths', async ({ page }) => {
  await page.goto('/design.html?view=sidebar')
  const sidebar = page.locator('[data-catalog-case="sidebar-menu-widths"]')
  await expect(sidebar).toBeVisible()
  const widths = { start: null as number | null, project: null as number | null, session: null as number | null }

  for (const width of [200, 260, 320]) {
    await sidebar.evaluate((node, value) => {
      ;(node as HTMLElement).style.width = `${value}px`
    }, width)

    const start = sidebar.getByRole('button', { name: 'More ways to start' })
    await start.click()
    const startMenu = page.locator('[data-slot="popover-popup"] [role="menu"]')
    await expect(startMenu).toBeVisible()
    const startWidth = await startMenu.evaluate((node) => node.getBoundingClientRect().width)
    if (widths.start === null) widths.start = startWidth
    expect(startWidth).toBe(widths.start)
    await page.keyboard.press('Escape')
    await expect(startMenu).toHaveCount(0)
    await expect(start).toBeFocused()

    const project = sidebar.locator('[data-project-root] button[data-draggable]').first()
    await project.focus()
    await expect(project).toBeFocused()
    await project.click({ button: 'right' })
    const projectMenu = page.locator('[role="menu"]').last()
    await expect(projectMenu).toBeVisible()
    const projectWidth = await projectMenu.evaluate((node) => node.getBoundingClientRect().width)
    if (widths.project === null) widths.project = projectWidth
    expect(projectWidth).toBe(widths.project)
    await page.keyboard.press('Escape')
    await expect(projectMenu).toHaveCount(0)
    await expect(project).toBeFocused()

    const sessionRow = sidebar.locator('[data-region="session-row"]').first()
    const session = sessionRow.locator('[data-slot="sidebar-menu-button"]')
    await session.focus()
    await expect(session).toBeFocused()
    await sessionRow.click({ button: 'right' })
    const sessionMenu = page.locator('[role="menu"]').last()
    await expect(sessionMenu).toBeVisible()
    const sessionWidth = await sessionMenu.evaluate((node) => node.getBoundingClientRect().width)
    if (widths.session === null) widths.session = sessionWidth
    expect(sessionWidth).toBe(widths.session)
    await page.keyboard.press('Escape')
    await expect(sessionMenu).toHaveCount(0)
    await expect(session).toBeFocused()
  }
  console.info(`Content menu widths at sidebar 200/260/320: ${JSON.stringify(widths)}`)
})
