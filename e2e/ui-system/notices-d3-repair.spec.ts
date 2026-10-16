import { expect, test } from '@playwright/test'

const before = process.env.NOTICES_D3_REPAIR_BEFORE === '1'

for (const theme of ['light', 'dark'] as const) {
  test(`Team wait read and clear survive reconciliation, ${theme}`, async ({ page }) => {
    await page.route('**/src/preview/frame-destination-store.ts*', async route => {
      const response = await route.fetch()
      const source = await response.text()
      expect(source).toContain('return store;')
      await route.fulfill({ response, body: 'import { installNoticesD3Repair } from "/src/preview/notices-d3-repair-fixture.ts";\n' + source.replace('return store;', 'installNoticesD3Repair(store); return store;') })
    })
    // Historical reconciliation, confined to the before frames. The test
    // still drives the production Inbox controls and preference hydration.
    if (before) await page.route('**/src/lib/team-inbox.ts*', async route => {
      const response = await route.fetch()
      const source = await response.text()
      const start = source.indexOf('reconcile(next, previous) {')
      expect(start).toBeGreaterThan(-1)
      const body = source.indexOf('{', start)
      let depth = 1, end = body + 1
      for (; depth; end++) { if (source[end] === '{') depth++; if (source[end] === '}') depth-- }
      const historical = `
        const live = [];
        for (const { team, goal, execution, overview } of teamsInput(next)) {
          if (goal?.goal.state === 'wrapped' || (execution && execution.state !== 'running' && execution.state !== 'stalled')) continue;
          for (const wait of overview.needsYou) {
            const id = JSON.stringify(['team:waiting', team.id, execution?.id, wait.kind, wait.sessionKey ?? null, wait.approval ?? wait.card]);
            const old = next.inbox.find(entry => entry.id === id);
            live.push({ id, kind: 'team:waiting', tone: 'warning', title: team.name, body: wait.summary, at: old?.at ?? wait.since, read: old?.read ?? false, open: 'team:' + team.id });
          }
        }
        return [...live, ...next.inbox.filter(entry => entry.kind !== 'team:waiting')].sort((a, b) => b.at - a.at).slice(0, INBOX_LIMIT);
      `
      await route.fulfill({ response, body: source.slice(0, body + 1) + historical + source.slice(end - 1) })
    })
    await page.setViewportSize({ width: 1100, height: 800 })
    await page.emulateMedia({ colorScheme: theme })
    const openInbox = () => page.locator('[data-slot="inbox-button"]').locator('..').click()
    const load = async () => {
      await page.goto(`/preview.html?frame-wall=conversation&theme=${theme}&notices-d3=waiting`)
      await expect(page.locator('[data-frame-id="frame-wall"]')).toBeVisible()
      await page.evaluate(() => document.fonts.ready)
    }
    const frame = async (scene: string) => {
      if (process.env.NOTICES_D3_REPAIR_FRAMES) await page.screenshot({ path: `${process.env.NOTICES_D3_REPAIR_FRAMES}/${before ? 'before' : 'after'}-${scene}-${theme}.png` })
    }
    await load()
    await page.evaluate(() => (window as unknown as { noticesD3Repair: { reload(): Promise<void> } }).noticesD3Repair.reload())
    await openInbox()
    await expect(page.getByRole('menuitem', { name: /Retry the checkout call/ })).toBeVisible()
    await expect(page.locator('[data-slot="inbox-button"][data-unread]')).toHaveCount(before ? 1 : 0)
    await frame('read-hydration')
    await load()
    await openInbox()
    await page.getByRole('menuitem', { name: 'Clear the inbox', exact: true }).click()
    await page.evaluate(() => (window as unknown as { noticesD3Repair: { replay(): void } }).noticesD3Repair.replay())
    await openInbox()
    if (before) await expect(page.getByRole('menuitem', { name: /Retry the checkout call/ })).toBeVisible()
    else await expect(page.getByText('Nothing kept yet')).toBeVisible()
    await frame('clear')
  })
}
