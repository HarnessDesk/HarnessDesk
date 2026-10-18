#!/usr/bin/env node
/** Real host, restricted Lead child, loopback provider and scripted workers.
 * Build first: pnpm build:node && pnpm --filter @harnessdesk/ui build
 * Capture: node script/shots/lead-rig.mjs --out output/lead-rig
 * The default output directory is gitignored. No frame is posted or pushed.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import { serve } from '../../packages/server/dist/src/index.js'
import { createLeadRig } from '../../packages/server/dist/test/fixtures/lead-rig.js'
import { COLLECT, USER, textReasons } from './audit.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const option = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]
}
const out = resolve(option('out', join(root, 'output/lead-rig')))
mkdirSync(out, { recursive: true })
const states = ['planning', 'approval', 'running', 'waiting', 'result', 'stopped', 'error']
const frames = []
let browser
try {
  browser = await chromium.launch({ headless: true })
  for (const state of states) {
    const rig = await createLeadRig({
      scenario: state === 'waiting' ? 'worker-approval' : state === 'error' ? 'interrupted' : 'happy',
      holdPlanning: state === 'planning', holdWorkers: state === 'running' || state === 'stopped',
    })
    let server, page
    try {
      server = await serve({ host: rig.host, logger: rig.logger, port: 0, uiRoot: join(root, 'packages/ui/dist') })
      page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 1, reducedMotion: 'reduce' })
      await page.goto(`${server.url}/?token=${server.token}`)
      await page.waitForFunction(() => window.__hdStore?.getSnapshot().status === 'open')
      await page.locator('[aria-label="Main sections"]').getByRole('button', { name: 'Dex', exact: true }).click()
      await page.getByRole('textbox', { name: 'Goal or message', exact: true }).fill('Repair checkout retry and review both steps')
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      if (state === 'planning') {
        await rig.waitFor(() => rig.provider.requests.length === 1, 'planning request is in flight')
        await expect(page.getByRole('button', { name: 'Sending…', exact: true })).toBeVisible()
      } else if (state === 'error') {
        await rig.waitFor(() => rig.provider.requests.length === 1, 'interrupted request starts')
        await rig.interrupt()
        await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible({ timeout: 30_000 })
        await expect(page.locator('[data-slot="conversation-dock"]')).toContainText('interrupted')
      } else {
        const approve = page.locator('[data-lead-decision-type="plan"]').getByRole('button', { name: 'Approve', exact: true })
        await expect(approve).toBeVisible({ timeout: 30_000 })
        if (state !== 'approval') {
          await approve.click()
          if (state === 'running' || state === 'stopped') {
            await rig.waitFor(() => rig.journal.state.runs.length > 0, 'approved Flow starts')
            await page.waitForFunction(() => window.__hdStore.lead.state.thread?.state === 'running')
          }
          if (state === 'waiting') await expect(page.locator('[data-lead-decision-type="waiting"]').getByRole('button', { name: 'Open approvals', exact: true })).toBeVisible({ timeout: 90_000 })
          if (state === 'result') await expect(page.locator('[data-lead-decision-type="result"]').getByRole('button', { name: 'Accept', exact: true })).toBeVisible({ timeout: 90_000 })
          if (state === 'stopped') {
            await page.getByRole('button', { name: 'Lead settings', exact: true }).click()
            const settings = page.locator('[data-page-destination="settings"]')
            await settings.getByLabel('Dollar allowance', { exact: true }).fill('0')
            await settings.getByRole('button', { name: 'Save allowances', exact: true }).click()
            await rig.waitFor(() => rig.journal.state.phase === 'stopped', 'zero allowance stops dispatch')
            await page.getByRole('button', { name: 'Back', exact: true }).click()
            await page.waitForFunction(() => window.__hdStore.lead.state.thread?.state === 'stopped')
          }
        }
      }
      for (const [width, name] of [[1280, 'reading'], [390, 'narrow']]) for (const theme of ['light', 'dark']) {
        await page.setViewportSize({ width, height: 1000 })
        await page.evaluate(value => {
          const store = window.__hdStore
          store.setTheme(value)
          if (!store.getSnapshot().sidebarCollapsed) store.toggleSidebar()
        }, theme)
        await page.evaluate(async () => { await document.fonts.ready; await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))) })
        const surface = page.locator('[data-page-destination="lead"]')
        await expect(surface).toBeVisible()
        if (state === 'approval') await surface.locator('[data-lead-decision-type="plan"]').scrollIntoViewIfNeeded()
        if (state === 'waiting') await surface.locator('[data-lead-decision-type="waiting"]').scrollIntoViewIfNeeded()
        if (state === 'result') await surface.locator('[data-lead-decision-type="result"]').scrollIntoViewIfNeeded()
        const reasons = textReasons(await page.evaluate(COLLECT), { user: USER })
        if (reasons.length) throw new Error(reasons.join('\n'))
        const filename = `${state}-${name}-${theme}.png`
        await page.screenshot({ path: join(out, filename), animations: 'disabled' })
        frames.push({ file: filename, state, width, theme, journalRevision: rig.journal.state.seq, phase: rig.journal.state.phase, providerRequests: rig.provider.requests.length })
        process.stdout.write(`Captured ${filename}\n`)
      }
    } finally {
      await page?.close()
      await server?.close()
      await rig.dispose()
    }
  }
  writeFileSync(join(out, 'sequence.json'), `${JSON.stringify({ frames }, null, 2)}\n`)
} finally { await browser?.close() }
