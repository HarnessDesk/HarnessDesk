import { expect, test } from '@playwright/test'
import { keepRuntimeInboxEntry, mergeNoticePreferences } from '../../packages/server/src/runtime-notices'
import type { RuntimeInboxEntry } from '@harnessdesk/protocol'

test.use({ viewport: { width: 1100, height: 800 }, colorScheme: process.env.NOTICE_FRAME_THEME === 'dark' ? 'dark' : 'light' })
for (const scene of ['startup', 'inbox', 'conversation', 'settings']) {
  test(`quiet messages: ${scene}`, async ({ page }) => {
    await page.goto(`/preview.html?notices=${scene}`)
    const frame = page.locator(`[data-frame-id="notices-${scene}"]`)
    await expect(frame).toBeVisible()
    await expect(page.locator('[data-slot="inbox-button"][data-unread]')).toHaveCount(1)
    const before = process.env.NOTICE_FRAME_PREFIX === 'before'
    if (scene === 'inbox') {
      await page.locator('[data-slot="inbox-button"]').locator('..').click()
      if (!before) await page.getByRole('button', { name: /ignored 2 settings/ }).click()
    }
    if (!before) {
      const dot = page.locator('[data-slot="inbox-dot"]')
      const box = await dot.boundingBox()
      expect(box?.width).toBe(box?.height)
    }
    if (!before && scene === 'conversation') await expect(frame.getByText('Context was compacted to make room for more of this conversation.')).toBeVisible()
    if (process.env.NOTICE_FRAME_DIR) {
      await page.screenshot({ fullPage: scene === 'settings', path: `${process.env.NOTICE_FRAME_DIR}/${process.env.NOTICE_FRAME_PREFIX ?? 'after'}-${scene}-${process.env.NOTICE_FRAME_THEME ?? 'light'}.png` })
    }
    if (before) return
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(0)
    if (scene === 'startup') await expect(page.locator('[data-slot="inbox-button"][data-unread]')).toHaveCount(1)
    if (scene === 'conversation') await expect(frame.getByText('Context was compacted to make room for more of this conversation.')).toBeVisible()
    if (scene === 'inbox') {
      const inbox = page.locator('[data-slot="inbox-list"]')
      await expect(inbox.getByText('×3')).toBeVisible()
      const title = inbox.getByRole('button', { name: /ignored 2 settings/ })
      expect(await title.evaluate(element => element.getBoundingClientRect().height <= parseFloat(getComputedStyle(element).lineHeight) + 1)).toBe(true)
      await expect(inbox.locator('[data-part="inbox-full-title"]')).toHaveText(/ignored 2 settings/)
      await expect(inbox.getByText('Ignored configuration settings', { exact: false })).toBeVisible()
      await expect(inbox.getByText('~/.codex/config.toml', { exact: false })).toBeVisible()
      await inbox.getByRole('button', { name: 'Open the file' }).click()
      expect(await page.evaluate(() => (window as unknown as { noticeReveals: unknown[] }).noticeReveals)).toEqual([{ path: '/Users/user/.codex/config.toml' }])
      await inbox.getByRole('button', { name: "Don't show this again" }).click()
      await expect(inbox.getByRole('button', { name: "Don't show this again" })).toHaveCount(0)
      await inbox.getByRole('button', { name: 'Mark all read' }).click()
      await expect(page.locator('[data-slot="inbox-button"][data-unread]')).toHaveCount(0)
    }
    if (scene === 'settings') {
      await expect(page.getByLabel('Where "Configuration warnings" is shown')).toHaveValue('inbox')
      await page.getByLabel('Where "Configuration warnings" is shown').selectOption('off')
      await expect(page.getByLabel('Where "Configuration warnings" is shown')).toHaveValue('off')
    }
  })
}


test('expanded title-only Inbox guidance wraps completely inside the panel', async ({ page }) => {
  await page.goto('/preview.html?notices=inbox&longNotice=1')
  await page.locator('[data-slot="inbox-button"]').locator('..').click()
  const inbox = page.locator('[data-slot="inbox-list"]')
  const title = inbox.getByRole('button', { name: /background configuration warning/ })
  expect(await title.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true)
  await title.click()
  const full = inbox.locator('[data-part="inbox-full-title"]')
  await expect(full).toHaveText(/including the final instruction: check the configuration file before the next run\.$/)
  expect(await full.evaluate(element => {
    const panel = element.closest('[data-slot="inbox-list"]')!.getBoundingClientRect()
    const rect = element.getBoundingClientRect()
    return rect.height > parseFloat(getComputedStyle(element).lineHeight) && element.scrollWidth <= element.clientWidth && rect.right <= panel.right && rect.left >= panel.left
  })).toBe(true)
  if (process.env.NOTICE_FRAME_DIR) await page.screenshot({ path: `${process.env.NOTICE_FRAME_DIR}/after-inbox-long-${process.env.NOTICE_FRAME_THEME ?? 'light'}.png` })
})


