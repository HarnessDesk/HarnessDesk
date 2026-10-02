import { expect, test } from '@playwright/test'

const seatMenuBoard = (page: import('@playwright/test').Page) => page.locator('[data-catalog-case="seat-menu-width"]')

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
    const popup = page.locator('[data-slot="popover-popup"][data-width="wide"]')
    await expect(popup).toBeVisible()
    const foldedSeat = popup.locator('[role="menuitem"][data-layout="account"][aria-expanded="false"]').first()
    if (await foldedSeat.count()) await foldedSeat.click()
    await expect(popup.getByText('legacy-cursor', { exact: false })).toBeVisible()
    const demoRows = popup.locator('[role="menuitem"][data-layout="account"]').filter({ hasText: 'shane' })
    await expect(demoRows.first().locator('[class*="accountName"]')).toBeVisible()
    expect(await demoRows.first().locator('[class*="accountText"]').evaluate((node) => Boolean(node.previousElementSibling))).toBe(true)
    await expect(demoRows.first().locator('[class*="accountTag"]')).toBeVisible()
    await expect(demoRows.first().locator('[class*="accountFigure"]')).toBeVisible()
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
    const longAccount = popup.locator('[role="menuitem"][data-layout="account"]').filter({ hasText: 'legacy-cursor' })
    const longName = longAccount.locator('[class*="accountName"]')
    await expect(longName).toBeVisible()
    await expect(longAccount.locator('[class*="accountFigure"]')).toBeVisible()
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
    expect(measured.width).toBe(320)
    expect(measured.x).toBeCloseTo(measured.anchorX, 0)
    await page.keyboard.press('Escape')
  }

  await page.setViewportSize({ width: 280, height: 900 })
  await trigger.scrollIntoViewIfNeeded()
  await trigger.click()
  const clamped = page.locator('[data-slot="popover-popup"][data-width="wide"]')
  await expect(clamped).toBeVisible()
  await expect.poll(() => clamped.evaluate((node) => node.getBoundingClientRect().width)).toBeLessThanOrEqual(264)
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

    await sidebar.getByRole('button', { name: 'More ways to start' }).click()
    const startMenu = page.locator('[data-slot="popover-popup"] [role="menu"]')
    await expect(startMenu).toBeVisible()
    const startWidth = await startMenu.evaluate((node) => node.getBoundingClientRect().width)
    if (widths.start === null) widths.start = startWidth
    expect(startWidth).toBe(widths.start)
    await page.keyboard.press('Escape')

    await sidebar.locator('button[aria-label^="Actions for "]').first().evaluate((node) => (node as HTMLButtonElement).click())
    const projectMenu = page.locator('[role="menu"]').last()
    await expect(projectMenu).toBeVisible()
    const projectWidth = await projectMenu.evaluate((node) => node.getBoundingClientRect().width)
    if (widths.project === null) widths.project = projectWidth
    expect(projectWidth).toBe(widths.project)
    await page.keyboard.press('Escape')

    await sidebar.locator('[data-region="session-row"]').first().click({ button: 'right' })
    const sessionMenu = page.locator('[role="menu"]').last()
    await expect(sessionMenu).toBeVisible()
    const sessionWidth = await sessionMenu.evaluate((node) => node.getBoundingClientRect().width)
    if (widths.session === null) widths.session = sessionWidth
    expect(sessionWidth).toBe(widths.session)
    await page.keyboard.press('Escape')
  }
  console.info(`Content menu widths at sidebar 200/260/320: ${JSON.stringify(widths)}`)
})
