import { expect, test, type Page } from '@playwright/test'

type FixtureWindow = Window & { __mcpTest?: { calls: unknown[]; logins: unknown[] } }

async function openMcp(page: Page, outcome: 'pass' | 'fail' | 'needsSignIn', theme: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme: theme })
  await page.goto(`/preview.html?mcp-test&mcp-test-outcome=${outcome}&theme=${theme}`)
  return page.locator('[data-slot="skill-row"]').filter({ hasText: 'Workspace tools' })
}

for (const theme of ['light', 'dark'] as const) {
  for (const width of [1280, 390]) {
    test(`MCP detail passes, fails and offers agent sign-in at ${width}px in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 })
      for (const outcome of ['pass', 'fail', 'needsSignIn'] as const) {
        const row = await openMcp(page, outcome, theme)
        await row.getByRole('button', { name: 'Workspace tools', exact: false }).first().click()
        const dialog = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Test connection', exact: true }) })
        await dialog.getByRole('button', { name: 'Test connection', exact: true }).click()
        await expect(dialog.getByText(outcome === 'pass' ? 'Connected · 12 tools' : outcome === 'fail' ? 'Did not start' : 'Needs sign-in', { exact: true })).toBeVisible()
        if (outcome === 'fail') await expect(dialog.getByText('The demo server did not start.', { exact: true })).toBeVisible()
        if (outcome === 'needsSignIn') {
          await dialog.getByRole('button', { name: 'Sign in', exact: true }).click()
          expect(await page.evaluate(() => (window as FixtureWindow).__mcpTest?.logins)).toHaveLength(1)
        }
        expect(await page.evaluate(() => (window as FixtureWindow).__mcpTest?.calls)).toEqual([
          expect.objectContaining({ name: 'workspace-tools', path: '/home/jane/.claude.json' }),
        ])
      }
    })

    test(`MCP list Test keeps its answer in the row at ${width}px in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 })
      const row = await openMcp(page, 'pass', theme)
      await row.getByRole('button', { name: 'Test', exact: true }).click()
      await expect(row.getByText('Connected', { exact: true })).toBeVisible()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      expect(await row.locator('button button').count()).toBe(0)
      expect(await page.evaluate(() => (window as FixtureWindow).__mcpTest?.calls)).toEqual([
        expect.objectContaining({ name: 'workspace-tools', path: '/home/jane/.claude.json' }),
      ])
    })
  }
}
