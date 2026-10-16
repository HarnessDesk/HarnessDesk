import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) {
  for (const scene of ['signin', 'editor-details', 'editor-closed', 'overview', 'plans'] as const) {
    test(`${scene} small polish in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: 1100, height: 850 })
      await page.emulateMedia({ colorScheme: theme })
      await page.goto(`/preview.html?theme=${theme}`)
      await page.evaluate(async scene => {
        const { mountIssue1634 } = await import('/src/preview/issue-1634-fixture.tsx' as string)
        document.getElementById('root')!.hidden = true
        const host = document.createElement('div')
        host.id = 'issue-1634'
        host.className = 'h-screen'
        document.body.append(host)
        mountIssue1634(host, scene)
        await document.fonts.ready
      }, scene)
      const frame = page.locator('#issue-1634')
      await expect(frame.locator('[data-slot="fixed-shell"]')).toBeVisible()
      if (scene === 'signin') await expect(frame.getByText('Sign in to Alpha', { exact: true })).toBeVisible()
      else if (scene.startsWith('editor-')) await expect(frame.locator('[data-slot="editor-main"]')).toBeVisible()
      else if (scene === 'overview') await expect(frame.getByLabel('What it cost, in brief')).toBeVisible()
      else {
        await expect(frame.getByText('dev@example.com', { exact: true }).first()).toBeVisible()
        await frame.getByRole('button', { name: /dev@example.com/ }).click()
      }
      if (process.env.ISSUE_1634_FRAMES) {
        mkdirSync(process.env.ISSUE_1634_FRAMES, { recursive: true })
        await page.screenshot({ path: path.join(process.env.ISSUE_1634_FRAMES, `${scene}-${theme}.png`) })
      }
      if (scene === 'signin') {
        await expect(frame.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(1)
        await expect(frame.getByRole('button', { name: 'Sign in', exact: true })).toHaveAttribute('data-variant', 'default')
        await expect(frame.getByText('Alpha is not signed in.', { exact: true })).toHaveCount(0)
      } else if (scene.startsWith('editor-')) {
        await expect(frame.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(1)
        await expect(frame.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
        await expect(frame.locator('[data-slot="notice-strip"]')).toContainText('Alpha is not signed in.')
        await frame.locator('[data-work-tool="conversation"]').click()
        await expect(frame.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(1)
        await expect(frame.getByText('Sign in to Alpha', { exact: true })).toBeVisible()
        await expect(frame.locator('[data-slot="notice-strip"]')).toHaveCount(0)
        await frame.locator('[data-work-tool="changes"]').click()
        await expect(frame.locator('[data-slot="notice-strip"]')).toContainText('Alpha is not signed in.')
      } else if (scene === 'overview') {
        await expect(frame.locator('button[title^="Turns"]')).toHaveCount(0)
      } else {
        const card = frame.locator('article').filter({ hasText: 'dev@example.com' })
        await expect(card).toContainText('left · Weekly')
        await expect(card.getByRole('progressbar')).toHaveCount(1)
      }
    })
  }
}
