import { measureDestination, expectSettingsChrome } from './frame-page-contract'
import { expect, test } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'
import { openFrame } from './frame-contract-helpers'
import { useFrameContractEvidence } from './frame-contract-split-setup'

useFrameContractEvidence()


for (const theme of ['light', 'dark'] as const) for (const width of [1440, 1100, 720]) {
  test(`E2a Profile choices remain inside the frame ${width} ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=settings&frame-section=profile', theme, width)
    const choices = page.getByRole('radiogroup', { name: 'Picture', exact: true })
    await expect(choices).toBeVisible()
    await expect(choices).toHaveAttribute('data-slot', 'picture-choices')
    expect(await choices.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await expectSettingsChrome(page, width)
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`E2a narrow page options keep long current choices within the body in ${theme}`, async ({ page }) => {
    await page.setViewportSize({width:720,height:900})
    await page.emulateMedia({colorScheme:theme})
    await page.goto(`/design.html?view=page-options&theme=${theme}`)
    const options = page.locator('[data-slot="page-options"]').nth(2)
    await expect(options).toBeVisible()
    const trigger = options.locator('[data-slot="popover-trigger"]')
    await expect(trigger).toContainText('チェックアウトのレビュー')
    expect(await trigger.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
    expect(await options.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
  })
}

for (const theme of ['light', 'dark'] as const) for (const width of [2200, 1440, 1100, 720]) {
  for (const child of ['runtime', 'account', 'project', 'skill']) test(`E2 Settings child ${child} ${width} ${theme}`, async ({ page }) => {
    await measureDestination(page, `frame-wall=settings&frame-detail=${child}`, 'reading', theme, width, { more: 'absent' })
    const bar = page.locator('[data-slot="top-bar"]:visible')
    await expect(bar.locator('[data-topbar="place"] button')).toHaveCount(0)
    const heading = child === 'runtime' || child === 'account' ? 'Runtimes' : child === 'project' ? 'Workspaces' : 'Skills'
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
  })
  test(`E2 Add runtime ${width} ${theme}`, async ({ page }) => {
    await measureDestination(page, 'frame-wall=settings&frame-section=runtimes&frame-focus=add', 'reading', theme, width, { more: 'absent' })
    await expect(page.locator('[data-page-destination="settings"]:visible')).toContainText('A runtime keeps its own account, configuration and history; adding it here only tells HarnessDesk how to start it.')
  })
}

for(const width of [1440,720]) test(`E2 Settings Back leaves in one step and retains work ${width}`, async ({ page }) => {
  await openFrame(page, 'frame-wall=navigation', 'light', width)
  if (width < FRAME.fold.sidebarFloats) await page.getByRole('button', { name: 'Show sidebar', exact: true }).click()
  const column = page.locator('[data-left-column]:visible')
  const work = page.locator('[data-slot="retained-work"]')
  const revealSettings = async () => {
    const settingsNav = page.getByRole('navigation', { name: 'Settings navigation' })
    if (await settingsNav.isVisible()) return
    const show = page.getByRole('button', { name: 'Show sidebar', exact: true })
    await expect(show).toBeVisible()
    await show.click()
    await expect(page.getByRole('dialog', { name: 'Sidebar', exact: true })).toBeVisible()
    await expect(settingsNav).toBeVisible()
  }
  await work.evaluate(node => { node.setAttribute('data-settings-door-witness', 'work') })
  await column.locator('[data-left-seat]').getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.locator('[data-page-destination="settings"]:visible')).toHaveCount(1)
  const nav = page.getByRole('navigation', { name: 'Settings navigation' })
  await revealSettings()
  if (width < FRAME.fold.sidebarFloats) {
    await nav.getByRole('button', { name: 'Back', exact: true }).click()
    await expect(work).toBeVisible()
    await expect(work).toHaveAttribute('data-settings-door-witness', 'work')
    return
  }
  await nav.getByRole('button', { name: 'General', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  await revealSettings()
  await nav.getByRole('button', { name: 'Appearance', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Appearance', exact: true })).toBeVisible()
  await revealSettings()
  await nav.getByRole('button', { name: 'Runtimes', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Runtimes', exact: true })).toBeVisible()
  await revealSettings()
  await nav.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(work).toBeVisible()
  await expect(work).toHaveAttribute('data-settings-door-witness', 'work')
})
test('E2 Settings omits empty More with or without a folder', async ({ page }) => {
  await openFrame(page, 'frame-wall=settings&frame-section=general&frame-no-folder=1', 'light')
  await expect(page.locator('[data-slot="top-bar"]:visible [data-topbar="more"] button')).toHaveCount(0)
  await openFrame(page,'frame-wall=settings&frame-section=general','light')
  await expect(page.locator('[data-page-destination="settings"]:visible')).toHaveCount(1)
  await expect(page.locator('[data-slot="top-bar"]:visible [data-topbar="more"] button')).toHaveCount(0)
})

for(const theme of ['light','dark'] as const) for(const width of [2200,1440,1100,720]) test(`E2 Settings Profile is reading at ${width} in ${theme}`,async({page})=>{
  await measureDestination(page,'frame-wall=settings&frame-section=profile','reading',theme,width,{more:'absent'})
})
