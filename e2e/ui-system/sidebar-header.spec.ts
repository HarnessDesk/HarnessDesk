import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) {
  test(`sidebar title icons share the Projects rail and Inbox opens below them (${theme})`, async ({ page }, testInfo) => {
    await page.goto('/preview.html')
    await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
    await page.evaluate(() => {
      const preview = (window as unknown as { __hdPreview: { store: { patch(value: unknown): void } } }).__hdPreview
      preview.store.patch({ inbox: [{ id: 'header-unread', title: 'Review ready', at: Date.now(), read: false, tone: 'info' }] })
    })
    await page.evaluate(() => document.fonts.ready)
    const sidebar = page.locator('[data-frame-id="sidebar-column"] [data-region="sidebar-header"]').locator('..')
    const measurements = []
    for (const width of [200, 240, 320]) {
      await sidebar.locator('..').evaluate((node, value) => { (node as HTMLElement).style.width = `${value}px` }, width)
      await sidebar.scrollIntoViewIfNeeded()
      await page.mouse.move(0, 0)
      const measured = await sidebar.evaluate(node => {
        const rect = (element: Element) => {
          const r = element.getBoundingClientRect()
          return { x: r.x + r.width / 2, y: r.y + r.height / 2, left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
        }
        const search = node.querySelector('button[aria-label="Search everything"]')!
        const bell = node.querySelector('[data-slot="inbox-button"]')!.closest('button')!
        const projects = node.querySelector('[data-slot="navigation-group-header"]')!
        const plus = projects.querySelector('button[aria-label="Open a project folder"] svg')!
        const display = projects.querySelector('button[aria-label="How this list is shown"] svg')!
        const css = getComputedStyle(node)
        return {
          sidebar: rect(node), search: rect(search), searchGlyph: rect(search.querySelector('svg')!),
          bell: rect(bell), bellGlyph: rect(bell.querySelector('svg')!), unread: rect(bell.querySelector('[data-slot="inbox-button"] > span')!), plus: rect(plus), display: rect(display),
          wordmark: rect(node.querySelector('[data-role="wordmark"]')!),
          badges: [...node.querySelectorAll('[aria-label="Main sections"] [data-slot="sidebar-menu-badge"]')].map(rect),
          target: Number.parseFloat(css.getPropertyValue('--hd-icon-target')),
          step: Number.parseFloat(css.getPropertyValue('--hd-sidebar-end-action-step')),
          bellInTitle: search.closest('[data-slot="bar"]')!.contains(bell),
          bellInFooter: node.querySelector('[data-region="sidebar-footer"]')!.contains(bell),
          draggable: getComputedStyle(search.closest('[data-slot="bar"]')!).getPropertyValue('-webkit-app-region'),
          searchNoDrag: search.classList.contains('hd-no-drag'), bellNoDrag: Boolean(bell.closest('.hd-no-drag')),
        }
      })
      measurements.push({ width, ...measured })
      expect(Math.abs(measured.searchGlyph.x - measured.plus.x), 'search uses the Projects end rail').toBeLessThanOrEqual(0.5)
      expect(measured.bellInTitle).toBe(true)
      expect(measured.bellInFooter).toBe(false)
      expect(Math.abs(measured.bellGlyph.x - measured.display.x)).toBeLessThanOrEqual(0.5)
      expect(Math.abs(measured.searchGlyph.x - measured.bellGlyph.x - measured.step)).toBeLessThanOrEqual(0.5)
      expect(measured.unread.right, 'unread count stays clear of the search glyph').toBeLessThanOrEqual(measured.searchGlyph.left)
      for (const icon of [measured.search, measured.bell]) {
        expect(icon.width).toBe(measured.target)
        expect(icon.height).toBe(measured.target)
        expect(Math.abs(icon.y - measured.wordmark.y)).toBeLessThanOrEqual(0.5)
      }
      for (const badge of measured.badges) expect(Math.abs(badge.x - measured.searchGlyph.x)).toBeLessThanOrEqual(0.5)
      expect(measured.wordmark.right).toBeLessThanOrEqual(measured.bell.left)
      expect(measured.draggable).toBe('drag')
      expect(measured.searchNoDrag && measured.bellNoDrag).toBe(true)
      const search = sidebar.getByRole('button', { name: 'Search everything', exact: true })
      await expect(search).toHaveAttribute('title', 'Search everything (⌘K)')
      await expect(search).toHaveAttribute('aria-keyshortcuts', 'Meta+K')

      const bell = sidebar.locator('[data-slot="inbox-button"]').locator('..')
      await bell.click()
      const inbox = page.locator('[data-slot="inbox-list"]')
      await expect(inbox).toBeVisible()
      const panel = inbox.locator('xpath=ancestor::*[@data-slot="popover-popup"]')
      await expect(panel).toHaveAttribute('data-side', 'bottom')
      const bounds = await inbox.boundingBox()
      expect(bounds!.y).toBeGreaterThanOrEqual(measured.bell.bottom)
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width)
      await page.keyboard.press('Escape')
      await expect(inbox).toHaveCount(0)
      await expect(bell).toBeFocused()
    }
    await page.setViewportSize({ width: 720, height: 520 })
    const header = sidebar.locator('[data-region="sidebar-header"]')
    await header.scrollIntoViewIfNeeded()
    const bell = header.locator('[data-slot="inbox-button"]').locator('..')
    await bell.click()
    const inbox = page.locator('[data-slot="inbox-list"]')
    await expect(inbox).toBeVisible()
    const popup = await inbox.locator('xpath=ancestor::*[@data-slot="popover-popup"]').boundingBox()
    expect(popup!.x).toBeGreaterThanOrEqual(0)
    expect(popup!.y).toBeGreaterThanOrEqual(0)
    expect(popup!.x + popup!.width).toBeLessThanOrEqual(720)
    expect(popup!.y + popup!.height).toBeLessThanOrEqual(520)
    await page.keyboard.press('Escape')
    await testInfo.attach('header-rail.json', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' })
  })
}
