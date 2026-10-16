#!/usr/bin/env node
/** Missing project roots on an isolated desk, using the scripted fake agent only. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { chromium, expect } from '@playwright/test'
import { Host, Logger, StateStore, serve } from '../../packages/server/dist/src/index.js'
import { CodexRuntime } from '../../packages/adapter-codex/dist/src/index.js'

mkdirSync('/tmp/gone-rooms', { recursive: true })
const scratch = realpathSync(mkdtempSync('/tmp/gone-rooms/rig-'))
const out = resolve(process.env.ROOM_FOLDERS_FRAMES ?? '/tmp/gone-rooms/frames')
const aliasPhase = process.env.ROOM_FOLDERS_ALIAS_PHASE
mkdirSync(out, { recursive: true })
process.env.HARNESSDESK_HOME = join(scratch, 'home')
const logger = new Logger('room-folders-frames', { level: 'error', console: false })
const host = new Host({ logger, state: new StateStore(join(scratch, 'home/state.json')),
  builtinAgents: join(scratch, 'builtins'), libraryHome: join(scratch, 'person'), catalogRefreshMs: 0 })
const runtime = new CodexRuntime({ binaryPath: resolve('packages/adapter-codex/test/fixtures/fake-codex.mjs'),
  codexHome: join(scratch, 'agent-home') })
host.register(runtime)
let server, browser
try {
  await host.start()
  await runtime.start()
  const current = join(scratch, 'work/storefront')
  const deleted = join(scratch, 'work/completed-clone')
  for (const path of [current, deleted]) mkdirSync(path, { recursive: true })
  await host.call('workspace/open', { path: deleted })
  await host.call('goal/create', { root: deleted, sentence: 'Repair the checkout retry' })
  await host.call('goal/create', { root: deleted, sentence: 'Review the checkout retry' })
  await host.call('workspace/open', { path: current })
  await host.call('goal/create', { root: current, sentence: 'Check the release notes' })
  rmSync(deleted, { recursive: true })
  server = await serve({ host, logger, port: 0, uiRoot: resolve('packages/ui/dist') })
  browser = await chromium.launch({ headless: true })
  for (const before of aliasPhase ? [aliasPhase === 'before'] : [true, false]) {
    const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, reducedMotion: 'reduce' })
    if (before || aliasPhase) await context.routeWebSocket('**/*', socket => {
      const peer = socket.connectToServer()
      peer.onMessage(message => {
        const text = typeof message === 'string' ? message : message.toString()
        const wire = JSON.parse(text)
        if (aliasPhase && Array.isArray(wire.result?.data) && 'nextCursor' in wire.result) {
          wire.result.data = [current, deleted].map((cwd, index) => ({
            id: `clone-${index}`, runtime: runtime.id, title: `Checkout notes ${index + 1}`, preview: null,
            cwd, status: { type: 'notLoaded' }, createdAt: index + 1, updatedAt: index + 1,
            git: { sha: 'x', branch: 'main', originUrl: 'https://acme.dev/storefront.git' }, folderGone: cwd === deleted,
          }))
        }
        // The original before replays the old wire; alias frames use the same
        // measured fixture against builds before and after the repair instead.
        socket.send(JSON.stringify(wire, (key, value) => !aliasPhase && before && key === 'folderGone' ? undefined : value))
      })
    })
    const page = await context.newPage()
    await page.goto(`${server.url}/?token=${server.token}`)
    await page.waitForFunction(() => window.__hdStore?.getSnapshot().teams.size === 3).catch(async error => {
      console.log(await page.locator('body').innerText())
      console.log(await page.evaluate(() => { const s = window.__hdStore?.getSnapshot(); return s && { status: s.status, teams: s.teams.size, goals: s.goals.size, problem: s.goalProblem, notices: s.notices } }))
      throw error
    })
    await page.evaluate(() => {
      window.__hdStore.setOthersOpen(true)
      window.__hdStore.dismissStanding({ key: 'import:offer', kind: 'import:offer', lifetime: 'once' })
    })
    await expect(page.getByText('Skills and servers to share', { exact: true })).toHaveCount(0)
    const tree = page.locator('[data-region="session-tree"]:visible')
    if (aliasPhase) {
      await page.waitForFunction(() => window.__hdStore.getSnapshot().history.length === 2)
      await expect(tree.locator('[data-project-root]')).toHaveCount(1)
    }
    if (before) await expect(tree.getByRole('button', { name: 'Room Repair the checkout retry', exact: true })).toBeInViewport()
    else {
      await expect(tree.locator('[data-project-root]').filter({ hasText: 'completed-clone' })).toHaveCount(0)
      await expect(tree.locator('[data-region="gone-folders"]')).toContainText('1 folder is gone')
      await expect(tree.locator('[data-region="gone-folders"]')).toBeInViewport()
      await expect(tree.getByRole('button', { name: 'Room Repair the checkout retry', exact: true })).toHaveCount(0)
    }
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => window.__hdStore.setTheme(value), theme)
      await expect.poll(() => page.locator('body').evaluate(body => body.hasAttribute('data-hd-dark-theme'))).toBe(theme === 'dark')
      const visible = await page.locator('body').innerText()
      assert.ok(!visible.includes('/Users/'), 'frames must not contain machine paths')
      for (const address of visible.match(/[\w.+-]+@[\w.-]+/g) ?? []) assert.match(address, /@(example\.com|acme\.dev|harnessdesk\.app)$/)
      await page.screenshot({ animations: 'disabled', path: join(out, `${aliasPhase ? 'alias-' : ''}${before ? 'before' : 'after'}-${theme}.png`) })
    }
    if (!before) {
      await tree.getByRole('button', { name: '1 folder is gone', exact: true }).click()
      await page.getByRole('menuitem', { name: /^Forget 1 folder/ }).click()
      await expect(tree.locator('[data-region="gone-folders"]')).toHaveCount(0)
      const kept = await host.call('goal/list', {})
      assert.equal(kept.length, 3, 'Forget keeps every Goal')
      assert.equal(kept.filter(view => view.board.folderGone).length, 2)
      await page.getByRole('button', { name: 'Teams', exact: true }).click()
      await expect(page.getByText('Repair the checkout retry', { exact: true }).first()).toBeVisible()
    }
    await context.close()
  }
  console.log(aliasPhase === 'before' ? 'PASS: alias regression reproduced on the previous UI build, in both themes'
    : 'PASS: fake-agent frames; missing roots hidden; Forget preserves all three Goals and Teams still reaches the missing-root work')
} finally {
  await browser?.close()
  await server?.close()
  await host.dispose()
}
