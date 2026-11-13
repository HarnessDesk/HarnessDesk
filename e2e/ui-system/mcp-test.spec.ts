import { expect, test, type Page } from '@playwright/test'

async function openMcp(page: Page, outcome: 'pass' | 'fail' | 'needsSignIn', theme: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme: theme })
  await page.route('**/src/preview/frames-mcp-test.tsx*', async route => {
    const response = await route.fetch()
    const source = await response.text()
    // Stub the wire of the real AppStore. No replacement Library or test control.
    await route.fulfill({ response, body: `${source}
      const originalMcpRequest = mcpTestStore;
      mcpTestStore = () => {
        const fixture = originalMcpRequest();
        window.__mcpTestCalls = [];
        window.__mcpLoginCalls = [];
        const request = fixture.store.transport.request.bind(fixture.store.transport);
        fixture.store.transport.request = async (method, params) => {
          if (method === 'library/mcp/test') {
            window.__mcpTestCalls.push(params);
            return ${JSON.stringify(outcome === 'pass' ? { ok: true, tools: 12, ms: 40 }
              : outcome === 'fail' ? { ok: false, reason: 'spawnFailed', detail: 'The demo server did not start.', ms: 8 }
              : { ok: false, reason: 'needsSignIn', detail: 'It asks for sign-in.', ms: 8 })};
          }
          return request(method, params);
        };
        fixture.store.mcpLogin = async (name, runtime) => { window.__mcpLoginCalls.push({ name, runtime }); };
        return fixture;
      };
    ` })
  })
  await page.goto(`/preview.html?mcp-test&theme=${theme}`)
  return page.locator('[data-slot="skill-row"]').filter({ hasText: 'Workspace tools' })
}

for (const theme of ['light', 'dark'] as const) {
  for (const width of [1280, 390]) {
    test(`MCP detail passes, fails and offers agent sign-in at ${width}px in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 })
      for (const outcome of ['pass', 'fail', 'needsSignIn'] as const) {
        await page.unrouteAll({ behavior: 'wait' })
        const row = await openMcp(page, outcome, theme)
        await row.getByRole('button', { name: 'Workspace tools', exact: false }).first().click()
        const dialog = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Test connection', exact: true }) })
        await dialog.getByRole('button', { name: 'Test connection', exact: true }).click()
        await expect(dialog.getByText(outcome === 'pass' ? 'Connected · 12 tools' : outcome === 'fail' ? 'Did not start' : 'Needs sign-in', { exact: true })).toBeVisible()
        if (outcome === 'fail') await expect(dialog.getByText('The demo server did not start.', { exact: true })).toBeVisible()
        if (outcome === 'needsSignIn') {
          await dialog.getByRole('button', { name: 'Sign in', exact: true }).click()
          expect(await page.evaluate(() => (window as unknown as { __mcpLoginCalls: unknown[] }).__mcpLoginCalls)).toHaveLength(1)
        }
        expect(await page.evaluate(() => (window as unknown as { __mcpTestCalls: unknown[] }).__mcpTestCalls)).toEqual([
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
      expect(await page.evaluate(() => (window as unknown as { __mcpTestCalls: unknown[] }).__mcpTestCalls)).toHaveLength(1)
    })
  }
}
