import { expect, test } from '@playwright/test'
import path from 'node:path'
import type { AppSnapshot } from '../../packages/ui/src/state/store'

for (const theme of ['light', 'dark'] as const) for (const owned of [false, true]) {
  test(`focused docked ${owned ? 'Team' : 'conversation'} stays in a capped project — ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?sidebar-structure&theme=${theme}`)
    await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
    await page.evaluate((owned) => {
      const { store } = (window as unknown as { __hdSidebarStructure: { store: {
        getSnapshot(): AppSnapshot; patch(value: Partial<AppSnapshot>): void
      } } }).__hdSidebarStructure
      const snapshot = store.getSnapshot()
      const seed = snapshot.history[0]!
      const history = Array.from({ length: 8 }, (_, index) => ({ ...seed, id: `docked-${index}` as typeof seed.id,
        title: `Conversation ${index + 1}`, status: { type: 'idle' as const }, updatedAt: 20 - index }))
      const key = `${seed.runtime}\u0000docked-7` as NonNullable<AppSnapshot['activeSessionKey']>
      const main = { ...snapshot.teams.get('structure-team')!, name: 'Main Team', members: [], updatedAt: 30 }
      const owner = { ...main, id: 'docked-team', name: 'Docked Team', members: [key], updatedAt: 1 }
      store.patch({ history, historyIdentity: history, sessions: new Map(), approvals: [], activeSessionKey: key,
        teams: new Map((owned ? [main, owner] : [main]).map(team => [team.id, team])),
        layout: { root: { kind: 'pane', id: 'main', view: { kind: 'room', room: main.id } }, focused: 'main', expanded: null },
      })
    }, owned)
    const fixture = page.locator('#sidebar-structure')
    const project = fixture.locator('[data-project-root="/work/atlas"]')
    const rows = project.locator('[data-virtual-index]')
    await expect(rows).toHaveCount(5)
    if (process.env.SIDEBAR_SELECTION_FRAMES_DIR) await fixture.screenshot({
      path: path.join(process.env.SIDEBAR_SELECTION_FRAMES_DIR, `${process.env.SIDEBAR_SELECTION_FRAME_STATE ?? 'after'}-${owned ? 'team' : 'conversation'}-${theme}.png`),
    })
    const label = owned ? 'Docked Team' : 'Conversation 8'
    await expect(rows.nth(4)).toContainText(label)
    await project.getByRole('button', { name: 'Show more', exact: true }).click()
    await expect(rows).toHaveCount(9)
    await project.getByRole('button', { name: 'Show less', exact: true }).click()
    await expect(rows).toHaveCount(5)
    await expect(rows.nth(4)).toContainText(label)
    await expect(project.getByRole('button', { name: 'Show more', exact: true })).toBeFocused()
  })
}
