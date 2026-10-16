import { execFile } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from '@playwright/test'
import { createTemplateRig } from '../../script/shots/template-rig.mjs'
import { serve } from '../../packages/server/dist/src/index.js'

const exec = promisify(execFile)

// Actual host, shipping controls and fake agent processes: no invented publish
// control or real account. Capture the whole dialog, before starting any work.
test('New Team starts an edit-only writer automatically and asks the person to publish after review', async ({ browser }, info) => {
  test.setTimeout(180_000)
  const ui = info.outputPath('renderer')
  await exec('pnpm', ['--filter', '@harnessdesk/ui', 'exec', 'vite', 'build', '--outDir', ui, '--emptyOutDir'], {
    cwd: resolve(import.meta.dirname, '../..'), timeout: 60_000, maxBuffer: 1024 * 1024,
  })
  const home = info.outputPath('home')
  const rig = await createTemplateRig({ home, work: info.outputPath('work'), template: 'fix-and-review', readOnlyReviewer: true, reviewerId: 'claude-code', defaultPreferences: true })
  const server = await serve({ host: rig.host, logger: rig.logger, port: 0, uiRoot: ui })
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
  try {
    await page.goto(`${server.url}/?token=${server.token}`)
    await page.waitForFunction(() => window.__hdStore?.getSnapshot().status === 'open')
    await page.getByRole('button', { name: 'More ways to start', exact: true }).click()
    await page.getByRole('menuitem', { name: /^New Team/ }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: /^Write and review/ }).click()
    await page.getByRole('textbox', { name: 'What should they do?', exact: true }).fill('Repair checkout retry for review')
    const writer = page.getByRole('combobox', { name: 'Agent for Writes', exact: true })
    await expect(writer).toBeEnabled()
    await expect(writer.locator('option:checked')).toHaveText('Automatic · Scripted writer')
    await expect(dialog.getByRole('button', { name: 'Start Team', exact: true })).toBeEnabled()
    const frameDir = process.env.HD_1669_FRAMES
    if (frameDir) await mkdir(frameDir, { recursive: true })
    const photograph = async (name: string) => {
      if (!frameDir) return
      for (const theme of ['light', 'dark']) {
        await page.evaluate(value => window.__hdStore.setTheme(value), theme)
        await expect(dialog).toBeVisible()
        await page.screenshot({ path: join(frameDir, `${name}-${theme}.png`), animations: 'disabled' })
      }
    }
    await photograph('after')
    // An explicit incompatible choice stays selectable and explains its fix
    // next to the row, rather than silently substituting the automatic winner.
    await writer.selectOption('claude-code')
    await expect(dialog).toContainText('Scripted reviewer cannot enforce editing and local commits without publishing. Choose another agent that supports this access.')
    await expect(dialog).toContainText('Resolve the dry-run errors above.')
    await expect(dialog.getByRole('button', { name: 'Start Team', exact: true })).toBeDisabled()
    await photograph('refused-edit')
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.getByRole('button', { name: 'More ways to start', exact: true }).click()
    await page.getByRole('menuitem', { name: /^New Team/ }).click()
    await dialog.getByRole('button', { name: /^Write and review/ }).click()
    await page.getByRole('textbox', { name: 'What should they do?', exact: true }).fill('Repair checkout retry for review')
    await expect(writer.locator('option:checked')).toHaveText('Automatic · Scripted writer')
    await expect(dialog.getByRole('button', { name: 'Start Team', exact: true })).toBeEnabled()
    await dialog.getByRole('button', { name: 'Start Team', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(async () => (await rig.host.call('goal/list', {})).length).toBeGreaterThan(0)
    const goals = await rig.host.call('goal/list', {})
    const goal = goals[0].goal.id
    await expect.poll(async () => (await rig.host.call('goal/read', { goal })).members.length).toBeGreaterThan(0)
    const before = await rig.host.call('goal/read', { goal })
    expect(before.members[0].ceiling).toMatchObject({ level: 'edit', hold: 'held' })
    expect(JSON.parse(await readFile(join(home, 'template-forge.json'), 'utf8')).pr).toBeNull()
    rig.release('writer')
    await expect.poll(async () => (await rig.host.call('goal/read', { goal })).board.intents.some(one => one.role === 'reviewer' && one.state === 'claimed'), { timeout: 30_000 }).toBe(true)
    rig.release('reviewer')
    await expect.poll(async () => (await rig.host.call('goal/read', { goal })).board.intents.some(one => one.role === 'referee' && one.state === 'open'), { timeout: 30_000 }).toBe(true)
    const reviewed = await rig.host.call('goal/read', { goal })
    const handoff = reviewed.board.intents.find(one => one.role === 'referee')!
    expect(handoff.title).toBe('Approve publishing the reviewed change')
    expect(handoff.detail).toContain(rig.git('rev-parse', 'HEAD'))
    expect(handoff.detail).toContain('branch')
    expect(JSON.parse(await readFile(join(home, 'template-forge.json'), 'utf8')).pr).toBeNull()
    expect(rig.errors).toEqual([])
  } finally {
    await page.close()
    await server.close()
    await rig.dispose()
  }
})


test('the edit-first preview records the former blocked grant and the runnable form in both themes', async ({ page }) => {
  const frameDir = process.env.HD_1669_FRAMES
  await page.setViewportSize({ width: 1280, height: 1000 })
  for (const before of [true, false]) {
    for (const theme of ['light', 'dark']) {
      await page.goto(`/front-door-edit.html?theme=${theme}${before ? '&before' : ''}`)
      const dialog = page.getByRole('dialog')
      if (before) await expect(dialog.getByRole('button', { name: 'Start Team', exact: true })).toBeDisabled()
      else await expect(dialog.getByRole('button', { name: 'Start Team', exact: true })).toBeEnabled()
      if (before) await expect(dialog).toContainText('Runtime Alpha cannot enforce publishing changes.')
      else await expect(page.getByRole('combobox', { name: 'Agent for Writes' }).locator('option:checked')).toHaveText('Automatic · Runtime Alpha')
      if (frameDir) {
        await mkdir(frameDir, { recursive: true })
        await page.screenshot({ path: join(frameDir, `${before ? 'before-grant' : 'after-preview'}-${theme}.png`), animations: 'disabled' })
        if (!before) {
          await page.getByRole('combobox', { name: 'Agent for Writes' }).selectOption('claude-code')
          await expect(dialog).toContainText('Runtime Beta cannot enforce editing and local commits without publishing.')
          await expect(dialog.getByRole('button', { name: 'Use Runtime Alpha', exact: true })).toBeVisible()
          await page.screenshot({ path: join(frameDir, `refused-preview-${theme}.png`), animations: 'disabled' })
        }
      }
    }
  }
})
