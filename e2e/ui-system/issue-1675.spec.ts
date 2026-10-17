import { expect, test } from '@playwright/test'
import { mkdir } from 'node:fs/promises'

const phase = process.env.ISSUE_1675_CAPTURE
for (const theme of ['light', 'dark']) {
  for (const scene of ['team', 'model', 'library', 'library-matrix', 'library-sheet']) {
    for (const width of scene === 'model' ? [1280, 1600] : [1280]) {
      test(`${scene} at ${width} in ${theme}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 })
        await page.goto(`/preview.html?issue-1675=${scene}&team-start=fix-and-review&theme=${theme}`)
        if (scene === 'team') await expect(page.getByRole('dialog')).toBeVisible()
        else await expect(page.locator('[data-slot="page"]:visible, [data-slot="composer-track"]:visible').first()).toBeVisible()
        await page.evaluate(() => document.fonts.ready)
        await expect.poll(() => page.locator('body').evaluate(body => body.hasAttribute('data-hd-dark-theme'))).toBe(theme === 'dark')
        if (scene === 'team') await page.getByLabel('Runtime for Writes', { exact: true }).scrollIntoViewIfNeeded()
        if (scene.startsWith('library')) await expect(page.getByText('code-review', { exact: true }).first()).toBeVisible()
        if (scene === 'library-matrix') {
          await page.getByRole('radio', { name: 'Matrix', exact: true }).click()
        }
        if (scene === 'library-sheet') {
          await page.getByText('code-review', { exact: true }).first().click()
          await expect(page.locator('[data-slot="skill-sheet"]')).toContainText('Read the changed files and their callers before proposing a repair.')
        }
        if (phase) {
          const folder = '/tmp/bugs-1675/frames'
          await mkdir(folder, { recursive: true })
          await page.screenshot({ path: `${folder}/${scene}-${width}-${theme}-${phase}.png` })
        }
        if (phase === 'before') return
        if (scene === 'team') {
          const dialog = page.getByRole('dialog')
          for (const field of ['Runtime', 'Model', 'Effort']) {
            await dialog.getByRole('button', { name: `${field} for Writes`, exact: true }).click()
            await expect(page.getByRole('menu')).toBeVisible()
            if (phase && field === 'Model') await page.screenshot({ path: `/tmp/bugs-1675/frames/team-menu-${theme}-${phase}.png` })
            if (field === 'Model') await expect(page.getByRole('menuitemradio').filter({ hasText: 'Default model' })).toBeVisible()
            await page.keyboard.press('Escape')
            await expect(page.getByRole('menu')).toHaveCount(0)
            await expect(dialog).toBeVisible()
          }
        }
        if (scene === 'model') {
          const track = page.locator('[data-composer-track="model"]:visible').first()
          await expect(track).not.toHaveAttribute('data-folded')
          await expect(track).toContainText('Opus 5.5')
          await expect(track).toContainText('Extra high')
          const clipped = await track.locator('[data-slot="text"]').evaluateAll(nodes => nodes.some(node => node.scrollWidth > node.clientWidth))
          expect(clipped).toBe(false)
          const natural = await track.evaluate(node => {
            const copy = node.cloneNode(true) as HTMLElement
            copy.style.width = 'max-content'; copy.style.position = 'absolute'; copy.style.visibility = 'hidden'
            node.parentElement!.append(copy)
            const width = copy.getBoundingClientRect().width
            copy.remove()
            return Math.abs(width - node.getBoundingClientRect().width) <= 1
          })
          expect(natural).toBe(true)
        }
        if (scene.startsWith('library')) {
          await expect(page.getByText('_hd', { exact: true })).toHaveCount(0)
          const code = scene === 'library-matrix' ? '[data-slot="library-matrix"] code'
            : scene === 'library-sheet' ? '[data-slot="skill-sheet"] code' : '[data-skill-description] code'
          await expect(page.locator(code).filter({ hasText: /^src\/$/ }).first()).toHaveText('src/')
        }
      })
    }
  }
}
