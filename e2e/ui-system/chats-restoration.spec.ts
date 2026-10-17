import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { AppStore } from '../../packages/ui/src/state/store'

const open = async (page: Page, theme: 'light' | 'dark') => {
  await page.route('**/preview.html?chats-restoration*', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, body: (await response.text()).replace('/src/preview/main.tsx', '/src/preview/chats-restoration.tsx') })
  })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.emulateMedia({ colorScheme: theme })
  await page.goto('/preview.html?chats-restoration')
  await expect(page.locator('html')).toHaveAttribute('data-chats-ready', 'true')
}

for (const theme of ['light', 'dark'] as const) {
  test(`a fresh chat restores its transcript after restart in ${theme}`, async ({ page }) => {
    await open(page, theme)
    await page.locator('[data-slot="composer-text"]').fill('Plan a weekend project')
    await page.locator('[data-slot="composer-send"]').click()
    const answer = page.getByRole('paragraph').filter({ hasText: 'Start with a small prototype, then check the result.' })
    await expect(answer).toBeVisible()
    await expect.poll(() => page.evaluate(() => {
      const host = JSON.parse(sessionStorage.getItem('chats-restoration-host')!)
      return Object.keys(host.preferences.layouts ?? {})
    })).toEqual(['/demo/chats/2026-10-16-chat-1'])
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-chats-ready', 'true')
    await expect(answer).toBeVisible()
    await expect(page.getByText('Projects', { exact: true })).toBeVisible()
    await page.evaluate(() => document.fonts.ready)
    if (process.env.CHATS_REPAIR_FRAMES) await page.screenshot({ path: path.join(process.env.CHATS_REPAIR_FRAMES, `after-restart-${theme}.png`) })
  })

  test(`suggested tasks from chats allocate distinct folders in ${theme}`, async ({ page }) => {
    await open(page, theme)
    const paths = await page.evaluate(async () => {
      const store = (window as unknown as { chatsStore: AppStore }).chatsStore
      const source = await store.newSession()
      const sender = store.getSnapshot().sessions.get(source!)!
      store.keep({ id: 'suggestion', title: 'Next task', tone: 'info', at: 3, task: 'Explain a retry budget',
        from: { runtime: sender.runtime, sessionId: sender.id, name: 'Source chat' } })
      await store.openWorkspace('/demo/project')
      await store.startSuggestedTask('suggestion')
      const target = store.getSnapshot().sessions.get(store.getSnapshot().activeSessionKey!)!
      return [sender.cwd, target.cwd]
    })
    expect(paths).toEqual(['/demo/chats/2026-10-16-chat-1', '/demo/chats/2026-10-16-chat-2'])
  })
}
