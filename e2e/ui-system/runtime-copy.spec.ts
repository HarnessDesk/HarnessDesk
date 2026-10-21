import fs from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { openFrame } from './frame-contract-helpers'
import { RUNTIME_COPY_SCENES } from '../../packages/ui/src/preview/runtime-copy-fixture'

// These frames use only the preview's synthetic desk. Capture before asserting
// so a failing baseline also supplies the original view for the copy review.
const frame = async (page: Page, name: string, theme: string) => {
  if (!process.env.RUNTIME_COPY_FRAMES) return
  await fs.mkdir(process.env.RUNTIME_COPY_FRAMES, { recursive: true })
  await page.screenshot({ path: `${process.env.RUNTIME_COPY_FRAMES}/${name}-${theme}.png` })
}
for (const theme of ['light', 'dark'] as const) {
  test(`runtime picker and disabled tools use precise nouns in ${theme}`, async ({ page }) => {
    await openFrame(page, RUNTIME_COPY_SCENES.draft, theme)
    const picker = page.locator('[data-composer-track="agent"] button').first()
    await expect(picker).toBeVisible()
    await picker.click()
    await frame(page, 'composer', theme)
    await expect(picker).toHaveAttribute('title', /Which runtime starts this conversation/)
    await page.keyboard.press('Escape')
    const conversation = page.getByRole('button', { name: 'Conversation mode', exact: true })
    const editor = page.getByRole('button', { name: 'Editor mode', exact: true })
    await expect(conversation).toHaveAttribute('title', 'Conversation mode (⌘G)')
    await expect(editor).toHaveAttribute('title', "Editor mode opens a conversation's files")
    await expect(page.getByRole('button', { name: 'Changes', exact: true })).toHaveAttribute('title', 'Available after the first message')
  })
  test(`Settings groups installed programs as Runtimes in ${theme}`, async ({ page }) => {
    await openFrame(page, RUNTIME_COPY_SCENES.runtimes, theme)
    const groups = page.getByRole('navigation', { name: 'Settings navigation' }).locator('[data-left-group-text]')
    await expect(groups).toHaveCount(4)
    await frame(page, 'settings', theme)
    await expect(groups).toHaveText(['Preferences', 'Conversations', 'Runtimes', 'Access'])
    await expect(page.getByText('What your Agents run on: the runtimes HarnessDesk can start, and the accounts each is signed in as.')).toBeVisible()
  })
  test(`Library distinguishes runtime loaders from Agent declarations in ${theme}`, async ({ page }) => {
    await openFrame(page, RUNTIME_COPY_SCENES.library, theme)
    await expect(page.locator('[data-slot="skill-card"]').first()).toBeVisible()
    await frame(page, 'library', theme)
    await expect(page.getByRole('radio', { name: 'One runtime', exact: true })).toBeVisible()
    await expect(page.locator('[data-slot="skill-card"]').first().locator('[aria-label^="Loaded by"]')).toHaveAttribute('aria-label', /Loaded by \d of 3 runtimes/)
    await page.getByRole('button', { name: 'Filter', exact: true }).click()
    await expect(page.getByText('Declared by', { exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await page.locator('[data-slot="skill-card"]').filter({ hasText: 'systematic-debugging' }).click()
    await expect(page.locator('[data-slot="skill-page"]')).toBeVisible()
    await frame(page, 'skill', theme)
    await expect(page.getByText('Every skill and MCP server your runtimes can load, wherever each one keeps them.', { exact: true })).toHaveCount(0)
    await expect(page.locator('[data-slot="tool-section"][aria-label="Loaded by"]')).toBeVisible()
  })
}
