import { expect, test } from '@playwright/test'

for (const winner of ['fresh', 'stale'] as const) {
  test(`account footer qualifies the selected ${winner} report`, async ({ page }) => {
    await page.route('**/src/preview/frame-destination-store.ts*', async route => {
      const response = await route.fetch()
      const source = await response.text()
      const marker = 'const seed = fixture.getSnapshot();'
      expect(source).toContain(marker)
      const body = source.replace(marker, `${marker}
        const now = Date.now();
        const runtime = seed.runtimes[0];
        runtime.capabilities = { ...runtime.capabilities, account: false };
        seed.activeRuntime = runtime.id;
        seed.accountsByRuntime = { ...seed.accountsByRuntime, [runtime.id]: { accounts: [], signInMethods: [] } };
        const base = seed.usage.find(r => r.runtime === runtime.id) ?? seed.usage[0];
        seed.usage = [
          { ...base, runtime: runtime.id, account: 'other@example.com', fetchedAt: now - 900000, staleAfterMs: 120000, error: null, reached: null, lanes: [{ id: 'week', label: 'Weekly', usedPercent: 90, windowMinutes: 10080, resetsAt: null }] },
          { ...base, runtime: runtime.id, account: 'chosen@example.com', fetchedAt: now - ${winner === 'fresh' ? '1000' : '900000'}, staleAfterMs: 120000, error: null, reached: null, lanes: [{ id: 'week', label: 'Weekly', usedPercent: 20, windowMinutes: 10080, resetsAt: null }] }
        ];`)
      await route.fulfill({ response, body })
    })
    await page.goto('/preview.html?frame-wall=conversation')
    await page.locator('[data-left-seat] button[aria-haspopup="dialog"]').first().click()
    await page.locator('[role="menuitem"][data-current]').click()
    const seat = page.locator('[role="menuitem"] [data-menu-account-name][data-identity]').filter({ hasText: /Storefront catalogue review and checkout diagnostics/ }).first()
    await expect(seat).toHaveAttribute('data-identity', winner === 'fresh' ? 'Ready' : 'Not checked yet')
  })
}

for (const winner of ['fresh', 'stale'] as const) {
  test(`runtime Settings qualifies the selected ${winner} report`, async ({ page }) => {
    await page.route('**/src/preview/frame-destination-store.ts*', async route => {
      const response = await route.fetch()
      const source = await response.text()
      const marker = 'const seed = fixture.getSnapshot();'
      expect(source).toContain(marker)
      const body = source.replace(marker, `${marker}
        const now = Date.now();
        const runtime = seed.runtimes[0];
        runtime.capabilities = { ...runtime.capabilities, account: true };
        seed.activeRuntime = runtime.id;
        seed.accountsByRuntime = { ...seed.accountsByRuntime, [runtime.id]: { accounts: [{ kind: 'oauth', label: 'chosen@example.com' }], signInMethods: [] } };
        const base = seed.usage.find(r => r.runtime === runtime.id) ?? seed.usage[0];
        seed.usage = [
          { ...base, runtime: runtime.id, account: 'other@example.com', fetchedAt: now - 900000, staleAfterMs: 120000, error: null, reached: null, lanes: [{ id: 'week', label: 'Weekly', usedPercent: 90, windowMinutes: 10080, resetsAt: null }] },
          { ...base, runtime: runtime.id, account: 'chosen@example.com', fetchedAt: now - ${winner === 'fresh' ? '1000' : '900000'}, staleAfterMs: 120000, error: null, reached: null, lanes: [{ id: 'week', label: 'Weekly', usedPercent: 20, windowMinutes: 10080, resetsAt: null }] }
        ];`)
      await route.fulfill({ response, body })
    })
    await page.goto('/preview.html?frame-wall=conversation')
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Runtimes', exact: true }).click()
    const row = page.locator('[data-slot="agent-row"]').filter({ hasText: 'Storefront catalogue review and checkout diagnostics' }).first()
    await expect(row).toBeVisible()
    await expect(row.locator('xpath=ancestor::*[@data-group][1]')).toHaveAttribute('data-group', winner === 'fresh' ? 'Ready' : 'Not checked yet')
  })
}
