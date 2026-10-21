import { expect, test } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'

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
  await page.locator('[data-frame-id="sidebar-column"]').getByRole('button', { name: 'Show more', exact: true }).first().click()

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

test('sidebar destinations use the frame label scale and retain the approved wordmark', async ({ page }) => {
  await page.goto('/preview.html')
  const sidebar = page.locator('[data-frame-id="sidebar-column"] [data-left-column]')
  const rows = sidebar.locator('[aria-label="Main sections"] [data-slot="sidebar-menu-button"]')
  await expect(rows).toHaveCount(6)
  expect(await rows.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))))
    .toEqual(['Teams', 'Flows', 'Agents', 'Library', 'Plugins', 'Dashboard'])
  const styles = await rows.evaluateAll(nodes => nodes.map(node => {
    const css = getComputedStyle(node)
    return { size: css.fontSize, weight: css.fontWeight }
  }))
  expect(styles).toEqual(Array.from({ length: 6 }, () => ({ size: `${FRAME.rail.label}px`, weight: '400' })))
  await expect(sidebar.locator('[data-region="sidebar-header"] [data-role="wordmark"]')).toHaveCount(1)
})

test('a healthy account reading keeps plain ink rather than success ink', async ({ page }) => {
  await page.goto('/preview.html')
  await page.locator('[data-frame-id="sidebar-column"] button[class*="accountRow"]').click()

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

test('the accounts menu opens above its row, left-aligned with it, inside the foundation\'s width range', async ({ page }) => {
  await page.goto('/preview.html')
  const trigger = page.locator('[data-frame-id="sidebar-column"] button[class*="accountRow"]')
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
  // The compact root sizes to its own content, bounded by the same menu
  // tokens as its flyouts. The seat-menu spec checks independence from
  // sidebar width, and both levels in a window narrower than their content.
  expect(edges.wide).toBeGreaterThan(0)
  expect(edges.menu.width).toBeGreaterThanOrEqual(FRAME.menu.min)
  expect(edges.menu.width).toBeLessThanOrEqual(edges.wide)
})

test('Settings group labels and destinations use the named frame type pairs', async ({ page }) => {
  await page.goto('/preview.html?frame-wall=settings-navigation')
  const settings = page.locator('[data-frame-id="frame-wall"]')

  const title = settings.locator('[data-left-row]').filter({ hasText: /^General$/ }).locator('[data-slot="sidebar-menu-label-content"]')
  const label = settings.locator('[data-left-group-text]').filter({ hasText: 'Preferences' })
  await expect(title).toBeVisible()
  await expect(label).toBeVisible()
  const sizes = await Promise.all([
    title.evaluate(node => parseFloat(getComputedStyle(node).fontSize)),
    label.evaluate(node => parseFloat(getComputedStyle(node).fontSize)),
  ])
  expect(sizes).toEqual([FRAME.rail.settingsLabel,FRAME.rail.label])
  await expect(title).toHaveCSS('font-weight','400')
  await expect(label).toHaveCSS('font-weight','400')
})

test('a destination title computes the page type in the content column', async ({ page }) => {
  await page.goto('/preview.html?frame-wall=library')
  const settings = page.locator('[data-frame-id="frame-wall"]')

  const title = settings.locator('[data-page-destination="library"]:visible h1[data-role="page"]')
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
