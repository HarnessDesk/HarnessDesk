import { expect, test } from '@playwright/test'
import type { AppSnapshot } from '../../packages/ui/src/state/store'
import { goneRoomFoldersCase } from '../../packages/ui/src/preview/gone-room-folders-fixture'

for (const theme of ['light', 'dark']) test(`room-only missing folders stay out of projects and are counted in ${theme}`, async ({ page }) => {
  await page.goto(`/preview.html?sidebar-structure&theme=${theme}`)
  await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
  await page.evaluate(({ root, deleted, teams }) => {
    const { store } = (window as unknown as { __hdSidebarStructure: { store: {
      getSnapshot(): AppSnapshot; patch(snapshot: Partial<AppSnapshot>): void
    } } }).__hdSidebarStructure
    store.patch({ teams: new Map(teams.map(team => [team.id, team])), goals: new Map(),
      history: [], historyIdentity: [], sessions: new Map(), activeSessionKey: null, approvals: [], inbox: [],
      workspace: { path: root, name: 'storefront', lastOpenedAt: 1 },
      workspaces: [{ path: root, name: 'storefront', lastOpenedAt: 1 }],
      foldersGone: new Map([[deleted, 'This project folder no longer exists.']]),
      listPrefs: { ...store.getSnapshot().listPrefs, pinned: [], pinnedSessions: [], collapsed: [], othersOpen: true, forgottenFolders: [] },
    })
  }, goneRoomFoldersCase)
  const tree = page.locator('#sidebar-structure [data-region="session-tree"]')
  await expect(tree.locator('[data-project-root="/work/completed-clone"]')).toHaveCount(0)
  await expect(tree.getByRole('button', { name: 'Room Check the release notes', exact: true })).toBeVisible()
  await expect(tree.locator('[data-region="gone-folders"]')).toHaveText('1 folder is gone')
})