test('the receiving window reflects another window read, clear and mute, and stale interaction stays cleared', async ({ page }) => {
  let preferences: Record<string, unknown> = {}
  await page.exposeFunction('noticeHost', (method: string, params: { entry?: RuntimeInboxEntry; patch?: Record<string, unknown>; noticeBase?: Record<string, unknown> }) => {
    if (method === 'app/inbox/keepInfo') {
      const patch = keepRuntimeInboxEntry(preferences, params.entry!)
      if (patch) preferences = { ...preferences, ...patch }
    } else if (method === 'app/state/set') preferences = { ...preferences, ...mergeNoticePreferences(preferences, params.patch!, params.noticeBase) }
    return preferences
  })
  await page.goto('/preview.html?notices=inbox')
  await expect(page.locator('[data-slot="inbox-button"][data-unread]')).toHaveCount(1)
  await page.evaluate(async () => {
    const modulePath = '/src/state/store.ts'
    const { AppStore } = await import(/* @vite-ignore */ modulePath)
    const surface = window as unknown as { noticeStore: InstanceType<typeof AppStore>; noticeOther: InstanceType<typeof AppStore>; noticeHost: (method: string, params: unknown) => Promise<unknown>; noticePush: (target: InstanceType<typeof AppStore>, n: number, message?: string) => void; noticeRow: string }
    const second = surface.noticeStore
    const snapshot = second.getSnapshot()
    const background = { workbench: snapshot.workbench, layout: snapshot.layout, activeSessionKey: snapshot.activeSessionKey }
    const first = new AppStore('ws://localhost:0/')
    const fallback = second.transport.request.bind(second.transport)
    const transport = (method: string, params: unknown) => ['app/state/get', 'app/state/set', 'app/inbox/keepInfo'].includes(method) ? surface.noticeHost(method, params) : fallback(method, params)
    first.transport.request = transport
    second.transport.request = transport
    surface.noticeOther = first
    await first.loadPreferences()
    await second.loadPreferences()
    Object.assign(second.getSnapshot(), background)
    surface.noticePush = (target, n, message = 'Shared configuration warning') => target.transport.handlers.onEvent('codex', { type: 'notice', class: 'info', kind: 'runtime:warning', level: 'warning', message, id: `shared-${n}`, at: Date.now() + n, count: message === 'Shared configuration warning' ? n : 1 })
    surface.noticePush(first, 1)
    surface.noticePush(second, 1)
  })
  await expect.poll(() => page.evaluate(() => (window as any).noticeStore.getSnapshot().inbox.length)).toBe(1)
  await page.locator('[data-slot="inbox-button"]').locator('..').click()
  await expect(page.getByRole('button', { name: /Shared configuration warning/ })).toBeVisible()
  await page.evaluate(() => {
    const w = window as any
    w.noticeRow = w.noticeStore.getSnapshot().inbox.find((entry: { title: string }) => entry.title.includes('Shared configuration warning')).id
    w.noticeOther.markInboxRead(w.noticeRow)
  })
  await expect.poll(() => (preferences['inbox'] as { read: boolean }[])[0]?.read).toBe(true)
  await page.evaluate(() => { const w = window as any; w.noticePush(w.noticeStore, 2) })
  await expect(page.locator('[data-slot="inbox-button"][data-unread]')).toHaveCount(0)
  // A different message is unread, so opening its stale row really sends a read.
  await page.evaluate(() => { const w = window as any; w.noticePush(w.noticeOther, 3, 'Shared configuration warning changed'); w.noticePush(w.noticeStore, 3, 'Shared configuration warning changed') })
  await expect(page.getByRole('button', { name: /Shared configuration warning changed/ })).toBeVisible()
  await expect.poll(() => (preferences['inbox'] as unknown[]).length).toBe(2)
  // Clear and mute in the first window, then interact with the still-cached row.
  await page.evaluate(() => { const w = window as any; w.noticeOther.clearInbox(); w.noticeOther.setNoticeMuted('runtime:warning', true) })
  await expect.poll(() => preferences['inbox']).toEqual([])
  await page.getByRole('button', { name: /Shared configuration warning changed/ }).click()
  await expect(page.getByRole('button', { name: /Shared configuration warning/ })).toHaveCount(0)
  expect(preferences['inbox']).toEqual([])
  await page.evaluate(() => { const w = window as any; w.noticePush(w.noticeStore, 4, 'Shared configuration warning changed') })
  await expect.poll(() => page.evaluate(() => (window as any).noticeStore.getSnapshot().noticePolicy.muted)).toContain('runtime:warning')
  await expect(page.locator('[data-slot="inbox-button"][data-unread]')).toHaveCount(0)
  if (process.env.NOTICE_FRAME_DIR) await page.screenshot({ path: `${process.env.NOTICE_FRAME_DIR}/after-inbox-cleared-${process.env.NOTICE_FRAME_THEME ?? 'light'}.png` })
})
