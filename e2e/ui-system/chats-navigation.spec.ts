import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { AppStore } from '../../packages/ui/src/state/store'

for (const theme of ['light', 'dark'] as const) {
  test(`a delayed chat open preserves the selected project in ${theme}`, async ({ page }) => {
    await page.route('**/preview.html?chats-navigation*', async route => {
      const response = await route.fetch()
      await route.fulfill({ response, body: (await response.text()).replace('/src/preview/main.tsx', '/src/preview/chats-restoration.tsx') })
    })
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/preview.html?chats-navigation')
    await expect(page.locator('html')).toHaveAttribute('data-chats-ready', 'true')
    await page.evaluate(async () => {
      const context = window as unknown as { chatsStore: AppStore; finishChatOpen: () => Promise<void> }
      const store = context.chatsStore
      const request = store.transport.request.bind(store.transport)
      let release!: () => void
      const ready = new Promise<void>(resolve => { release = resolve })
      let entered!: () => void
      const opening = new Promise<void>(resolve => { entered = resolve })
      store.transport.request = (async (method, params) => {
        if (method === 'workspace/open' && (params as { path: string }).path.startsWith('/demo/chats/')) {
          entered()
          await ready
        }
        return request(method, params)
      }) as typeof store.transport.request
      const starting = store.newSession()
      await opening
      await store.openWorkspace('/demo/project')
      context.finishChatOpen = async () => { release(); await starting }
    })
    const folder = page.locator('[data-composer-track="work-in"]').getByRole('button', { name: 'project', exact: true })
    await expect(folder).toBeVisible()
    const input = page.locator('[data-slot="composer-text"]')
    await input.fill('Keep the selected project')
    await page.evaluate(async () => {
      await (window as unknown as { finishChatOpen: () => Promise<void> }).finishChatOpen()
    })
    await expect(folder).toBeVisible()
    await expect(input).toHaveValue('Keep the selected project')
    expect(await page.evaluate(() => {
      const context = window as unknown as { chatsStore: AppStore }
      const host = JSON.parse(sessionStorage.getItem('chats-restoration-host')!)
      return { renderer: context.chatsStore.getSnapshot().workspace?.path, host: host.workspaces[0].path }
    })).toEqual({ renderer: '/demo/project', host: '/demo/project' })
    await page.evaluate(() => document.fonts.ready)
    if (process.env.CHATS_REPAIR_FRAMES) {
      await page.screenshot({ path: path.join(process.env.CHATS_REPAIR_FRAMES, `after-navigation-${theme}.png`) })
    }
  })
}
