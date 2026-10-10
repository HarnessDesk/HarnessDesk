import { expect, test } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'

for (const theme of ['light', 'dark'] as const) {
  test(`one left top row and anchored Inbox in ${theme}`, async ({ page }, testInfo) => {
    await page.goto('/preview.html')
    await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
    await page.evaluate(() => {
      const preview = (window as unknown as { __hdPreview: { store: { patch(value: unknown): void } } }).__hdPreview
      preview.store.patch({ inbox: [{ id: 'header-unread', title: 'Review ready', at: Date.now(), read: false, tone: 'info' }] })
    })
    await page.evaluate(async () => { await document.fonts.ready })
    const sidebar = page.locator('[data-frame-id="sidebar-column"] [data-left-column]')
    const measurements = []
    for (const width of [FRAME.sidebar.min, FRAME.sidebar.width, FRAME.sidebar.max]) {
      await sidebar.locator('..').evaluate((node, value) => { (node as HTMLElement).style.width = `${value}px` }, width)
      await sidebar.scrollIntoViewIfNeeded()
      await page.mouse.move(0, 0)
      const measured = await sidebar.evaluate(node => {
        const top = node.querySelector('[data-left-top] [data-slot="bar"]')!
        const search = top.querySelector('button[aria-label="Search everything"]')!
        const bell = top.querySelector('[data-slot="inbox-button"]')!.closest('button')!
        const rect = (element: Element) => {
          const r = element.getBoundingClientRect()
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
        }
        return { top: rect(top), search: rect(search), bell: rect(bell),
          unread: rect(bell.querySelector('[data-slot="inbox-dot"]')!),
          controls: [...top.querySelectorAll('button')].filter(button => button.getClientRects().length > 0).map(rect),
          draggable: getComputedStyle(top).getPropertyValue('-webkit-app-region'),
          noDrag: Boolean(search.closest('.hd-no-drag') && bell.closest('.hd-no-drag')),
          bellInFooter: node.querySelector('[data-region="sidebar-footer"]')!.contains(bell) }
      })
      measurements.push({ width, ...measured })
      expect(measured.top.height).toBe(FRAME.bar.height)
      expect(measured.bellInFooter).toBe(false)
      expect(measured.unread.width).toBeGreaterThan(0)
      expect(measured.unread.width).toBe(measured.unread.height)
      expect(measured.bell.right).toBeLessThanOrEqual(measured.search.left)
      for (const control of measured.controls) {
        expect(control.width).toBe(FRAME.bar.iconButton)
        expect(control.height).toBe(FRAME.bar.iconButton)
        expect(control.top).toBe(measured.search.top)
      }
      expect(measured.draggable).toBe('drag')
      expect(measured.noDrag).toBe(true)
      await expect(sidebar.locator('[data-role="wordmark"]')).toHaveCount(0)
      const history = sidebar.locator('[data-left-history]')
      if (width < FRAME.sidebar.width) await expect(history).toBeHidden()
      else await expect(history).toBeVisible()
      const search = sidebar.getByRole('button', { name: 'Search everything', exact: true })
      await expect(search).toHaveAttribute('title', 'Search everything (⌘K)')
      await expect(search).toHaveAttribute('aria-keyshortcuts', 'Meta+K')
      const bell = sidebar.locator('[data-slot="inbox-button"]').locator('..')
      await bell.click()
      const popup = page.locator('[data-slot="inbox-list"]:visible').locator('xpath=ancestor::*[@data-slot="popover-popup"]')
      await expect(popup).toBeVisible()
      await expect(popup).toHaveAttribute('data-side', 'bottom')
      const bounds = (await popup.boundingBox())!
      expect(bounds.y).toBeGreaterThanOrEqual(measured.bell.bottom)
      expect(bounds.x).toBeGreaterThanOrEqual(0)
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize()!.width)
      await page.keyboard.press('Escape')
      await expect(popup).toHaveCount(0)
      await expect(bell).toBeFocused()
    }
    await page.setViewportSize({ width: 720, height: 520 })
    await sidebar.scrollIntoViewIfNeeded()
    await sidebar.locator('[data-slot="inbox-button"]').locator('..').click()
    const popup = page.locator('[data-slot="inbox-list"]:visible').locator('xpath=ancestor::*[@data-slot="popover-popup"]')
    await expect(popup).toBeVisible()
    const bounds = (await popup.boundingBox())!
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.y).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(720)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(520)
    await page.keyboard.press('Escape')
    await testInfo.attach('left-top.json', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' })
  })
}
