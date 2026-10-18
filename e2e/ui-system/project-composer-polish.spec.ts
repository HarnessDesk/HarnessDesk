import { expect, test, type Page } from '@playwright/test'
import { openFrame } from './frame-contract-helpers'

test.setTimeout(15_000)

const capture = async (page: Page, name: string) => {
  if (process.env.POLISH_FRAME_DIR) await page.screenshot({ path: `${process.env.POLISH_FRAME_DIR}/${name}.png` })
}

for (const theme of ['light', 'dark'] as const) {
  test(`project menu offers a new worktree without a previous session · ${theme}`, async ({ page }) => {
    await openFrame(page, 'project-polish', theme, 1100)
    const project = page.locator('[data-project-root="/workspace/saved-project"] [data-slot="sidebar-menu-button"]').first()
    await project.click({ button: 'right' })
    await expect(page.getByRole('menu', { name: 'Actions for saved-project' })).toBeVisible()
    await capture(page, `menu-${theme}`)
    const worktree = page.getByRole('menuitem', { name: 'New worktree…', exact: true })
    expect(await worktree.count()).toBe(1)
    await worktree.click()
    expect(await page.evaluate(() => (window as unknown as { projectPolishStore: { getSnapshot(): { newWorktreeFor: string } } }).projectPolishStore.getSnapshot().newWorktreeFor)).toBe('/workspace/saved-project')
  })

  test(`narrow composer folds the action below readable copy and unfolds when widened · ${theme}`, async ({ page }) => {
    await openFrame(page, 'project-polish', theme, 420)
    const notice = page.locator('[data-slot="composer-notice"]')
    await expect(notice).toBeVisible()
    const action = notice.getByRole('button').filter({ hasText: /.+/ }).first()
    const line = notice.locator('[data-slot="notice-message-line"]')
    await capture(page, `notice-${theme}`)
    const textBox = (await line.boundingBox())!
    const actionBox = (await action.boundingBox())!
    expect(actionBox.y).toBeGreaterThanOrEqual(textBox.y + textBox.height)
    expect(textBox.width).toBeGreaterThan(200)
    await page.setViewportSize({ width: 1440, height: 900 })
    await expect.poll(async () => {
      const a = (await action.boundingBox())!, text = (await line.boundingBox())!
      return a.x >= text.x + text.width - 1 && a.y < text.y + text.height
    }).toBe(true)
  })

  for (const width of [1440, 1024]) test(`toast sits above the composer controls at ${width} · ${theme}`, async ({ page }) => {
    await openFrame(page, 'project-polish', theme, width)
    await page.evaluate(() => {
      const store = (window as unknown as { projectPolishStore: { resultNotice(level: string, text: string): void } }).projectPolishStore
      store.resultNotice('info', 'Project saved.')
    })
    const toast = page.locator('[data-sonner-toast]').filter({ hasText: 'Project saved.' })
    await expect(toast).toBeVisible()
    // Sonner's entrance transform settles before the geometry is measured.
    await expect(toast).toHaveAttribute('data-mounted', 'true')
    await expect(toast).toHaveAttribute('data-y-position', 'bottom')
    await capture(page, `toast-${width}-${theme}`)
    const toastBox = (await toast.boundingBox())!
    expect(toastBox.y).toBeGreaterThan(450)
    const composerBox = (await page.locator('[data-slot="composer-dock"]').first().boundingBox())!
    expect(toastBox.y + toastBox.height).toBeLessThan(composerBox.y)
    for (const control of [page.getByRole('button', { name: 'Send', exact: true }), page.locator('[data-composer-track="model"]').getByRole('button').first()]) {
      await expect(control).toBeVisible()
      expect(await control.evaluate(node => {
        const box = node.getBoundingClientRect()
        return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
      }), 'the control remains uncovered').toBe(true)
    }
  })

  test(`expanded toasts grow upward inside the window · ${theme}`, async ({ page }) => {
    await openFrame(page, 'project-polish', theme, 1024)
    await page.evaluate(() => {
      const store = (window as unknown as { projectPolishStore: { resultNotice(level: string, text: string): void } }).projectPolishStore
      for (const text of ['First save.', 'Second save.', 'Third save.']) store.resultNotice('info', text)
    })
    const toasts = page.locator('[data-sonner-toast]')
    await expect(toasts).toHaveCount(3)
    await toasts.first().hover()
    await expect(toasts.first()).toHaveAttribute('data-expanded', 'true')
    const dock = (await page.locator('[data-slot="composer-dock"]').first().boundingBox())!
    const boxes = await toasts.evaluateAll(nodes => nodes.map(node => {
      const { top, bottom } = node.getBoundingClientRect()
      return { top, bottom }
    }))
    for (const box of boxes) {
      expect(box.top).toBeGreaterThanOrEqual(0)
      expect(box.bottom).toBeLessThan(dock.y)
    }
    // Sonner keeps the newest toast at the anchor; the older ones expand up.
    expect(boxes[2]!.bottom).toBeLessThan(boxes[1]!.top)
    expect(boxes[1]!.bottom).toBeLessThan(boxes[0]!.top)
  })
}
