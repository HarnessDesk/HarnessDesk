import { expect, test, type Page } from '@playwright/test'
import { installFramePreviewFixture } from './frame-preview-fixture'
import { FRAME } from '../../packages/ui/src/design/frame'

const toolWall = process.env.FRAME_TOOL_WALL_DIR ?? 'output/frame-wall/tool-bodies'

const resizePanel = async (page: Page, width: number) => {
  const panel = page.locator('[data-slot="work-tools"]')
  const current = (await panel.boundingBox())!.width
  const seam = (await page.getByRole('separator', { name: 'Resize the right panel' }).boundingBox())!
  await page.mouse.move(seam.x + seam.width / 2, seam.y + seam.height / 2)
  await page.mouse.down()
  await page.mouse.move(seam.x + seam.width / 2 + current - width, seam.y + seam.height / 2, { steps: 6 })
  await page.mouse.up()
  await expect.poll(async () => (await panel.boundingBox())!.width).toBe(width)
}

for (const theme of ['light', 'dark'] as const) {
  for (const mode of ['file', 'preview', 'git', 'plugin'] as const) {
    test(`B7a ${mode} remains usable at 320, 400 and 640 in ${theme}`, async ({ page }) => {
      await installFramePreviewFixture(page)
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      const path = mode === 'file' ? '&frame-tool-path=%2Frepo%2FREADME.md' : mode === 'preview' ? '&frame-tool-path=%2Frepo%2Fpreview.html' : ''
      const query = mode === 'file' ? 'frame-wall=conversation&frame-editor-mode=panel' : `frame-wall=conversation&frame-tool=${mode}${path}`
      await page.goto(`/preview.html?${query}&theme=${theme}`)
      const panel = page.locator('[data-slot="work-tools"]')
      if (theme === 'dark') await expect(page.locator('body')).toHaveAttribute('data-hd-dark-theme', '')
      await expect(panel).toBeVisible()
      if (mode === 'file') {
        await expect(panel.getByRole('radio', { name: 'Preview', exact: true })).toBeChecked()
        await panel.getByRole('button', { name: 'Edit', exact: true }).click()
        await expect(panel.locator('.cm-content')).toContainText('Storefront')
      }
      for (const width of [320, 400, 640]) {
        await resizePanel(page, width)
        await expect(panel.locator('[data-slot="tool-pane-header"], [data-slot="card-header"]')).toHaveCount(0)
        expect(await panel.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(false)
        if (mode === 'file') {
          const editor = panel.locator('.cm-content')
          await expect(editor).toHaveAttribute('contenteditable', 'true')
          await editor.fill(`Synthetic document draft ${width} · 長い記録`)
          const save = panel.getByRole('button', { name: 'Unsaved · Save ⌘S', exact: true })
          await expect(save).toBeEnabled()
          await page.locator('[data-work-panel-toggle]').click()
          await expect(editor).toBeHidden()
          await page.locator('[data-work-panel-toggle]').click()
          await expect(editor).toBeVisible()
          await expect(editor).toContainText(`Synthetic document draft ${width}`)
          await save.click()
          await expect(save).toHaveCount(0)
          await expect(editor).toContainText(`Synthetic document draft ${width}`)
        } else if (mode === 'preview') {
          const guest = panel.locator('iframe')
          await expect(guest).toHaveAttribute('sandbox', 'allow-scripts allow-forms allow-popups')
          await expect(guest.contentFrame().getByRole('heading', { name: 'Storefront preview' })).toBeVisible()
          const old = await guest.getAttribute('src')
          await panel.getByRole('radio', { name: 'Source', exact: true }).click()
          await expect(panel.locator('.cm-content')).toHaveAttribute('contenteditable', 'true')
          await panel.getByRole('radio', { name: 'Preview', exact: true }).click()
          await expect.poll(() => guest.getAttribute('src')).not.toBe(old)
          await expect(guest.contentFrame().getByText('Synthetic checkout recovery · 長い記録')).toBeVisible()
          await expect(panel.getByRole('radio', { name: 'Source', exact: true })).toBeEnabled()
        } else if (mode === 'git') {
          const grid = panel.getByRole('grid', { name: 'Commits', exact: true })
          await expect(grid).toBeVisible()
          await expect(grid.getByRole('row')).not.toHaveCount(0)
          const worktrees = (await panel.getByRole('button', { name: /^Worktrees/ }).boundingBox())!
          const branches = (await panel.getByRole('radiogroup', { name: 'Which branches' }).boundingBox())!
          expect(worktrees.y + worktrees.height, `all Git actions clear the search row at ${width}`).toBeLessThanOrEqual(branches.y)
          const search = panel.getByPlaceholder('Search', { exact: true })
          await search.fill('checkout')
          await expect(search).toHaveValue('checkout')
          await search.clear()
          if (width === 640) {
            const toggle = panel.getByRole('button', { name: 'Switch the refs rail', exact: true })
            if (await toggle.getAttribute('data-on') === null) await toggle.click()
            await expect(panel.getByRole('complementary', { name: 'Branches, remotes, tags and stashes' })).toBeVisible()
            await expect(panel.getByPlaceholder('Filter refs', { exact: true })).toBeVisible()
          }
        } else {
          const facts = panel.getByText('Synthetic work facts · 長い記録', { exact: true })
          await facts.scrollIntoViewIfNeeded()
          await expect(facts).toBeInViewport()
          const edge = await facts.evaluate(element => element.getBoundingClientRect().left - element.closest('[data-slot="work-tools"]')!.getBoundingClientRect().left)
          expect(edge, 'contributed prose uses the canonical 16px inset').toBe(16)
          await expect(panel.locator('[data-slot="tool-section"]')).not.toHaveCount(0)
        }
        await expect.poll(async () => page.locator('[data-slot="workbench-main"]').evaluate(main => {
          const edge = main.getBoundingClientRect()
          return [...main.querySelectorAll('[data-slot="composer-tools"] button')].every(button => {
            const box = button.getBoundingClientRect()
            return box.width === 0 || box.left >= edge.left - 0.5 && box.right <= edge.right + 0.5
          })
        }), `${mode}: composer controls stay inside main at ${width}`).toBe(true)
        await page.screenshot({ path: `${toolWall}/${mode}-${width}-${theme}.png` })
      }
    })
  }
  test(`B7a actual Details labels and facts share the card inset in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?frame-wall=conversation&theme=${theme}`)
    await page.locator('[data-work-tool="details"]').click()
    const panel = page.locator('[data-slot="work-tools"]')
    for (const width of [320, 400, 640]) {
      await resizePanel(page, width)
      const edges = await panel.evaluate(element => {
        const label = element.querySelector('[data-slot="tool-section"] [data-slot="group-label"] [data-slot="text"]')!
        const fact = element.querySelector('[data-slot="summary-item"] dt')!
        return [label, fact].map(node => node.getBoundingClientRect().left - element.getBoundingClientRect().left)
      })
      // The rail inset and the card's border precede its own row inset.
      expect(edges).toEqual(Array(2).fill(FRAME.panel.pad + 1 + FRAME.panel.cardPadX))
    }
  })
  test(`B7a terminal carries its actual resource id and synthetic scrollback in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?frame-wall=conversation&frame-terminal=1&theme=${theme}`)
    const terminal = page.locator('[data-terminal-id]')
    await expect(terminal).toHaveCount(1)
    await expect(terminal).toHaveAttribute('data-terminal-id', /.+/)
    await expect(terminal.locator('.xterm')).toBeVisible()
    await expect.poll(() => terminal.innerText()).toContain('storefront')
  })
}
