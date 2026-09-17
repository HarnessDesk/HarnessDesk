import { expect, test } from '@playwright/test'

test('real sidebar footer fills its column and its menu is painted and clickable', async ({ page }) => {
  await page.goto('/preview.html')
  const trigger = page.locator('button[class*="accountRow"]')
  await trigger.scrollIntoViewIfNeeded()
  // Exercise a wide sidebar as well as its usual width: a shrink-to-label
  // wrapper can look almost right at the minimum width and fail on resize.
  for (const width of [260, 480]) {
    await trigger.evaluate((node, width) => {
      const sidebar = node.closest('[class*="sidebar_"]')
      if (!sidebar?.parentElement) throw new Error('sidebar frame missing')
      sidebar.parentElement.style.width = `${width}px`
    }, width)
    const gap = await trigger.evaluate(node => {
      const footer = node.parentElement!.parentElement!
      const box = footer.getBoundingClientRect(), row = node.getBoundingClientRect()
      return { left: row.left - box.left, right: box.right - row.right }
    })
    expect(gap.right).toBeCloseTo(gap.left, 0)
    expect(gap.right).toBeLessThanOrEqual(4)
  }
  await trigger.click()
  const popup = page.locator('[data-slot="popover-popup"]')
  const settings = popup.getByRole('menuitem', { name: /^Settings/ })
  await expect(settings).toBeVisible()
  const bounds = await settings.evaluate(node => {
    const rect = node.getBoundingClientRect()
    const box = node.closest('[data-slot="popover-popup"]')!.getBoundingClientRect()
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2
    return { contained: y >= box.top && y <= box.bottom, hit: node.contains(document.elementFromPoint(x, y)) }
  })
  expect(bounds).toEqual({ contained: true, hit: true })
  // Real pointer dispatch, not element.click(): clipped menus must not pass.
  await settings.click()
  await expect(popup).toHaveCount(0)
  await trigger.click()
  await page.keyboard.press('ArrowDown')
  await expect(popup.getByRole('menuitem').first()).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(popup).toHaveCount(0)
  await expect(trigger).toBeFocused()
})

for (const height of [900, 520]) {
  test(`open sidebar menu repositions after theme changes and account expansion at ${height}px`, async ({ page }, testInfo) => {
    // Add synthetic accounts at the fixture boundary. The real Sidebar,
    // disclosure, scrolling menu and canonical Popover remain unchanged.
    await page.route('**/src/preview/sidebar-fixture.ts*', async route => {
      const response = await route.fetch()
      await route.fulfill({
        response,
        body: `${await response.text()}\n{
          const status = previewAccounts[Object.keys(previewAccounts)[1]];
          status.accounts.push(...Array.from({ length: 16 }, (_, index) => ({
            kind: 'oauth', label: 'Account ' + (index + 1), email: 'account' + (index + 1) + '@example.com'
          })));
        }`,
      })
    })
    await page.setViewportSize({ width: 1440, height })
    await page.goto('/preview.html')
    const trigger = page.locator('button[class*="accountRow"]')
    await expect(trigger).toBeAttached()
    // Put this existing preview frame at the viewport's bottom edge, just
    // like the production sidebar; do not alter the menu or its positioning.
    await trigger.evaluate(node => {
      const frame = node.closest('[class*="sidebar_"]')?.parentElement
      if (!frame) throw new Error('sidebar frame missing')
      Object.assign(frame.style, { position: 'fixed', top: '8px', left: '8px', width: '240px', height: 'calc(100vh - 8px)' })
    })
    const theme = page.getByRole('combobox', { name: 'theme', exact: true })
    await theme.selectOption('light')
    await trigger.click()
    const popup = page.locator('[data-slot="popover-popup"]')
    await expect(popup).toBeVisible()
    const compact = await popup.boundingBox()
    expect(compact).not.toBeNull()
    await theme.selectOption('dark')
    await expect(popup).toBeVisible()
    await theme.selectOption('light')
    await popup.locator('[role="menuitem"][data-current][aria-expanded="false"]').click()
    await expect(popup.locator('[role="menuitem"][data-current]')).toHaveAttribute('aria-expanded', 'true')
    await expect.poll(async () => popup.evaluate(node => {
      const box = node.getBoundingClientRect()
      return box.top >= 0 && box.bottom <= window.innerHeight
    })).toBe(true)
    const expanded = await popup.evaluate(node => {
      const box = node.getBoundingClientRect()
      return { top: box.top, bottom: box.bottom, height: box.height, clientHeight: node.clientHeight, scrollHeight: node.scrollHeight }
    })
    await testInfo.attach('dynamic-menu-layout', { body: JSON.stringify({ compact, expanded }, null, 2), contentType: 'application/json' })
    expect(expanded.height).toBeGreaterThan(compact!.height + 100)
    expect(expanded.top).toBeLessThan(compact!.y)
    expect(expanded.scrollHeight).toBeGreaterThan(expanded.clientHeight)
    const settings = popup.getByRole('menuitem', { name: /^Settings/ })
    await settings.scrollIntoViewIfNeeded()
    expect(await settings.evaluate(node => {
      const box = node.getBoundingClientRect()
      return node.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2))
    })).toBe(true)
    await settings.click()
    await expect(popup).toHaveCount(0)
  })
}

