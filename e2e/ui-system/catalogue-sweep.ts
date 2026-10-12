import {readFileSync} from 'node:fs'
import { test, type Page, type BrowserContextOptions } from '@playwright/test'

/** Independent page cases share only the inventory union and a synthetic browser. */
export const cataloguePageCases = (title: string, register: (getPage: () => Page) => void, options: BrowserContextOptions = {}): void => {
  test.describe(title, () => {
    test.describe.configure({ mode: 'default' })
    let page: Page
    test.beforeAll(async ({ browser }, info) => {
      page = await browser.newPage({ baseURL: String(info.project.use.baseURL), viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce', ...options })
    })
    test.beforeEach(async () => { await page.bringToFront() })
    register(() => page)
    test.afterAll(async () => { await page?.context().close() })
  })
}

export const PAGE_ITEMS = JSON.parse(readFileSync(new URL('./preview-page-items.json', import.meta.url), 'utf8')) as {
  frames: { selector: string; id: string; title: string }[]
  boards: string[]
  placement: string[]
}
