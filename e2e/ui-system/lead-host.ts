import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, type Browser, type Page } from '@playwright/test'
import { serve } from '../../packages/server/dist/src/index.js'
import { createLeadRig } from '../../packages/server/dist/test/fixtures/lead-rig.js'

export const buildLeadRenderer = async (directory: string) => {
  await promisify(execFile)('pnpm', ['--filter', '@harnessdesk/ui', 'exec', 'vite', 'build', '--outDir', directory, '--emptyOutDir'], {
    cwd: resolve(import.meta.dirname, '../..'), timeout: 90_000, maxBuffer: 1024 * 1024,
  })
}

export const bounded = async <T>(label: string, operation: () => Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>
  try { return await Promise.race([operation(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 15_000) })]) }
  finally { clearTimeout(timer!) }
}

/** Every window talks to the shipping host; only the rig's external services are synthetic. */
export const openLeadHost = async (browser: Browser, uiRoot: string, options: Parameters<typeof createLeadRig>[0] = {}) => {
  const rig = await createLeadRig(options)
  const server = await serve({ host: rig.host, logger: rig.logger, port: 0, uiRoot })
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, reducedMotion: 'reduce' })
  const visit = async (target: Page) => {
    await target.goto(`${server.url}/?token=${server.token}`)
    await target.waitForFunction(() => (window as any).__hdReady !== undefined, null, { timeout: 10_000 })
    // Socket-open precedes preferences and workspace restoration, which can
    // replace a destination clicked during startup. Wait for the sitting.
    await bounded('renderer startup restoration', () => target.evaluate(() => (window as any).__hdReady))
  }
  const close = async () => {
    try {
      if (!page.isClosed()) { await bounded('renderer transport shutdown', () => page.evaluate(() => (window as any).__hdStore.transport.close())); await bounded('renderer page close', () => page.close()) }
    } finally { try { await bounded('loopback server close', () => server.close()) } finally { await bounded('isolated Lead rig disposal', () => rig.dispose()) } }
  }
  try { await visit(page); return { rig, server, page, visit, close } }
  catch (error) { await close(); throw error }
}

export const openLead = async (page: Page, theme: 'light' | 'dark' = 'light') => {
  await page.evaluate(value => (window as any).__hdStore.setTheme(value), theme)
  await page.locator('[aria-label="Main sections"]').getByRole('button', { name: 'Dex', exact: true }).click()
  await expect(page.locator('[data-page-destination="lead"] [data-slot="conversation-shell"]')).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Goal or message', exact: true })).toBeVisible()
}

export const sendLeadGoal = async (page: Page) => {
  await page.getByRole('textbox', { name: 'Goal or message', exact: true }).fill('Repair checkout retry and review both steps')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
}
