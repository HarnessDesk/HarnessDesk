#!/usr/bin/env node
// Record actual native-dialog requests without Electron or a real home, then
// preview their content through the design system in the headless harness.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from '@playwright/test'
import { createCommandLineTool, launcherText, MENU_LABEL } from '../../packages/desktop/electron/cli-install.mjs'

const args = process.argv.slice(2)
const flag = (name, fallback) => args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback
const origin = flag('origin', 'http://127.0.0.1:5724')
const output = resolve(flag('out', '/tmp/luna-x1324/frames'))
const scratch = resolve(flag('scratch', '/tmp/luna-x1324'))
// An optional copy of the earlier installer captures changed dialogs before
// the repair, without switching or modifying the working branch.
const before = flag('before', null)
const versions = [
  { prefix: '', api: { createCommandLineTool, launcherText, MENU_LABEL } },
  ...(before ? [{ prefix: 'before-', api: await import(pathToFileURL(resolve(before)).href) }] : []),
]
mkdirSync(scratch, { recursive: true })
mkdirSync(output, { recursive: true })
const root = mkdtempSync(join(scratch, 'cli-dialogs-'))
const scenes = ['installed', 'path-advice', 'unknown-path', 'present', 'removed', 'foreign', 'unavailable', 'failed', 'changed-held', 'recovery-restored', 'recovery-held']
const browser = args.includes('--requests-only') ? null : await chromium.launch({ headless: true })
const recorded = []
try {
  for (const { prefix, api } of versions) {
    const { createCommandLineTool, launcherText, MENU_LABEL } = api
    for (const scene of scenes) {
      if (prefix && !['changed-held', 'recovery-restored', 'recovery-held'].includes(scene)) continue
      const home = join(root, `${prefix}${scene}`)
      const dir = join(home, '.local', 'bin')
      const path = join(dir, 'harnessdesk')
      const app = { runtime: join(home, 'Applications', 'HarnessDesk.app', 'runtime'), entry: join(home, 'Applications', 'HarnessDesk.app', 'bin.js') }
      mkdirSync(dir, { recursive: true })
      mkdirSync(join(home, 'Applications', 'HarnessDesk.app'), { recursive: true })
      if (scene !== 'unavailable') {
        writeFileSync(app.runtime, '', { mode: 0o755 })
        writeFileSync(app.entry, '')
      }
      if (['present', 'removed', 'changed-held', 'recovery-restored', 'recovery-held'].includes(scene)) {
        writeFileSync(path, launcherText({ ...app, runtime: '/Applications/Older/HarnessDesk.app/runtime' }))
      }
      if (scene === 'foreign') writeFileSync(path, '#!/bin/sh\necho another command\n')
      if (scene === 'failed') {
        rmSync(join(home, '.local'), { recursive: true })
        writeFileSync(join(home, '.local'), 'not a folder')
        writeFileSync(join(home, 'bin'), 'not a folder')
      }
      const requests = []
      const tool = createCommandLineTool({
        platform: 'darwin', home, shell: '/bin/zsh', target: () => app,
        loginPath: async () => scene === 'unknown-path' ? null : scene === 'path-advice' ? '/usr/bin:/bin' : dir,
        showDialog: async (request) => { requests.push(request); return scene === 'removed' ? 1 : 0 },
        copyText: () => { throw new Error('frame runner must never copy') },
        hooks: {
          afterCheck: () => {
            if (scene === 'changed-held') { rmSync(path); mkdirSync(path); writeFileSync(join(path, 'inside'), 'another file') }
          },
          afterClaim: ({ path }) => {
            if (scene === 'recovery-held') writeFileSync(path, 'another command')
            if (scene.startsWith('recovery-')) throw new Error('The launcher could not be read.')
          },
        },
      })
      const result = await tool.run()
      const expected = scene === 'present' ? 'kept' : scene === 'removed' ? 'removed'
        : scene === 'foreign' ? 'refused' : scene === 'unavailable' ? 'unavailable'
          : scene === 'changed-held' ? 'changed' : scene === 'failed' || scene.startsWith('recovery-') ? 'failed' : 'installed'
      assert.equal(result.outcome, expected, `wrong scenario: ${scene}`)
      const request = requests.at(-1)
      assert.ok(request, `${scene} emitted no dialog`)
      // The private filename varies by call; retain its shape with a synthetic id.
      request.detail = request.detail.replace(/\.harnessdesk\.\d+\.[0-9a-f-]+\.held/g, '.harnessdesk.1234.00000000-0000-4000-8000-000000000000.held')
      assert.doesNotMatch(JSON.stringify(request), /\/Users\/|@|cli-dialogs-/)
      recorded.push({ scene: `${prefix}${scene}`, request })
      if (!browser) continue
      for (const theme of ['light', 'dark']) {
        const page = await browser.newPage({ viewport: { width: 720, height: 500 }, deviceScaleFactor: 2, colorScheme: theme, reducedMotion: 'reduce' })
        const errors = []
        page.on('pageerror', (error) => errors.push(error.message))
        await page.addInitScript((fixture) => { window.__hdCliInstallDialog = fixture }, { menuLabel: MENU_LABEL, request })
        await page.goto(`${origin}/preview.html?cli-install`)
        const dialog = page.getByRole('dialog', { name: request.message, exact: true })
        await dialog.waitFor({ state: 'visible' })
        await page.evaluate(async () => { await document.fonts.ready })
        assert.equal(await page.locator('#cli-install-detail').textContent(), request.detail)
        assert.deepEqual(await dialog.getByRole('button').allTextContents(), request.buttons)
        assert.equal(await page.locator('body').getAttribute('data-hd-dark-theme') !== null, theme === 'dark')
        assert.deepEqual(errors, [], 'preview errors')
        await page.screenshot({ path: join(output, `${prefix}${scene}-${theme}.png`) })
        await page.close()
      }
    }
  }
  writeFileSync(join(output, 'requests.json'), `${JSON.stringify(recorded, null, 2)}\n`)
  console.log(browser
    ? `${recorded.length * 2} headless dialog-content frames; actual requests, both themes, no native UI or clipboard`
    : `${recorded.length} actual dialog requests recorded; no native UI or clipboard`)
} finally {
  await browser?.close()
  rmSync(root, { recursive: true, force: true })
}