test('settings rows contain their labels, descriptions and marks', async ({ page }) => {
  await page.goto('/design.html?view=row')
  const row = page.getByRole('button', { name: 'Worktrees Two checkouts on this machine' })
  await expect(row).toBeVisible()
  const bounds = await row.evaluate(node => {
    const box = node.getBoundingClientRect()
    return [...node.querySelectorAll('span, svg')].filter(child => child.textContent?.trim() || child.tagName === 'svg')
      .map(child => { const rect = child.getBoundingClientRect(); return { top: rect.top - box.top, bottom: box.bottom - rect.bottom } })
  })
  for (const bound of bounds) {
    expect(bound.top).toBeGreaterThanOrEqual(0)
    expect(bound.bottom).toBeGreaterThanOrEqual(0)
  }
})

test('canonical controls retain selected, drop, icon and deferred-send states', async ({ page }) => {
  await page.goto('/design.html?view=propagation')
  const states = page.getByTestId('state-contracts')
  await expect(states).toBeVisible()
  await states.evaluate(node => node.style.setProperty('--hd-nav-weight-selected', '600'))
  await expect.soft(states.getByRole('button', { name: 'Selected page' })).toHaveCSS('font-weight', '600')
  await expect.soft(states.getByRole('button', { name: 'Drop target' })).not.toHaveCSS('box-shadow', 'none')
  expect.soft(await states.getByRole('textbox', { name: 'Icon input' }).evaluate(node => parseFloat(getComputedStyle(node).paddingLeft))).toBeGreaterThanOrEqual(24)
  await expect(states.getByRole('button', { name: 'Avatar mark' }).locator('svg')).toHaveCSS('width', '32px')
  await expect.soft(states.getByRole('button', { name: 'Avatar mark' })).toHaveCSS('box-shadow', 'none')
  await expect(states.getByRole('button', { name: 'Current branch' })).toHaveCSS('font-weight', '600')
  await expect.soft(states.getByRole('button', { name: 'Background tasks' })).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect.soft(states.getByRole('button', { name: 'Transcript step' })).toHaveCSS('padding-left', '2px')
  await expect.soft(states.getByRole('button', { name: 'Transcript step' })).toHaveCSS('padding-right', '6px')
  const send = states.getByRole('button', { name: 'Queue message' })
  const normal = await send.evaluate(node => getComputedStyle(node).backgroundColor)
  await send.hover()
  await expect.poll(() => send.evaluate(node => getComputedStyle(node).backgroundColor)).not.toBe(normal)
})
