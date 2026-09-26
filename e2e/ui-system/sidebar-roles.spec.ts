import { expect, test } from '@playwright/test'

test('sidebar navigation names stay regular and fade at their trailing edge', async ({ page }) => {
  await page.goto('/preview.html')

  const title = page.locator('[class*="rowWrap_"] [data-role="navigation"]').filter({
    hasText: 'Duplicate Codex accounts logged in twice',
  }).first()
  await expect(title).toBeVisible()

  const style = await title.evaluate(node => {
    const computed = getComputedStyle(node)
    return {
      weight: computed.fontWeight,
      mask: computed.maskImage,
      overflow: computed.textOverflow,
      clipped: node.scrollWidth > node.clientWidth,
    }
  })
  expect(style.weight).toBe('400')
  expect(style.clipped).toBe(true)
  expect(style.mask).toContain('linear-gradient')
  expect(style.overflow).not.toBe('ellipsis')
})

test('a healthy account reading keeps plain ink rather than success ink', async ({ page }) => {
  await page.goto('/preview.html')
  await page.locator('button[class*="accountRow"]').click()

  const reading = page.getByText('78%', { exact: true }).first()
  await expect(reading).toBeVisible()
  const colours = await reading.evaluate(node => {
    const probe = document.createElement('span')
    probe.style.color = 'var(--hd-success-ink)'
    document.body.appendChild(probe)
    const result = {
      reading: getComputedStyle(node).color,
      success: getComputedStyle(probe).color,
      tone: node.getAttribute('data-tone'),
    }
    probe.remove()
    return result
  })
  expect(colours.tone).toBe('neutral')
  expect(colours.reading).not.toBe(colours.success)
})

test('the accounts menu opens above its row, inside the sidebar and as wide as the row', async ({ page }) => {
  await page.goto('/preview.html')
  const trigger = page.locator('button[class*="accountRow"]')
  // Where the row sits in the app: at the foot of the window.
  await trigger.evaluate((node) => node.scrollIntoView({ block: 'end' }))
  await trigger.click()

  const popup = page.locator('[data-slot="popover-popup"]')
  await expect(popup).toBeVisible()
  const edges = await popup.evaluate((node, triggerNode) => {
    if (!(triggerNode instanceof HTMLElement)) throw new Error('account trigger missing')
    const sidebar = triggerNode.closest('[class*="sidebar_"]')
    if (!(sidebar instanceof HTMLElement)) throw new Error('sidebar missing')
    const menu = node.getBoundingClientRect()
    const row = triggerNode.getBoundingClientRect()
    const column = sidebar.getBoundingClientRect()
    return { menu: { left: menu.left, right: menu.right, bottom: menu.bottom, width: menu.width }, row: { left: row.left, top: row.top, width: row.width }, column: { left: column.left, right: column.right } }
  }, await trigger.elementHandle())
  // Unfolds from the row rather than being laid over the transcript beside it.
  expect(edges.menu.bottom).toBeLessThanOrEqual(edges.row.top)
  expect(edges.menu.left).toBeCloseTo(edges.row.left, 0)
  // The panel takes the anchor's width, which the positioner rounds to a
  // whole pixel; the seat beside the inbox bell can land on a half.
  expect(Math.abs(edges.menu.width - edges.row.width)).toBeLessThanOrEqual(1)
  expect(edges.menu.left).toBeGreaterThanOrEqual(edges.column.left)
  expect(edges.menu.right).toBeLessThanOrEqual(edges.column.right)
})

test('a settings group label is smaller than its page title', async ({ page }) => {
  await page.goto('/preview.html')
  await page.getByRole('combobox', { name: 'settings page', exact: true }).selectOption('general')
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })

  const title = settings.locator('[data-slot="page-title"]')
  const label = settings.locator('[data-slot="section-name"]').filter({ hasText: 'Your data' })
  await expect(title).toBeVisible()
  await expect(label).toBeVisible()
  const sizes = await Promise.all([
    title.evaluate(node => parseFloat(getComputedStyle(node).fontSize)),
    label.evaluate(node => parseFloat(getComputedStyle(node).fontSize)),
  ])
  expect(sizes[1]).toBeLessThan(sizes[0])
})

test('a page title computes the wordmark type', async ({ page }) => {
  await page.goto('/preview.html')
  await page.getByRole('combobox', { name: 'settings page', exact: true }).selectOption('general')
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })

  const wordmark = page.locator('[data-role="wordmark"]').first()
  const title = settings.locator('[data-slot="page-title"]')
  await expect(wordmark).toBeVisible()
  await expect(title).toBeVisible()

  const type = (node: Element) => {
    const style = getComputedStyle(node)
    return {
      size: style.fontSize,
      line: style.lineHeight,
      weight: style.fontWeight,
    }
  }
  expect(await title.evaluate(type)).toEqual(await wordmark.evaluate(type))
})
