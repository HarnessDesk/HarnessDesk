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
  const head = group.getByRole('button', { name: 'Chats', exact: true })
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
  await expect(group.locator('[data-region="session-row"]')).toHaveCount(5)
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
  const head = group.getByRole('button', { name: 'Chats', exact: true })
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
      await expect(tree.locator('[data-nested="true"]')).toHaveCount(1)
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
      await expect(row.locator('[data-left-mark]')).toHaveAccessibleName('New')
      await expect(row.locator('[data-left-mark] [data-slot="dot"]')).toHaveAttribute('data-state','new')
      expect(await team.getAttribute('title')).toContain('Unread activity')
      expect(await team.getAttribute('title')).toContain('Working')
      await expect(fixture.locator('[data-nested="true"]')).toHaveCount(1)
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
    await expect(project.locator('[data-region="seat-row"] [data-slot="sidebar-menu-button"]').first()).toBeFocused()
    await expect(tree.locator('[data-nested="true"]')).toHaveCount(1)
    const busy = project.locator('[data-region="session-row"]').filter({ hasText: 'Check build' })
    await expect(busy.locator('[data-slot="spinner"]')).toHaveCount(1)
    await expect(busy.locator('[data-slot="sidebar-menu-button"]')).toHaveAttribute('title', /Thinking|Running/)
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
    await expect(team).toHaveAttribute('aria-expanded', 'false')
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
    await expect(runningTeam.locator('[data-slot="spinner"]')).toHaveCount(1)
    await expect(runningTeam.locator('[data-slot="sidebar-menu-button"]')).toHaveAttribute('title', /Working/)
    await expect(tree.getByRole('button', { name: 'Other projects', exact: false })).toHaveAttribute('aria-expanded', 'true')
    await expect(tree.locator('[data-project-root="/work/compass"] button[data-draggable] [data-slot="disclosure-chevron"]')).toHaveCount(1)
    const centre = async (item: ReturnType<typeof tree.locator>) => { const box = (await item.boundingBox())!; return box.x + box.width / 2 }
    for (const width of [320, 200]) {
      await fixture.evaluate((node, size) => { (node as HTMLElement).style.width = `${size}px` }, width)
      const name = header.locator('[data-slot="sidebar-menu-label-content"]')
      await expect(header).toHaveCSS('font-size', `${FRAME.rail.label}px`)
      await expect(header).toHaveCSS('font-weight', '400')
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
      await expect(mark).toHaveCount(1)
      await expect(busy.locator('[data-slot="sidebar-menu-button"]')).toHaveAttribute('title', /Thinking|Running/)
    }
  })

  test(`flat headings, separators and row highlights retain exact outer edges — ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
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
      const gutter = await fixture.evaluate(node => parseFloat(getComputedStyle(node).getPropertyValue('--hd-icon-target')))
      expect(await textX(pinned.locator('[data-left-group-text]')) - origin).toBe(FRAME.rail.inset * 2 + gutter)
      expect(await textX(project.locator('button[data-draggable] [data-slot="sidebar-menu-label-content"]'))).toBe(iconX)
      const reference = iconX + FRAME.rail.icon + FRAME.rail.gap
      for (const row of [team, loose, pinned.locator('[data-slot="sidebar-menu-button"]')]) {
        expect(Math.abs(await textX(row.locator('[data-slot="sidebar-menu-label-content"]')) - reference)).toBeLessThanOrEqual(1)
        expect(await bounds(row)).toEqual([FRAME.rail.inset + gutter, width - FRAME.rail.inset])
        expect((await row.boundingBox())!.height).toBe(FRAME.rail.rowHeight)
      }
      expect(await bounds(pinned.locator('[data-slot="separator"]'))).toEqual([8, width - 8])
      await expect(project.locator('[data-virtual-project]')).toHaveCSS('border-left-width', '0px')
      await expect(fixture.locator('[data-nested="true"]')).toHaveCount(1)
    }
  })
}

for (const theme of ['light', 'dark'] as const) test(`nested seats keep their icon, pitch and trailing rails through disclosure and activity — ${theme}`, async ({ page }) => {
  await page.emulateMedia({ colorScheme: theme })
  await page.goto(`/preview.html?sidebar-structure&theme=${theme}`)
  await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
  const fixture = page.locator('#sidebar-structure')
  const team = fixture.getByRole('button', { name: 'Room Ship checkout retry', exact: true })
  const collapsed = fixture.getByRole('button', { name: 'Room Check release notes', exact: true })
  const seats = fixture.locator('[data-region="seat-row"]')
  const working = seats.filter({ hasText: 'Writer 2' })
  const idle = seats.filter({ hasText: 'Writer with a long seat label' })
  const busy = fixture.locator('[data-region="session-row"]').filter({ hasText: 'Check build' })
  const toggleDisclosure = async () => {
    const control = team.locator('..').locator('[data-left-disclosure]')
    await control.scrollIntoViewIfNeeded()
    await control.click()
  }
  const near = (actual: number, expected: number, why: string) => expect(Math.abs(actual - expected), `${why}: ${actual} vs ${expected}`).toBeLessThanOrEqual(1)
  const measure = () => fixture.evaluate(node => {
    const bounds = (el: Element) => { const r = el.getBoundingClientRect(); return { x: r.x, right: r.right, y: r.y, h: r.height, w: r.width, cy: r.y + r.height / 2 } }
    return [...node.querySelectorAll('[data-left-row]')].map(row => {
      const button = row.querySelector('[data-slot="sidebar-menu-button"]')!
      const icon = button.querySelector('[data-slot="sidebar-menu-icon"]')
      const label = button.querySelector('[data-slot="sidebar-menu-label-content"]')!
      const mark = row.querySelector('[data-left-mark]')
      const rail = row.querySelector('[data-left-trailing]')!
      const spinner = row.querySelector('[data-slot="spinner"]')
      return { name: button.getAttribute('aria-label'), nested: row.hasAttribute('data-left-nested'), row: bounds(row), button: bounds(button), label: bounds(label), rail: bounds(rail), icon: icon ? bounds(icon) : null, mark: mark ? bounds(mark) : null, spinner: spinner ? bounds(spinner) : null }
    })
  })
  for (const width of [320, 200]) {
    await fixture.evaluate((node, size) => { (node as HTMLElement).style.width = `${size}px` }, width)
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
    await page.mouse.move(1000, 0)
    await expect(working.locator('[data-slot="spinner"]')).toHaveCount(1)
    await expect(working.locator('[data-left-mark-prefix]')).toHaveText('#4')
    await expect(idle.locator('[data-left-mark]')).toHaveCount(0)
    await expect(collapsed.locator('..').locator('[data-slot="spinner"]')).toHaveCount(1)
    if (await team.getAttribute('aria-expanded') === 'true') await toggleDisclosure()
    await expect(team).toHaveAttribute('aria-expanded', 'false')
    const folded = await measure()
    const foldedParent = folded.find(row => row.name === 'Room Ship checkout retry')!
    await toggleDisclosure()
    await expect(team).toHaveAttribute('aria-expanded', 'true')
    await expect(seats).toHaveCount(3)
    const before = await measure()
    const parent = before.find(row => row.name === 'Room Ship checkout retry')!
    const loose = before.find(row => row.name === 'Check build')!
    const nested = before.filter(row => row.nested)
    for (const row of before.filter(row => row.icon)) {
      near(row.row.h, FRAME.rail.rowPitch, 'row pitch')
      near(row.button.h, FRAME.rail.rowHeight, 'highlight height')
      near(row.icon!.x, row.nested ? parent.label.x : parent.icon!.x, 'icon column')
      if (row.nested) near(row.label.x, nested[0]!.label.x, 'seat label column')
      if (row.mark) { near(row.mark.right, parent.mark!.right, 'trailing rail'); near(row.mark.cy, row.label.cy, 'mark centre'); near(row.mark.w, parent.mark!.w, 'mark slot') }
      if (row.spinner) near(row.spinner.cy, row.label.cy, 'spinner centre')
    }
    near(loose.icon!.x, parent.icon!.x, 'Team and session icon')
    const disclosure = await team.locator('..').locator('[data-left-disclosure] [data-slot="disclosure-chevron"]').boundingBox()
    expect(disclosure!.x + disclosure!.width).toBeLessThanOrEqual(parent.icon!.x + 1)
    for (const row of folded.filter(row => row.icon)) {
      const after = before.find(one => one.name === row.name)!
      near(after.icon!.x, row.icon!.x, 'no icon shift collapsed → expanded')
      near(after.label.x, row.label.x, 'no label shift collapsed → expanded')
      near(after.row.h, row.row.h, 'no height shift collapsed → expanded')
      near(after.rail.right, row.rail.right, 'no trailing shift collapsed → expanded')
    }
    await page.evaluate(() => {
      const { store } = (window as unknown as { __hdSidebarStructure: { store: { getSnapshot(): AppSnapshot; patch(value: Partial<AppSnapshot>): void } } }).__hdSidebarStructure
      const held = store.getSnapshot(), sessions = new Map(held.sessions), teams = new Map(held.teams)
      for (const [key, live] of sessions) if (live.id === 'structure-0') sessions.set(key, { ...live, status: { type: 'idle' }, turns: [] })
      const team = teams.get('structure-team')!
      teams.set(team.id, { ...team, intents: [] })
      store.patch({ sessions, teams })
    })
    await expect(working.locator('[data-slot="spinner"]')).toHaveCount(0)
    const stopped = await measure()
    const labelBefore = before.find(row => row.name === 'Writer 2')!
    const labelAfter = stopped.find(row => row.name === 'Writer 2')!
    near(labelAfter.icon!.x, labelBefore.icon!.x, 'no icon shift after spinner/card disappears')
    near(labelAfter.label.x, labelBefore.label.x, 'no label shift after spinner/card disappears')
    near(labelAfter.row.h, labelBefore.row.h, 'no height shift after spinner/card disappears')
    near(labelAfter.rail.right, labelBefore.rail.right, 'no trailing shift after spinner/card disappears')
    for (const attention of ['New', 'Failed'] as const) {
      await page.evaluate(unread => {
        const { store } = (window as unknown as { __hdSidebarStructure: { store: { getSnapshot(): AppSnapshot; patch(value: Partial<AppSnapshot>): void } } }).__hdSidebarStructure
        const held = store.getSnapshot(), sessions = new Map(held.sessions)
        const entry = [...sessions].find(([, live]) => live.id === 'structure-0')!
        sessions.set(entry[0], { ...entry[1], turns: [{ id: 'geometry-failed' as typeof entry[1]['turns'][number]['id'], status: 'failed', items: [] }] })
        store.patch({ sessions, inbox: unread ? [{ id: 'geometry-news', read: false, at: 1, tone: 'neutral', title: 'Review ready', from: { runtime: entry[1].runtime, sessionId: entry[1].id, name: 'Writer' } }] : [] })
      }, attention === 'New')
      const mark = working.locator('[data-left-mark]')
      await expect(mark).toHaveAttribute('aria-label', attention)
      const rect = (await mark.boundingBox())!
      near(rect.x + rect.width, parent.mark!.right, `${attention} trailing rail`)
      near(rect.y + rect.height / 2, (await working.locator('[data-slot="sidebar-menu-label-content"]').boundingBox())!.y + labelBefore.label.h / 2, `${attention} centre`)
      near((await working.locator('[data-slot="sidebar-menu-label-content"]').boundingBox())!.x, labelBefore.label.x, `${attention} label shift`)
    }
    // Restore activity and its claim to capture the same public fixture in both widths.
    await page.evaluate(() => {
      const { store } = (window as unknown as { __hdSidebarStructure: { store: { getSnapshot(): AppSnapshot; patch(value: Partial<AppSnapshot>): void } } }).__hdSidebarStructure
      const held = store.getSnapshot(), sessions = new Map(held.sessions), teams = new Map(held.teams)
      const entry = [...sessions].find(([, live]) => live.id === 'structure-0')!
      sessions.set(entry[0], { ...entry[1], status: { type: 'active' }, turns: [] })
      const team = teams.get('structure-team')!
      teams.set(team.id, { ...team, intents: [{ id: 4, title: 'Build the checkout retry page', state: 'claimed', claim: { runtime: entry[1].runtime, sessionId: entry[1].id }, dependsOn: [], files: [], createdAt: 1, updatedAt: 1 }] as unknown as typeof team.intents })
      store.patch({ sessions, teams, inbox: [] })
    })
    await expect(working.locator('[data-slot="spinner"]')).toHaveCount(1)
    expect(await fixture.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
    expect(await idle.locator('[data-slot="sidebar-menu-label-content"]').evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true)
    console.log(JSON.stringify({ theme, width, measurement: before, disclosure: { before: foldedParent, after: parent }, spinnerToggle: { before: labelBefore, after: labelAfter } }))
    await page.mouse.move(1000, 0)
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
    if (process.env.SIDEBAR_SEATS_FRAMES) await fixture.screenshot({ path: path.join(process.env.SIDEBAR_SEATS_FRAMES, `sidebar-seats-${theme}-${width}.png`) })
  }
})


for (const theme of ['light', 'dark'] as const) {
  test(`narrow Team labels ellipsize before the shared trailing gap — ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?sidebar-structure&theme=${theme}`)
    const fixture = page.locator('#sidebar-structure')
    await fixture.evaluate(node => { (node as HTMLElement).style.width = '200px' })
    const team = fixture.getByRole('button', { name: 'Room Check release notes', exact: true }).locator('..')
    const value = await team.evaluate(row => {
      const label = row.querySelector<HTMLElement>('[data-slot="sidebar-menu-label-content"]')!
      const rail = row.querySelector('[data-left-trailing]')!.getBoundingClientRect()
      const box = label.getBoundingClientRect()
      return { right: box.right, rail: rail.left, gap: parseFloat(getComputedStyle(row).getPropertyValue('--hd-space-2')), overflow: label.scrollWidth > label.clientWidth, ellipsis: getComputedStyle(label).textOverflow }
    })
    expect(value.right).toBeLessThanOrEqual(value.rail - value.gap + 1)
    expect(value.overflow).toBe(true)
    if (value.overflow) expect(value.ellipsis).toBe('ellipsis')
    console.log(JSON.stringify({ theme, narrowTeam: value }))
  })
  test(`idle Seats reserve the same end slot as loose conversations — ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?sidebar-structure&theme=${theme}`)
    const fixture = page.locator('#sidebar-structure')
    await fixture.evaluate(node => { (node as HTMLElement).style.width = '200px' })
    const inset = async (selector: string) => fixture.locator(selector).first().evaluate(row => {
      const label = row.querySelector('[data-slot="sidebar-menu-label-content"]')!.getBoundingClientRect()
      const rail = row.querySelector('[data-left-trailing]')!.getBoundingClientRect()
      return rail.left - label.right
    })
    const seat = await inset('[data-region="seat-row"]:has-text("Writer with a long seat label")')
    const loose = await inset('[data-region="session-row"]')
    expect(Math.abs(seat - loose)).toBeLessThanOrEqual(1)
    console.log(JSON.stringify({ theme, labelEndGap: { seat, loose } }))
  })
  test(`Team disclosure hit box stays inside the gutter before the highlight — ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?sidebar-structure&theme=${theme}`)
    const fixture = page.locator('#sidebar-structure')
    const team = fixture.getByRole('button', { name: 'Room Ship checkout retry', exact: true })
    const disclosure = team.locator('..').locator('[data-left-disclosure]')
    // The row carries the expanded state; an open Team's chevron stays unfilled until it is hovered.
    await expect(disclosure).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await disclosure.hover()
    const arrow = (await disclosure.boundingBox())!, highlight = (await team.boundingBox())!, sidebar = (await fixture.boundingBox())!
    expect(arrow.x + arrow.width).toBeLessThanOrEqual(highlight.x + 1)
    expect(arrow.x).toBeGreaterThanOrEqual(sidebar.x - 1)
    console.log(JSON.stringify({ theme, chevron: { left: arrow.x, right: arrow.x + arrow.width, highlight: highlight.x, sidebar: sidebar.x } }))
    await page.mouse.move(1000, 0)
  })
}


test('a matching agent filter can fold its Team and captures the public filter and long-label frames', async ({ page }) => {
  await page.goto('/preview.html?sidebar-structure&theme=light')
  await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption('light')
  const fixture = page.locator('#sidebar-structure')
  await page.evaluate(() => {
    const { store } = (window as unknown as { __hdSidebarStructure: { store: { getSnapshot(): AppSnapshot; patch(value: Partial<AppSnapshot>): void } } }).__hdSidebarStructure
    const held = store.getSnapshot()
    store.patch({ listPrefs: { ...held.listPrefs, agent: held.history[0]!.runtime } })
  })
  const team = fixture.getByRole('button', { name: 'Room Ship checkout retry', exact: true })
  await expect(team).toHaveAttribute('aria-expanded', 'true')
  await team.locator('..').locator('[data-left-disclosure]').click()
  await expect(team).toHaveAttribute('aria-expanded', 'false')
  await expect(team.locator('xpath=ancestor::*[@data-region="team-row"]').locator('[data-region="seat-row"]')).toHaveCount(0)
  await page.mouse.move(1000, 0)
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
  if (process.env.SIDEBAR_SEATS_FRAMES) await fixture.screenshot({ path: path.join(process.env.SIDEBAR_SEATS_FRAMES, 'sidebar-seats-filter-folded-320.png') })
  await page.goto('/preview.html?sidebar-structure&theme=light')
  await page.evaluate(() => {
    const { store } = (window as unknown as { __hdSidebarStructure: { store: { getSnapshot(): AppSnapshot; patch(value: Partial<AppSnapshot>): void } } }).__hdSidebarStructure
    const held = store.getSnapshot(), teams = new Map(held.teams), team = teams.get('structure-running-team')!
    teams.set(team.id, { ...team, name: 'Check release notes and validate the deployment' })
    store.patch({ teams })
  })
  const long = page.locator('#sidebar-structure')
  await long.evaluate(node => { (node as HTMLElement).style.width = '200px' })
  const collapsed = long.getByRole('button', { name: 'Room Check release notes and validate the deployment', exact: true })
  await expect(collapsed).toHaveAttribute('aria-expanded', 'false')
  await expect(collapsed.locator('..').locator('[data-slot="spinner"]')).toHaveCount(1)
  await page.mouse.move(1000, 0)
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
  if (process.env.SIDEBAR_SEATS_FRAMES) await long.screenshot({ path: path.join(process.env.SIDEBAR_SEATS_FRAMES, 'sidebar-seats-collapsed-long-200.png') })
})


test('multi-digit card prefixes reserve their intrinsic width without overlapping the Seat label', async ({ page }) => {
  await page.goto('/preview.html?sidebar-structure&theme=light')
  const fixture = page.locator('#sidebar-structure')
  await fixture.evaluate(node => { (node as HTMLElement).style.width = '200px' })
  await page.evaluate(() => {
    const { store } = (window as unknown as { __hdSidebarStructure: { store: { getSnapshot(): AppSnapshot; patch(value: Partial<AppSnapshot>): void } } }).__hdSidebarStructure
    const held = store.getSnapshot(), teams = new Map(held.teams), team = teams.get('structure-team')!
    teams.set(team.id, { ...team, intents: team.intents.map(card => ({ ...card, id: 12345 })) })
    store.patch({ teams })
  })
  const seat = fixture.locator('[data-region="seat-row"]').filter({ hasText: 'Writer 2' })
  const prefix = seat.locator('[data-left-mark-prefix]'), label = seat.locator('[data-slot="sidebar-menu-label-content"]')
  await expect(prefix).toHaveText('#12345')
  const prefixBox = (await prefix.boundingBox())!, labelBox = (await label.boundingBox())!
  expect(labelBox.x + labelBox.width).toBeLessThanOrEqual(prefixBox.x - 8 + 1)
  console.log(JSON.stringify({ cardPrefix: { labelRight: labelBox.x + labelBox.width, prefixLeft: prefixBox.x, prefixWidth: prefixBox.width } }))
})

for (const theme of ['light', 'dark'] as const) test(`unselected Team labels match loose conversations — ${theme}`, async ({ page }) => {
  await page.emulateMedia({ colorScheme: theme })
  await page.goto(`/preview.html?sidebar-structure&theme=${theme}`)
  const fixture = page.locator('#sidebar-structure')
  const team = fixture.getByRole('button', { name: 'Room Check release notes', exact: true })
  const loose = fixture.getByRole('button', { name: 'Release notes', exact: true })
  const ink = (row: typeof team) => row.locator('[data-slot="sidebar-menu-label-content"]').evaluate(node => {
    const css = getComputedStyle(node)
    return { weight: css.fontWeight, buttonWeight: getComputedStyle(node.closest('button')!).fontWeight, color: css.color }
  })
  await expect(team).not.toHaveAttribute('aria-current')
  await expect(loose).not.toHaveAttribute('aria-current')
  expect(await ink(team)).toEqual(await ink(loose))
})
