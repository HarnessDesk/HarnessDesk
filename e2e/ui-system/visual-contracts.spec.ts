import { expect, test } from '@playwright/test'

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
