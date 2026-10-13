import { expect, test } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'
import path from 'node:path'
import type { AppSnapshot } from '../../packages/ui/src/state/store'

for (const theme of ['light', 'dark'] as const) test(`activation reveals a folderless conversation beyond overflow and respects a later fold in ${theme}`, async ({ page }) => {
  await page.emulateMedia({ colorScheme: theme })
  await page.setViewportSize({ width: 1440, height: 1200 })
  await page.goto(`/preview.html?sidebar=folderless&theme=${theme}`)
  const sidebar = page.locator('[data-frame-id="sidebar-column"]')
  const column = sidebar.locator(`[style*="width: ${FRAME.sidebar.width}px"]`)
  await column.evaluate(node => { (node as HTMLElement).style.height = '1000px' })
  const group = sidebar.locator('[data-no-folder]')
  const head = group.getByRole('button', { name: 'No folder', exact: true })
  await expect(head).toHaveAttribute('aria-expanded', 'false')
  await page.evaluate(() => {
    const { sidebarFolderlessStore: store } = (window as unknown as { __hdPreview: { sidebarFolderlessStore: {
      getSnapshot(): AppSnapshot; patch(value: Partial<AppSnapshot>): void
    } } }).__hdPreview
    const seed = store.getSnapshot().history.find(row => row.cwd === '')!
    const unknown = Array.from({ length: 15 }, (_, i) => ({ ...seed, id: `unknown-${i}` as typeof seed.id,
      preview: `Saved conversation ${i + 1}`, updatedAt: 15 - i }))
    const history = [...store.getSnapshot().history.filter(row => row.cwd !== ''), ...unknown]
    store.patch({ history, historyIdentity: history, activeSessionKey: `${seed.runtime}\u0000unknown-14` as AppSnapshot['activeSessionKey'] })
  })
  if (process.env.NO_FOLDER_FRAMES_DIR && process.env.NO_FOLDER_FRAME_STATE === 'before') {
    await expect(head).toHaveAttribute('aria-expanded', 'false')
    await column.screenshot({ path: path.join(process.env.NO_FOLDER_FRAMES_DIR, `reveal-before-${theme}.png`) })
  }
  await expect(head).toHaveAttribute('aria-expanded', 'true')
  const active = group.locator('[aria-current="page"]')
  await expect(active).toContainText('Saved conversation 15')
  await expect(active).toBeInViewport()
  await expect(active).toHaveAttribute('tabindex', '0')
  await expect(group.locator('[data-region="session-row"]')).toHaveCount(15)
  if (process.env.NO_FOLDER_FRAMES_DIR && process.env.NO_FOLDER_FRAME_STATE !== 'before') {
    await column.screenshot({ path: path.join(process.env.NO_FOLDER_FRAMES_DIR, `reveal-after-${theme}.png`) })
  }
  await head.click()
  await page.evaluate(() => {
    const { sidebarFolderlessStore: store } = (window as unknown as { __hdPreview: { sidebarFolderlessStore: { patch(value: Partial<AppSnapshot>): void } } }).__hdPreview
    store.patch({ inbox: [] })
  })
  await expect(head).toHaveAttribute('aria-expanded', 'false')
  await page.evaluate(() => {
    const { sidebarFolderlessStore: store } = (window as unknown as { __hdPreview: { sidebarFolderlessStore: {
      getSnapshot(): AppSnapshot; patch(value: Partial<AppSnapshot>): void
    } } }).__hdPreview
    store.patch({ activeSessionKey: `${store.getSnapshot().history.find(row => row.cwd === '')!.runtime}\u0000unknown-0` as AppSnapshot['activeSessionKey'] })
  })
  await expect(head).toHaveAttribute('aria-expanded', 'true')
  await expect(group.locator('[aria-current="page"]')).toContainText('Saved conversation 1')
})

