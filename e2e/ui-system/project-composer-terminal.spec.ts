import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { Client, start, stop } from '../../packages/server/dist/test/fixtures/harness.js'
import { openFrame } from './frame-contract-helpers'

for (const theme of ['light', 'dark'] as const) {
  test(`Project settings admits its main checkout when only a linked worktree is open · ${theme}`, async ({ page }) => {
    const scratch = await mkdtemp('/tmp/ux-1635-terminal-')
    const project = join(scratch, 'project')
    const worktree = join(scratch, 'feature')
    const state = join(scratch, 'host')
    await mkdir(project)
    await mkdir(state)
    const git = (...args: string[]) => execFileSync('git', ['-C', project, ...args], { stdio: 'ignore' })
    git('init')
    git('-c', 'user.name=Jane Doe', '-c', 'user.email=dev@example.com', 'commit', '--allow-empty', '-m', 'Fixture project')
    git('worktree', 'add', '-b', 'feature', worktree)
    const harness = await start({}, state)
    const client = await Client.connect(harness.server)
    try {
      const opened = await client.call('workspace/open', { path: worktree }) as { repo: { root: string; worktree: boolean } }
      expect(opened.repo.worktree).toBe(true)
      const root = opened.repo.root
      const params = { runtime: harness.runtime.info.id, cwd: root, size: { rows: 24, cols: 80 } }
      await expect(client.call('terminal/open', params)).rejects.toThrow('outside every open workspace')
      await page.exposeFunction('projectTerminalRequest', (method: Parameters<Client['call']>[0], params: unknown) => client.call(method, params))
      // Expose the store the real app mounts, without creating another fixture instance.
      await page.route('**/src/app/App.tsx*', async route => {
        const response = await route.fetch()
        const source = await response.text()
        const declaration = 'const store = useStore('
        expect(source).toContain(declaration)
        await route.fulfill({ response, body: source.replace(declaration, 'const store = window.projectPolishStore = useStore(') })
      })
      await openFrame(page, 'frame-wall=settings&frame-detail=project', theme, 1100)
      await expect(page.locator('[data-page-destination="settings"]:visible')).toHaveCount(1)
      await page.evaluate(async ({ opened, root, runtime }) => {
        const win = window as unknown as {
          projectPolishStore: import('../../packages/ui/src/state/store').AppStore
          projectTerminalRequest: (method: string, params: unknown) => Promise<unknown>
        }
        const store = win.projectPolishStore
        const fixtureRequest = store.transport.request.bind(store.transport)
        store.transport.request = (async (method: string, params: unknown) => {
          if (method === 'workspace/open' || method.startsWith('terminal/')) return win.projectTerminalRequest(method, params)
          return fixtureRequest(method as never, params as never)
        }) as typeof store.transport.request
        Object.assign(store.getSnapshot(), { workspace: opened, activeRuntime: runtime })
        store.openDestination({ kind: 'settings', route: { kind: 'project', root } })
        await store.openTerminal()
      }, { opened, root, runtime: harness.runtime.info.id })
      await expect(page.locator('[data-page-destination="settings"]:visible')).toHaveCount(1)
      if (process.env.POLISH_FRAME_DIR) await page.screenshot({ path: `${process.env.POLISH_FRAME_DIR}/terminal-${theme}.png` })
      await expect(page.locator('[data-terminal-id]')).toHaveCount(1)
      expect(harness.runtime.spawned).toHaveLength(1)
      const selected = await page.evaluate(() => {
        const store = (window as unknown as { projectPolishStore: import('../../packages/ui/src/state/store').AppStore }).projectPolishStore
        const snapshot = store.getSnapshot()
        return { workspace: snapshot.workspace?.path, destination: snapshot.workbench.navigation.current }
      })
      expect(selected.workspace).toBe(worktree)
      expect(selected.destination).toEqual({ kind: 'settings', route: { kind: 'project', root } })
      await expect(client.call('terminal/open', { ...params, cwd: join(scratch, 'unselected') })).rejects.toThrow('outside every open workspace')
    } finally {
      client.close()
      await stop(harness)
      await rm(scratch, { recursive: true, force: true })
    }
  })
}
