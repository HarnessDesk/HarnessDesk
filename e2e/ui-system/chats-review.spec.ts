import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'

const open = async (page: Page, theme: 'light' | 'dark', scene = '') => {
  await page.route('**/preview.html?chats-review*', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, body: (await response.text()).replace('/src/preview/main.tsx', '/src/preview/chats-review.tsx') })
  })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.emulateMedia({ colorScheme: theme })
  await page.goto(`/preview.html?chats-review&scene=${scene}`)
  await expect(page.locator('html')).toHaveAttribute('data-chats-ready', 'true')
}
const frame = async (page: Page, name: string) => {
  if (!process.env.CHATS_REVIEW_FRAMES) return
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: path.join(process.env.CHATS_REVIEW_FRAMES, `${name}.png`) })
}

for (const theme of ['light', 'dark'] as const) {
  test(`late preferences leave an unsaved chat at No folder in ${theme}`, async ({ page }) => {
    await open(page, theme)
    await expect(page.getByRole('button', { name: 'No folder', exact: true })).toBeVisible()
    expect(await page.evaluate(() => (window as unknown as { chatsStore: { getSnapshot: () => { workspaces: { path: string }[] } } }).chatsStore.getSnapshot().workspaces.map(one => one.path))).toContain('/demo/project')
    await frame(page, `startup-${theme}`)
  })

  test(`Settings refuses a chats location containing a project in ${theme}`, async ({ page }) => {
    await open(page, theme, 'settings')
    await page.getByRole('button', { name: 'Change…', exact: true }).click()
    await page.getByRole('button', { name: 'Open “demo”', exact: true }).click()
    const refusal = page.getByText('Chats folder contains an opened project.', { exact: true })
    await expect(refusal).toHaveCount(1)
    await expect(page.getByRole('dialog').getByText('Chats folder contains an opened project.', { exact: true })).toBeVisible()
    await frame(page, `refusal-${theme}`)
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(refusal).toHaveCount(0)
    await expect(page.getByText('Chats folder', { exact: true })).toBeVisible()
    expect(await page.evaluate(() => (window as unknown as { chatsStore: { getSnapshot: () => { chatsFolder: string } } }).chatsStore.getSnapshot().chatsFolder)).toBe('/demo/chats')
    await frame(page, `settings-${theme}`)
    await page.getByRole('button', { name: 'Change…', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(refusal).toHaveCount(0)
    // Hold this picker request so its refusal arrives after the picker closes.
    await page.evaluate(() => {
      const fixture = window as unknown as { chatsStore: { transport: { request: (method: string, params: unknown) => Promise<unknown> } }; rejectChats?: () => void }
      const transport = fixture.chatsStore.transport
      const original = transport.request.bind(transport)
      transport.request = (method, params) => method === 'app/state/set'
        ? new Promise((_resolve, reject) => { fixture.rejectChats = () => reject(new Error('Late chats refusal')) })
        : original(method, params)
    })
    await page.getByRole('button', { name: 'Open “demo”', exact: true }).click()
    await expect.poll(() => page.evaluate(() => typeof (window as unknown as { rejectChats?: () => void }).rejectChats)).toBe('function')
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.evaluate(() => (window as unknown as { rejectChats: () => void }).rejectChats())
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByText('Late chats refusal', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Change…', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.getByText('Late chats refusal', { exact: true })).toHaveCount(0)
    await expect(refusal).toHaveCount(0)
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(await page.evaluate(() => {
      const { chatsFolder, chatsFolderProblem } = (window as unknown as { chatsStore: { getSnapshot: () => { chatsFolder: string; chatsFolderProblem: string | null } } }).chatsStore.getSnapshot()
      return { chatsFolder, chatsFolderProblem }
    })).toEqual({ chatsFolder: '/demo/chats', chatsFolderProblem: null })
  })

  test(`Settings lists projects while omitting managed chats in ${theme}`, async ({ page }) => {
    await open(page, theme, 'folders')
    await expect(page.getByRole('heading', { name: 'Folders · 1', exact: true })).toBeVisible()
    await expect(page.getByText('Managed chat', { exact: true })).toHaveCount(0)
    await frame(page, `folders-${theme}`)
  })

  test(`a repository recovers its worktree control without opening that control in ${theme}`, async ({ page }) => {
    await open(page, theme, 'repository')
    const control = page.getByTitle('Starts in a new worktree on its own branch, made when you send', { exact: true })
    await expect(control).toBeVisible()
    await control.click()
    await expect(page.getByRole('menuitemradio', { name: 'New worktree…', exact: true })).toBeVisible()
    await frame(page, `worktree-${theme}`)
  })
}