for (const theme of ['light', 'dark'] as const) test(`folderless conversations have a folded group and retain their row menus in ${theme}`, async ({ page }) => {
  await page.emulateMedia({ colorScheme: theme })
  await page.goto(`/preview.html?sidebar=folderless&theme=${theme}`)
  const sidebar = page.locator('[data-frame-id="sidebar-column"]')
  const group = sidebar.locator('[data-no-folder]')
  const head = group.getByRole('button', { name: 'No folder', exact: true })
  await expect(head).toHaveAttribute('aria-expanded', 'false')
  await expect(group.locator('[data-slot="sidebar-menu-action"]')).toHaveCount(0)
  await expect(sidebar.locator('[data-project-root=""]')).toHaveCount(0)
  await expect(sidebar.locator('[data-project-root="/"]')).toBeVisible()
  await head.click()
  await expect(group).toContainText('Restore the project picker')
  await expect(group).toContainText('Explain the retry settings')
  await expect(group).toContainText('Untitled session')
  await group.locator('[data-slot="sidebar-menu-button"]').filter({ hasText: 'Restore the project picker' }).hover()
  await group.locator('[aria-label="Actions for Restore the project picker"]').click()
  await expect(page.getByRole('menuitem', { name: 'Archive', exact: true })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Remove from HarnessDesk', exact: true })).toBeVisible()
})

for (const theme of ['light', 'dark'] as const) {
  test(`external Seat activation reveals its owning project and preserves a later fold — ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?sidebar-structure&isolated-seat&theme=${theme}`)
    await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
    const fixture = page.locator('#sidebar-structure')
    const tree = fixture.locator('[data-region="session-tree"]')
    const project = tree.locator('[data-project-root="/work/atlas"]')
    const head = project.locator('button[data-draggable]')
    const team = tree.getByRole('button', { name: 'Room Ship checkout retry', exact: true })
    for (const width of [320, 200]) {
      await fixture.evaluate((node, size) => { (node as HTMLElement).style.width = `${size}px` }, width)
      await page.evaluate(() => {
        const { store, writerKey } = (window as unknown as { __hdSidebarStructure: { store: { patch(value: unknown): void }; writerKey: string } }).__hdSidebarStructure
        store.patch({ activeSessionKey: writerKey })
      })
      await expect(head).toHaveAttribute('aria-expanded', 'true')
      await expect(team).toBeVisible()
      await expect(tree.locator('[data-nested="true"]')).toHaveCount(0)
      await head.click()
      await expect(head).toHaveAttribute('aria-expanded', 'false')
      await page.evaluate(() => {
        const { store } = (window as unknown as { __hdSidebarStructure: { store: { patch(value: unknown): void } } }).__hdSidebarStructure
        store.patch({ inbox: [] })
      })
      await expect(head).toHaveAttribute('aria-expanded', 'false')
      await page.evaluate(() => {
        (document.activeElement as HTMLElement)?.blur()
        const { store } = (window as unknown as { __hdSidebarStructure: { store: { patch(value: unknown): void } } }).__hdSidebarStructure
        store.patch({ activeSessionKey: null })
      })
    }
  })

  test(`unread output takes priority while keeping running facts — ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
    await page.goto(`/preview.html?sidebar-structure&unread-seat&theme=${theme}`)
    await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
    const fixture = page.locator('#sidebar-structure')
    const team = fixture.getByRole('button', { name: 'Room Check release notes', exact: true })
    const row = team.locator('..')
    for (const width of [320, 200]) {
      await fixture.evaluate((node, size) => { (node as HTMLElement).style.width = `${size}px` }, width)
      await page.mouse.move(1000, 0)
      await expect(row.locator('[data-left-mark]')).toHaveCount(1)
      await expect(row.locator('[data-left-mark]')).toHaveAttribute('aria-label', 'Unread activity')
      expect(await team.getAttribute('title')).toContain('Working')
      await expect(fixture.locator('[data-nested="true"]')).toHaveCount(0)
      await expect(team).not.toContainText('Working')
    }
  })

  test(`project and Team rows share geometry and preserve project folding — ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
    await page.goto('/preview.html?sidebar-structure')
    await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
    const fixture = page.locator('#sidebar-structure')
    const tree = fixture.locator('[data-region="session-tree"]')
    await expect(tree.locator('[data-project-root]')).toHaveCount(3)
    await expect(tree.locator('[data-tone="waiting"], [data-tone="working"]')).toHaveCount(0)
    await expect(tree.locator('[data-sidebar-band="pinned"]')).toContainText('Pinned plan')
    const team = tree.getByRole('button', { name: 'Room Ship checkout retry', exact: true })
    expect(await team.getAttribute('title')).toContain('Needs you')
    await expect(team.locator('..').locator('[data-left-mark]')).toHaveAttribute('aria-label', 'Needs you')
    const project = tree.locator('[data-project-root="/work/atlas"]')
    const head = project.locator('button[data-draggable]')
    const position = (row: typeof team) => row.locator('[data-slot="sidebar-menu-icon"]').evaluate(node => node.getBoundingClientRect().x)
    const projectNameX = await head.locator('[data-slot="sidebar-menu-label-content"]').evaluate(node => {
      const range = document.createRange(); range.selectNodeContents(node); return range.getBoundingClientRect().x
    })
    expect(projectNameX).toBeCloseTo(await position(team), 0)
    await expect(head.locator('[data-slot="sidebar-menu-icon"]')).toHaveCount(0)
    await expect(head.locator('[data-slot="disclosure-chevron"]')).toHaveCount(1)
    await team.focus()
    await page.keyboard.press('ArrowRight')
    await expect(team).toBeFocused()
    await expect(tree.locator('[data-nested="true"]')).toHaveCount(0)
    const busy = project.locator('[data-region="session-row"]').filter({ hasText: 'Check build' })
    await expect(busy.locator('[data-slot="spinner"]')).toBeVisible()
    await expect(busy.locator('[data-slot="spinner"]')).toHaveCSS('animation-name', 'none')
    for (const width of [320, 200]) {
      await fixture.evaluate((node, size) => { (node as HTMLElement).style.width = `${size}px` }, width)
      await page.mouse.move(1000, 0)
      const mark = await team.locator('..').locator('[data-left-mark]').boundingBox()
      const bounds = (await team.boundingBox())!
      expect(bounds.height).toBe(FRAME.rail.rowHeight)
      expect(mark!.x + mark!.width).toBeLessThanOrEqual(bounds.x + bounds.width)
      expect(await fixture.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
    }
    await team.focus()
    await page.keyboard.press('ArrowLeft')
    await expect(head).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(head).toHaveAttribute('aria-expanded', 'false')
    await expect(project.locator('[data-virtual-project]')).toHaveCount(0)
    await head.click()
    await expect(head).toHaveAttribute('aria-expanded', 'true')
    await expect(team).toBeVisible()
  })

  test(`quiet project headings and session substitution preserve one rail — ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
    await page.goto('/preview.html?sidebar-structure')
    await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
    const fixture = page.locator('#sidebar-structure')
    const tree = fixture.locator('[data-region="session-tree"]')
    const project = tree.locator('[data-project-root="/work/atlas"]')
    const header = project.locator('button[data-draggable]')
    const pinned = tree.locator('[data-sidebar-band="pinned"]')
    const busy = project.locator('[data-region="session-row"]').filter({ hasText: 'Check build' })
    const runningTeam = tree.getByRole('button', { name: 'Room Check release notes', exact: true }).locator('..')
    await expect(runningTeam.locator('[data-slot="spinner"]')).toBeVisible()
    await expect(runningTeam.locator('[data-slot="spinner"]')).toHaveCSS('animation-name', 'none')
    await expect(tree.getByRole('button', { name: 'Other projects', exact: false })).toHaveAttribute('aria-expanded', 'true')
    await expect(tree.locator('[data-project-root="/work/compass"] button[data-draggable] [data-slot="disclosure-chevron"]')).toHaveCount(1)
    const centre = async (item: ReturnType<typeof tree.locator>) => { const box = (await item.boundingBox())!; return box.x + box.width / 2 }
    for (const width of [320, 200]) {
      await fixture.evaluate((node, size) => { (node as HTMLElement).style.width = `${size}px` }, width)
      const name = header.locator('[data-slot="sidebar-menu-label-content"]')
      await expect(header).toHaveCSS('font-size', `${FRAME.rail.label}px`)
      await expect(header).toHaveCSS('font-weight', '500')
      // A token's own text is spelled by whatever built the stylesheet (`rgb(27, 27, 27)` in source, `#1b1b1b` in a build), so the ink is resolved to the colour it computes to.
      const ink = await fixture.evaluate(node => {
        const resolve = (token: string) => { const probe = document.createElement('span'); probe.style.color = `var(${token})`; node.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color }
        return { current: resolve('--hd-foreground'), group: resolve('--hd-secondary-foreground') }
      })
      await expect(name).toHaveCSS('color', await header.locator('..').getAttribute('data-current') === null ? ink.group : ink.current)
      await expect(tree.locator('[data-project-root="/work/compass"] button[data-draggable] [data-slot="sidebar-menu-label-content"]')).toHaveCSS('color', ink.group)
      await expect(pinned.locator('[data-left-group-text]')).toHaveCSS('color', ink.group)
      await expect(header.locator('[data-slot="disclosure-chevron"]')).toHaveCount(1)
      await expect(header.locator('[data-slot="disclosure-chevron"]')).toBeHidden()
      await header.hover()
      const add = project.getByRole('button', { name: 'New session in atlas', exact: true })
      await expect(add).toBeVisible()
      await expect(project.getByRole('button', { name: 'Actions for atlas', exact: true })).toHaveCount(0)
      const rail = await centre(add)
      await busy.locator('[data-slot="sidebar-menu-button"]').hover()
      const more = busy.locator('[data-slot="sidebar-menu-action"]')
      await expect(more).toBeVisible()
      expect(Math.abs(await centre(more) - rail)).toBeLessThanOrEqual(1)
      await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
      await page.mouse.move(1000, 0)
      const mark = busy.locator('[data-left-mark]')
      await expect(mark).toBeVisible()
      expect(Math.abs(await centre(mark) - rail)).toBeLessThanOrEqual(1)
      await expect(busy.locator('[data-slot="spinner"]')).toHaveCSS('animation-name', 'none')
    }
  })

  test(`flat headings, separators and row highlights retain exact outer edges — ${theme}`, async ({ page }) => {
    await page.goto(`/preview.html?sidebar-structure&theme=${theme}`)
    await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
    const fixture = page.locator('#sidebar-structure')
    const project = fixture.locator('[data-project-root="/work/atlas"]')
    const team = project.getByRole('button', { name: 'Room Ship checkout retry', exact: true })
    const pinned = fixture.locator('[data-sidebar-band="pinned"]')
    const loose = project.locator('[data-region="session-row"]').filter({ hasText: 'Release notes' }).locator('[data-slot="sidebar-menu-button"]')
    const textX = (node: typeof team) => node.evaluate(el => { const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect().x })
    for (const width of [320, 200]) {
      await fixture.evaluate((node, size) => { (node as HTMLElement).style.width = `${size}px` }, width)
      await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
      await page.mouse.move(1000, 0)
      const origin = (await fixture.boundingBox())!.x
      const bounds = async (node: typeof team) => { const b = (await node.boundingBox())!; return [b.x - origin, b.x + b.width - origin] }
      const iconX = (await team.locator('[data-slot="sidebar-menu-icon"]').boundingBox())!.x
      expect(await textX(pinned.locator('[data-left-group-text]')) - origin).toBe(FRAME.rail.inset * 2)
      expect(await textX(project.locator('button[data-draggable] [data-slot="sidebar-menu-label-content"]'))).toBe(iconX)
      const reference = iconX + FRAME.rail.icon + FRAME.rail.gap
      for (const row of [team, loose, pinned.locator('[data-slot="sidebar-menu-button"]')]) {
        expect(Math.abs(await textX(row.locator('[data-slot="sidebar-menu-label-content"]')) - reference)).toBeLessThanOrEqual(1)
        expect(await bounds(row)).toEqual([8, width - 8])
        expect((await row.boundingBox())!.height).toBe(FRAME.rail.rowHeight)
      }
      expect(await bounds(pinned.locator('[data-slot="separator"]'))).toEqual([8, width - 8])
      await expect(project.locator('[data-virtual-project]')).toHaveCSS('border-left-width', '0px')
      await expect(fixture.locator('[data-nested="true"]')).toHaveCount(0)
    }
  })
}
