import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) {
  test(`quiet chips keep each tone and type while removing the pill (${theme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/design.html?view=state')
    for (const tone of ['neutral', 'brand', 'success', 'warning', 'danger', 'info']) {
      const quiet = page.locator(`main [data-slot="chip"][data-variant="quiet"][data-tone="${tone}"]`)
      await expect(quiet).toHaveCount(1)
      const pill = page.locator(`main [data-slot="chip"][data-variant="default"][data-tone="${tone}"]`).first()
      const read = (node: Element) => {
        const css = getComputedStyle(node)
        return { color: css.color, size: css.fontSize, background: css.backgroundColor,
          border: css.borderWidth, shadow: css.boxShadow, padding: css.paddingInline }
      }
      const before = await pill.evaluate(read)
      expect(await quiet.evaluate(read)).toEqual({ ...before,
        background: 'rgba(0, 0, 0, 0)', border: '0px', shadow: 'none', padding: '0px' })
      expect(before.background).not.toBe('rgba(0, 0, 0, 0)')
      if (tone === 'brand') {
        // Emphasis cannot leave white pill ink on a transparent ground.
        await quiet.evaluate(node => node.setAttribute('data-emphasis', ''))
        expect((await quiet.evaluate(read)).color).toBe(before.color)
      }
    }
  })
}

test('sidebar navigation names stay regular and truncate at their trailing edge', async ({ page }) => {
  await page.goto('/preview.html')

  const title = page.locator('[data-region="session-row"] [data-slot="sidebar-menu-label"]').filter({
    hasText: 'Pin the flaky inventory test after reconciling every retry branch',
  }).first()
  await expect(title).toBeVisible()

  const style = await title.evaluate((node) => {
    const text = [...node.querySelectorAll<HTMLElement>('*')].filter((child) => child.textContent?.trim() === 'Pin the flaky inventory test after reconciling every retry branch').at(-1)
    if (!text) throw new Error('session label text missing')
    const computed = getComputedStyle(text)
    return {
      weight: computed.fontWeight,
      mask: computed.maskImage,
      overflow: computed.textOverflow,
      clipped: text.scrollWidth > text.clientWidth,
    }
  })
  expect(style.weight).toBe('400')
  expect(style.clipped).toBe(true)
  expect(style.mask).not.toContain('linear-gradient')
  expect(style.overflow).toBe('ellipsis')
})

test('sidebar destinations use the navigation text role and the brand uses the wordmark role', async ({ page }) => {
  await page.goto('/preview.html')
  const destinations = page.locator('[aria-label="Main sections"] [data-role="navigation"]')
  await expect(destinations).toHaveCount(3)
  const destinationStyles = await destinations.evaluateAll((nodes) => nodes.map((node) => {
    const style = getComputedStyle(node)
    return { size: style.fontSize, weight: style.fontWeight }
  }))
  expect(destinationStyles).toEqual(Array.from({ length: 3 }, () => ({ size: '13px', weight: '400' })))

  const brand = page.locator('[data-region="sidebar-header"] [data-role="wordmark"]')
  await expect(brand).toHaveText('HarnessDesk')
  const style = await brand.evaluate((node) => {
    const computed = getComputedStyle(node)
    return { size: computed.fontSize, weight: computed.fontWeight }
  })
  expect(style).toEqual({ size: '20px', weight: '600' })
})

test('a healthy account reading keeps plain ink rather than success ink', async ({ page }) => {
  await page.goto('/preview.html')
  await page.locator('button[class*="accountRow"]').click()

  // The account menu's own reading, not the first one anywhere on the page:
  // which one comes first depends on the window's width and on what else the
  // preview draws (the Dashboard's rail used to hold one).
  const reading = page.locator('[data-slot="popover-popup"]').getByText('78%', { exact: true }).first()
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
  // A healthy reading carries no warning or danger tone; plain ink.
  expect(colours.tone === null || colours.tone === 'neutral').toBe(true)
  expect(colours.reading).not.toBe(colours.success)
})

test('the accounts menu opens above its row, left-aligned with it, at the foundation\'s wide width', async ({ page }) => {
  await page.goto('/preview.html')
  const trigger = page.locator('button[class*="accountRow"]')
  // Where the row sits in the app: at the foot of the window.
  await trigger.evaluate((node) => node.scrollIntoView({ block: 'end' }))
  await trigger.click()

  const popup = page.locator('[data-slot="popover-popup"]')
  await expect(popup).toBeVisible()
  const edges = await popup.evaluate((node, triggerNode) => {
    if (!(triggerNode instanceof HTMLElement)) throw new Error('account trigger missing')
    const menu = node.getBoundingClientRect()
    const row = triggerNode.getBoundingClientRect()
    const wide = parseFloat(getComputedStyle(node).getPropertyValue('--hd-popover-width-wide'))
    return { menu: { left: menu.left, bottom: menu.bottom, width: menu.width }, row: { left: row.left, top: row.top }, wide }
  }, await trigger.elementHandle())
  // Unfolds from the row rather than being laid over the transcript beside it.
  expect(edges.menu.bottom).toBeLessThanOrEqual(edges.row.top)
  expect(edges.menu.left).toBeCloseTo(edges.row.left, 0)
  // The panel keeps its own width, the foundation's wide one, so a narrow
  // sidebar does not fold the account and usage rows; the seat-menu spec
  // measures it at every sidebar width and holds both its edges inside a
  // window too narrow for it.
  expect(edges.wide).toBeGreaterThan(0)
  expect(edges.menu.width).toBeCloseTo(edges.wide, 0)
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

test('a page title computes the heading type', async ({ page }) => {
  await page.goto('/preview.html')
  await page.getByRole('combobox', { name: 'settings page', exact: true }).selectOption('general')
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })

  const title = settings.locator('[data-slot="page-title"]')
  await expect(title).toBeVisible()

  const type = (node: Element) => {
    const style = getComputedStyle(node)
    return {
      size: style.fontSize,
      line: style.lineHeight,
      weight: style.fontWeight,
    }
  }
  const expected = await title.evaluate((node) => {
    const probe = document.createElement('span')
    probe.style.cssText = 'font-size:var(--hd-heading);line-height:var(--hd-line-heading);font-weight:var(--hd-weight-semibold)'
    node.parentElement!.append(probe)
    const style = getComputedStyle(probe)
    const result = { size: style.fontSize, line: style.lineHeight, weight: style.fontWeight }
    probe.remove()
    return result
  })
  expect(await title.evaluate(type)).toEqual(expected)
})
