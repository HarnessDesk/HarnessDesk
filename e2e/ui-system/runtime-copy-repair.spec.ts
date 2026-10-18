import fs from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'

const capture = async (page: Page, scene: string, theme: string) => {
  if (!process.env.RUNTIME_COPY_REPAIR_FRAMES) return
  await fs.mkdir(process.env.RUNTIME_COPY_REPAIR_FRAMES, { recursive: true })
  await page.screenshot({ path: `${process.env.RUNTIME_COPY_REPAIR_FRAMES}/${scene}-${theme}.png` })
}
const open = async (page: Page, scene: string, theme: 'light' | 'dark') => {
  await page.emulateMedia({ colorScheme: theme })
  await page.goto(`/runtime-copy-repair.html?scene=${scene}`)
  await page.evaluate(async () => { await document.fonts.ready })
}
for (const theme of ['light', 'dark'] as const) {
  test(`batch skill install names all runtime targets in ${theme}`, async ({ page }) => {
    await open(page, 'library', theme)
    await page.locator('[data-slot="skill-card"]').filter({ hasText: 'checkout-review' }).click()
    // The skill opens as its own page; the batch install lives in its More menu.
    await page.getByRole('button', { name: 'More', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Install to all 4 missing…', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await capture(page, 'library-plan', theme)
    await expect(page.getByRole('dialog')).toContainText('Install checkout-review for 4 runtimes')
  })
  test(`file approval in an ordinary conversation names the runtime in ${theme}`, async ({ page }) => {
    await open(page, 'approval', theme)
    await expect(page.getByRole('dialog', { name: 'Apply these changes?' })).toBeVisible()
    await capture(page, 'approval', theme)
    await expect(page.getByRole('dialog')).toContainText('The runtime wants to write changes to disk.')
  })
  test(`ordinary transcript actions and silent turns name the runtime in ${theme}`, async ({ page }) => {
    await open(page, 'transcript', theme)
    await expect(page.getByText(/finished this turn without any output/)).toBeVisible()
    await capture(page, 'transcript', theme)
    await expect(page.getByText('The runtime finished this turn without any output.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Ask the runtime to try again', exact: true }).first()).toBeAttached()
  })
  test(`system notification descriptions name runtimes in ${theme}`, async ({ page }) => {
    await open(page, 'notifications', theme)
    await page.getByText(/finished while you were elsewhere/).scrollIntoViewIfNeeded()
    await capture(page, 'notifications', theme)
    await expect(page.getByText('A runtime finished while you were elsewhere.')).toBeVisible()
    await expect(page.getByText('A runtime wants to run a command, edit files, or widen its sandbox.')).toBeAttached()
    await expect(page.getByText('A runtime asked you a question.')).toBeAttached()
  })
  test(`usage coverage counts runtimes in ${theme}`, async ({ page }) => {
    await open(page, 'usage-overview', theme)
    await expect(page.getByRole('button', { name: /Turns/ }).first()).toBeVisible()
    await capture(page, 'usage-overview', theme)
    const overview = await page.locator('body').innerText()
    await page.getByRole('button', { name: /Turns/ }).first().click()
    await page.getByText(/turns known for 1 of 2/).scrollIntoViewIfNeeded()
    await capture(page, 'usage-turns', theme)
    const turns = await page.locator('body').innerText()
    await open(page, 'usage-activity', theme)
    await page.locator('select').filter({ has: page.locator('option', { hasText: /^By hour$/ }) }).selectOption({ label: 'By hour' })
    await capture(page, 'usage-activity', theme)
    await expect(page.getByText('known for 1 of 2 runtimes', { exact: true })).toBeVisible()
    expect(overview).toContain('known for 1 of 2 runtimes')
    expect(turns).toContain('turns known for 1 of 2 runtimes')
  })
  test(`an added credential keeps runtime sessions distinct in ${theme}`, async ({ page }) => {
    await open(page, 'sign-in', theme)
    await expect(page.getByText(/Only the credential lives there/)).toBeVisible()
    await capture(page, 'sign-in', theme)
    await expect(page.getByText(/the sessions are the runtime’s own/)).toBeVisible()
  })
  test(`runtime catalogue specimens follow the product nouns in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/design.html?view=empty')
    await expect(page.getByText(/No (agent|runtime) on this workspace/)).toBeVisible()
    await capture(page, 'catalogue-empty', theme)
    await expect(page.getByText('No runtime on this workspace')).toBeVisible()
    await expect(page.getByText('Eleven runtimes speak ACP')).toBeVisible()
  })
}
