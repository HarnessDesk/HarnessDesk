import { expect, test } from '@playwright/test'
import path from 'node:path'
import type { AppSnapshot } from '../../packages/ui/src/state/store'

for (const theme of ['light', 'dark'] as const) test(`activation reveals a folderless conversation beyond overflow and respects a later fold in ${theme}`, async ({ page }) => {
  await page.emulateMedia({ colorScheme: theme })
  await page.setViewportSize({ width: 1440, height: 1200 })
  await page.goto(`/preview.html?sidebar=folderless&theme=${theme}`)
  const sidebar = page.locator('[data-frame-id="sidebar-column"]')
  const column = sidebar.locator('[style*="width: 240px"]')
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
  test(`external Seat activation reveals its Team and preserves a later fold — ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?sidebar-structure&isolated-seat&theme=${theme}`)
    await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
    const fixture = page.locator('#sidebar-structure')
    const tree = fixture.locator('[data-region="session-tree"]')
    for (const width of [320, 200]) {
      await fixture.evaluate((node, size) => { (node as HTMLElement).style.width = `${size}px` }, width)
      await page.evaluate(() => {
        const { store, writerKey } = (window as unknown as { __hdSidebarStructure: { store: { patch(value: unknown): void }; writerKey: string } }).__hdSidebarStructure
        store.patch({ activeSessionKey: writerKey })
      })
      const writer = tree.locator('[aria-current="page"]')
      await expect(writer).toHaveCount(1)
      await expect(writer).toContainText('Writer')
      await expect(tree.locator('[data-project-root="/work/atlas"] [data-nested="true"] [aria-current="page"]')).toBeVisible()
      await expect(writer).toHaveAttribute('tabindex', '0')
      await writer.focus()
      await page.keyboard.press('ArrowLeft')
      await expect(tree.getByRole('button', { name: 'Room Ship checkout retry', exact: true })).toBeFocused()
      await expect(tree.getByRole('button', { name: 'Show the agents in Ship checkout retry', exact: true })).toHaveAttribute('aria-expanded', 'false')
      await page.evaluate(() => {
        const { store } = (window as unknown as { __hdSidebarStructure: { store: { patch(value: unknown): void } } }).__hdSidebarStructure
        store.patch({ inbox: [] })
      })
      await expect(tree.locator('[aria-current="page"]')).toHaveCount(0)
      await page.evaluate(() => {
        (document.activeElement as HTMLElement)?.blur()
        const { store } = (window as unknown as { __hdSidebarStructure: { store: { patch(value: unknown): void } } }).__hdSidebarStructure
        store.patch({ activeSessionKey: null })
      })
    }
  })

  test(`unread output preserves a folded Team’s running spinner — ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?sidebar-structure&unread-seat&theme=${theme}`)
    await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
    const fixture = page.locator('#sidebar-structure')
    const team = fixture.getByRole('button', { name: 'Room Check release notes', exact: true })
    const row = team.locator('xpath=ancestor::li[@data-slot="sidebar-menu-item"][1]')
    for (const width of [320, 200]) {
      await fixture.evaluate((node, size) => { (node as HTMLElement).style.width = `${size}px` }, width)
      await page.mouse.move(1000, 0)
      await expect(fixture.getByRole('button', { name: 'Show the agents in Check release notes', exact: true })).toHaveAttribute('aria-expanded', 'false')
      await expect(row.locator('[data-slot="spinner"]')).toBeVisible()
      await expect(row.locator('[data-slot="spinner"]')).toHaveCSS('animation-name', 'none')
      await expect(team).not.toContainText('Working')
    }
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`project / Team / Seat hierarchy and row states — ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/preview.html?sidebar-structure')
    await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
    const fixture = page.locator('#sidebar-structure')
    const tree = fixture.locator('[data-region="session-tree"]')
    await expect(tree.locator('[data-project-root]')).toHaveCount(3)
    await expect(tree.locator('[data-tone="waiting"], [data-tone="working"]')).toHaveCount(0)
    await expect(tree.locator('[data-sidebar-band="pinned"]')).toContainText('Pinned plan')
    const team = tree.getByRole('button', { name: 'Room Ship checkout retry', exact: true })
    await expect(team).toContainText('Needs you')
    await expect(tree.getByRole('button', { name: 'Show the agents in Ship checkout retry' })).toHaveAttribute('aria-expanded', 'false')
    await expect(tree.locator('[data-nested="true"]')).toHaveCount(0)
    const project = team.locator('xpath=ancestor::*[@data-project-root]')
    const projectHead = project.locator('[data-draggable]')
    const position = (row: typeof team) => row.locator('[data-slot="sidebar-menu-icon"]').evaluate(node => node.getBoundingClientRect().x)
    expect(await position(team)).toBeCloseTo(await projectHead.locator('[data-slot="text"]').first().evaluate(node => node.getBoundingClientRect().x), 0)

    await team.focus()
    await page.keyboard.press('ArrowRight')
    const seats = team.locator('xpath=ancestor::li').locator('[data-nested="true"] [data-region="session-row"]')
    await expect(seats).toHaveCount(3)
    const writer = seats.first().locator('[data-slot="sidebar-menu-button"]')
    await expect(writer).toBeFocused()
    expect(await position(writer)).toBeGreaterThan(await position(team))
    await expect(seats.nth(1).locator('[data-slot="sidebar-menu-state"]')).toHaveAttribute('aria-label', 'Needs you')
    const busy = project.locator('[data-region="session-row"]').filter({ hasText: 'Check build' })
    await expect(busy.locator('[data-slot="spinner"]')).toBeVisible()

    for (const width of [320, 200]) {
      await fixture.evaluate((node, size) => { (node as HTMLElement).style.width = `${size}px` }, width)
      await page.locator('body').click({ position: { x: 1000, y: 1 } })
      const state = team.locator('[data-sidebar-menu-state-full]')
      await expect(state).toBeVisible()
      const box = await state.boundingBox()
      const row = await team.boundingBox()
      expect(box!.x + box!.width).toBeLessThanOrEqual(row!.x + row!.width)
      expect(await fixture.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
    }
    await writer.focus()
    await page.keyboard.press('ArrowLeft')
    await expect(team).toBeFocused()
    await expect(seats).toHaveCount(0)
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`quiet headers and nested rows preserve the sidebar rails — ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
    await page.goto('/preview.html?sidebar-structure')
    await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
    const fixture = page.locator('#sidebar-structure')
    const tree = fixture.locator('[data-region="session-tree"]')
    const team = tree.getByRole('button', { name: 'Room Ship checkout retry', exact: true })
    await team.focus()
    await page.keyboard.press('ArrowRight')
    const project = tree.locator('[data-project-root="/work/atlas"]')
    const header = project.locator('[data-draggable]')
    const seat = project.locator('[data-nested="true"] [data-region="session-row"]').first()
    const pinned = tree.locator('[data-sidebar-band="pinned"]')
    const runningTeam = tree.getByRole('button', { name: 'Room Check release notes', exact: true }).locator('xpath=ancestor::li[@data-slot="sidebar-menu-item"][1]')
    await expect(runningTeam.locator(':scope > div > [data-slot="sidebar-menu-badge"] [data-slot="spinner"]')).toBeVisible()
    await expect(tree.getByRole('button', { name: 'Other projects', exact: false })).toHaveAttribute('aria-expanded', 'true')
    await expect(tree.locator('[data-project-root="/work/compass"] [data-draggable] [data-slot="sidebar-menu-icon"]')).toHaveCount(0)
    const right = async (item: ReturnType<typeof tree.locator>) => {
      const box = await item.boundingBox()
      expect(box).not.toBeNull()
      return box!.x + box!.width
    }
    const textStart = (item: ReturnType<typeof tree.locator>) => item.evaluate(node => {
      const range = document.createRange()
      range.selectNodeContents(node)
      return range.getBoundingClientRect().x
    })
    for (const width of [320, 200]) {
      await fixture.evaluate((node, size) => { (node as HTMLElement).style.width = `${size}px` }, width)
      await page.locator('body').click({ position: { x: 1000, y: 1 } })
      await page.mouse.move(1000, 0)
      // The section and the project header retain the top-level start inset.
      expect(Math.abs(await textStart(header.locator('[data-slot="text"]').first()) - await textStart(tree.getByRole('button', { name: 'Other projects', exact: false }).locator('[data-slot="sidebar-menu-label-content"]')))).toBeLessThanOrEqual(1)
      await expect(header.locator('[data-slot="sidebar-menu-icon"]')).toHaveCount(0)
      const name = header.locator('[data-slot="text"]').first()
      await expect(name).toHaveCSS('font-size', '14px')
      await expect(name).toHaveCSS('font-weight', '400')
      const ink = await fixture.evaluate(node => ({ secondary: getComputedStyle(node).getPropertyValue('--hd-secondary-foreground').trim(), muted: getComputedStyle(node).getPropertyValue('--hd-muted-foreground').trim() }))
      await expect(name).toHaveCSS('color', ink.secondary)
      await expect(pinned.locator('[data-slot="group-label"]')).toHaveCSS('color', ink.muted)
      const chevron = header.locator('[data-slot="disclosure-chevron"]')
      await expect(chevron).toHaveCSS('opacity', '0')
      await header.hover()
      await expect(chevron).toHaveCSS('opacity', '1')
      await expect(project.getByRole('button', { name: 'New session in atlas', exact: true })).toHaveCSS('opacity', '1')
      const headerAction = project.getByRole('button', { name: 'Actions for atlas', exact: true })
      await expect(headerAction).toHaveCSS('opacity', '1')
      const topRail = await right(headerAction)
      await seat.locator('[data-slot="sidebar-menu-button"]').hover()
      const seatAction = seat.locator('[data-slot="sidebar-menu-action"]')
      await expect(seatAction).toHaveCSS('opacity', '1')
      expect(Math.abs(await right(seatAction) - topRail)).toBeLessThanOrEqual(1)
      await page.mouse.move(1000, 0)
      const spinner = seat.locator('[data-slot="spinner"]')
      await expect(spinner).toBeVisible()
      await expect(spinner).toHaveCSS('animation-name', 'none')
      // The mark occupies the same target column as the top-level action.
      expect(Math.abs(await right(spinner.locator('..')) - topRail)).toBeLessThanOrEqual(1)
      const leading = (item: ReturnType<typeof tree.locator>) => item.locator('[data-slot="sidebar-menu-icon"]').first().evaluate(node => node.getBoundingClientRect().x)
      const step = await fixture.evaluate(node => Number.parseFloat(getComputedStyle(node).getPropertyValue('--hd-space-5')) + Number.parseFloat(getComputedStyle(node).getPropertyValue('--hd-space-2')) + 1)
      expect(await leading(seat) - await leading(team)).toBeCloseTo(step, 0)
      expect(await leading(pinned) - await textStart(pinned.locator('[data-slot="group-label"]'))).toBeCloseTo(0, 0)
    }
    await header.focus()
    await expect(header.locator('[data-slot="disclosure-chevron"]')).toHaveCSS('opacity', '1')
    await page.keyboard.press('Enter')
    await expect(header).toHaveAttribute('aria-expanded', 'false')
    await expect(project.locator('[data-virtual-project]')).toHaveCount(0)
    await header.click()
    await expect(header).toHaveAttribute('aria-expanded', 'true')
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`indentation preserves headings, separators and row highlights — ${theme}`, async ({ page }) => {
    await page.goto(`/preview.html?sidebar-structure&theme=${theme}`)
    await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
    const fixture = page.locator('#sidebar-structure')
    const project = fixture.locator('[data-project-root="/work/atlas"]')
    const projectHeading = project.locator('[data-draggable] [data-slot="text"]').first()
    const team = project.getByRole('button', { name: 'Room Ship checkout retry', exact: true })
    await team.focus()
    await page.keyboard.press('ArrowRight')
    const pinned = fixture.locator('[data-sidebar-band="pinned"]')
    const loose = project.locator('[data-region="session-row"]').filter({ hasText: 'Release notes' }).locator('[data-slot="sidebar-menu-button"]')
    const seats = project.locator('[data-nested="true"]')
    const writer = seats.locator('[data-slot="sidebar-menu-button"]').first()
    const reviewer = seats.locator('[data-region="session-row"]').filter({ hasText: 'Reviewer' })
    for (const width of [320, 200]) {
      await fixture.evaluate((node, size) => { (node as HTMLElement).style.width = `${size}px` }, width)
      await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
      await page.mouse.move(1000, 0)
      const origin = (await fixture.boundingBox())!.x
      const bounds = async (node: typeof team) => { const b = (await node.boundingBox())!; return [b.x - origin, b.x + b.width - origin] }
      const textX = (node: typeof team) => node.evaluate(el => { const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect().x })
      const leadingX = (node: typeof team) => node.locator('[data-slot="sidebar-menu-icon"]').first().evaluate(el => el.getBoundingClientRect().x)
      expect.soft(await textX(pinned.locator('[data-slot="group-label"]')) - origin).toBe(24)
      expect.soft(await leadingX(loose)).toBeCloseTo(await textX(projectHeading), 0)
      expect.soft(await leadingX(team)).toBeCloseTo(await textX(projectHeading), 0)
      expect.soft(await leadingX(pinned.locator('[data-slot="sidebar-menu-button"]'))).toBeCloseTo(await textX(pinned.locator('[data-slot="group-label"]')), 0)
      expect.soft(await bounds(pinned.locator('[data-slot="separator"]'))).toEqual([16, width - 16])
      expect.soft(await bounds(pinned.locator('[data-slot="sidebar-menu-button"]'))).toEqual([16, width - 16])
      expect.soft(await bounds(loose)).toEqual([8, width - 8])
      expect.soft(await bounds(team)).toEqual([8, width - 8])
      expect.soft(await bounds(writer)).toEqual([37, width - 8])
      await expect.soft(project.locator('[data-virtual-project]')).toHaveCSS('border-left-width', '0px')
      await expect.soft(pinned.locator('[data-slot="sidebar-group-content"]')).toHaveCSS('border-left-width', '0px')
      await expect.soft(seats).toHaveCSS('border-left-width', '1px')
      const full = reviewer.locator('[data-sidebar-menu-state-full]')
      if (width === 200) {
        await expect.soft(full).toBeHidden()
        await expect.soft(reviewer.locator('[data-sidebar-menu-state-compact]')).toBeVisible()
        const title = reviewer.locator('[data-slot="sidebar-menu-label-content"] > span > span').first()
        expect.soft(await title.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
      } else await expect.soft(full).toBeVisible()
    }
  })
}
