import { expect, test, type Page } from '@playwright/test'

/** Seed only placeholder usage into the real preview's complete window. */
const quotaFixture = async (page: Page) => {
  await page.route('**/src/preview/frame-destination-store.ts*', async route => {
    const response = await route.fetch()
    const source = await response.text()
    const anchor = 'const seed = fixture.getSnapshot();'
    expect(source).toContain(anchor)
    await route.fulfill({ response, body: source.replace(anchor, `${anchor}
      const quotaSnapshot = seed;
      const quotaRuntime = quotaSnapshot.activeRuntime ?? quotaSnapshot.runtimes[0].id;
      Object.assign(quotaSnapshot, {
        activeRuntime: quotaRuntime,
        preferencesLoaded: true,
        noticePolicy: { muted: [], records: {}, seen: [], surfaces: {}, kept: [] },
        health: { state: 'ready' },
        healthByRuntime: { ...quotaSnapshot.healthByRuntime, [quotaRuntime]: { state: 'ready' } },
        account: { accounts: [{ kind: 'oauth', label: 'dev@example.com' }], signInMethods: [] },
        accountsByRuntime: { ...quotaSnapshot.accountsByRuntime, [quotaRuntime]: { accounts: [{ kind: 'oauth', label: 'dev@example.com' }], signInMethods: [] } },
        usage: [{ runtime: quotaRuntime, account: 'dev@example.com', plan: null,
          lanes: [{ id: 'weekly', label: 'Weekly', usedPercent: 40, windowMinutes: 10080, resetsAt: Date.now() + 6.5 * 24 * 3600000, usageKnown: true }],
          credits: null, spend: null, reached: null,
          source: { kind: 'api', label: 'from the preview fixture' },
          fetchedAt: Date.now(), staleAfterMs: 600000, error: null }],
      });`) })
  })
}

for (const theme of ['light', 'dark'] as const) {
  for (const destination of ['conversation', 'dashboard', 'library', 'teams', 'plugins', 'settings-general'] as const) {
    test(`quota prediction: ${destination} ${theme}`, async ({ page }) => {
      await quotaFixture(page)
      await page.emulateMedia({ colorScheme: theme })
      await page.goto(`/preview.html?frame-wall=${destination}&theme=${theme}`)
      const frame = page.locator('[data-frame-id="frame-wall"]')
      await expect(frame).toBeVisible()
      await page.evaluate(async () => { await document.fonts.ready })
      const notice = frame.locator('[data-slot="composer-notice"], [data-slot="notice-strip"]').filter({ hasText: 'will run out before it refills' })
      const warning = frame.getByRole('img', { name: /will run out before it refills/ })
      const account = frame.locator('[data-left-seat] button[title*="will run out before it refills"]')
      if (process.env.QUOTA_FRAME_DIR && ['conversation', 'dashboard', 'library'].includes(destination)) {
        await expect(notice.or(account).first()).toBeVisible()
        await page.screenshot({ path: `${process.env.QUOTA_FRAME_DIR}/${process.env.QUOTA_FRAME_PREFIX ?? 'after'}-${destination}-${theme}.png` })
      }
      if (destination === 'conversation' || destination === 'dashboard') {
        await expect(notice).toHaveCount(1)
        await expect(notice).toBeVisible()
        await expect(warning).toHaveCount(0)
        await expect(notice.getByRole('button', { name: 'Dismiss', exact: true })).toBeVisible()
      } else {
        await expect(notice).toHaveCount(0)
        await expect(warning).toHaveCount(0)
        await expect(account).toBeVisible()
        await expect(account).toHaveAttribute('title', /will run out before it refills\. Weekly runs out in .+, and it resets in /)
      }
    })
  }
}
