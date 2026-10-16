import { expect, test, type Locator, type Page } from '@playwright/test'
import { installFramePreviewFixture } from './frame-preview-fixture'

test.use({ screenshot: 'off', trace: 'off', video: 'off' })

const openTeam = async (page: Page, theme: 'light' | 'dark', width: 1280 | 720): Promise<void> => {
  await page.setViewportSize({ width, height: 900 })
  await page.emulateMedia({ colorScheme: theme })
  await page.goto(`/preview.html?team-start=picker&theme=${theme}`)
  await expect(page.getByRole('dialog', { name: 'New Team', exact: true })).toBeVisible()
}

const openNewWorktree = async (page: Page, theme: 'light' | 'dark', width: 1280 | 720): Promise<void> => {
  await page.setViewportSize({ width, height: 900 })
  await page.emulateMedia({ colorScheme: theme })
  await page.goto(`/preview.html?theme=${theme}`)
  await page.getByLabel('git sheet').selectOption('new worktree')
  await expect(page.getByRole('dialog', { name: 'New worktree', exact: true })).toBeVisible()
}

const footerMetrics = async (dialog: Locator) => dialog.locator('[data-slot="dialog-footer"]').evaluate(node => {
  const surface = node.closest('[role="dialog"], [role="alertdialog"]')!
  const actions = node.querySelector<HTMLElement>('[data-slot="dialog-footer-actions"]')
  const buttons = [...(actions?.querySelectorAll('button') ?? [])].map(button => {
    const box = button.getBoundingClientRect()
    return {
      label: button.textContent?.trim(),
      variant: button.getAttribute('data-variant'),
      filled: button.hasAttribute('data-filled'),
      x: box.x,
      right: box.right,
      height: box.height,
    }
  }).sort((a, b) => a.x - b.x)
  const actionsBox = actions?.getBoundingClientRect()
  const surfaceBox = surface.getBoundingClientRect()
  return { rightInset: actionsBox ? surfaceBox.right - actionsBox.right : null, buttons }
})

const DIALOG_WIDTHS = [460, 520, 560, 620, 860]

const inspectActionFooter = async (dialog: Locator): Promise<number> => {
  await expect(dialog).toBeVisible()
  const width = (await dialog.boundingBox())!.width
  const viewportWidth = await dialog.page().evaluate(() => window.innerWidth)
  const onNamedScale = DIALOG_WIDTHS.some(expected => Math.abs(width - expected) <= 1) || Math.abs(width - Math.min(860, viewportWidth - 32)) <= 1
  expect(onNamedScale, `dialog width ${width}px is on the named size scale or its viewport cap`).toBe(true)
  const footer = await footerMetrics(dialog)
  expect(footer.buttons.length).toBeGreaterThan(0)
  expect(footer.rightInset).toBeCloseTo(24, 0)
  expect(new Set(footer.buttons.map(button => button.height)).size).toBe(1)
  const primary = footer.buttons.filter(button => button.filled).at(-1)
  if (primary) {
    expect(footer.buttons.at(-1)).toEqual(primary)
    const cancel = footer.buttons.find(button => button.label === 'Cancel')
    if (cancel) expect(cancel.x).toBeLessThan(primary.x)
  }
  return width
}

for (const theme of ['light', 'dark'] as const) for (const width of [1280, 720] as const) {
  test(`R10.38 New Team keeps footer actions and width while choosing and previewing at ${width}px in ${theme}`, async ({ page }) => {
    await openTeam(page, theme, width)
    const dialog = page.getByRole('dialog', { name: 'New Team', exact: true })
    await expect(dialog.getByRole('button', { name: 'Write and review', exact: true })).toBeVisible()
    const pickerWidth = (await dialog.boundingBox())!.width
    const labels = ['Cancel', 'Dry run', 'Start Team']
    expect((await footerMetrics(dialog)).buttons.map(button => button.label)).toEqual(labels)
    await expect(dialog.getByRole('button', { name: 'Dry run', exact: true })).toBeDisabled()
    await expect(dialog.getByRole('button', { name: 'Start Team', exact: true })).toBeDisabled()
    expect(await inspectActionFooter(dialog)).toBe(pickerWidth)

    const task = dialog.getByRole('textbox', { name: 'What should they do?', exact: true })
    await task.fill('Fix the checkout retry and verify the change.')
    await dialog.getByRole('button', { name: 'Write and review', exact: true }).click()
    await expect(dialog.getByRole('button', { name: 'Write and review', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(task).toHaveValue('Fix the checkout retry and verify the change.')
    await expect(dialog.getByRole('region', { name: 'Flow', exact: true })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Dry run', exact: true })).toBeEnabled()
    await dialog.getByRole('button', { name: 'Dry run', exact: true }).click()
    await expect(dialog.getByRole('region', { name: 'Dry run', exact: true })).toBeVisible()
    expect((await footerMetrics(dialog)).buttons.map(button => button.label)).toEqual(labels)
    expect(await inspectActionFooter(dialog)).toBe(pickerWidth)
    await expect(dialog.getByRole('button', { name: 'Start Team', exact: true })).toBeEnabled()

    await dialog.getByRole('button', { name: 'Investigation', exact: true }).click()
    await expect(dialog.getByRole('button', { name: 'Investigation', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(task).toHaveValue('Fix the checkout retry and verify the change.')
    expect(await inspectActionFooter(dialog)).toBe(pickerWidth)
    await expect(page.getByRole('dialog', { name: 'New Team', exact: true })).toHaveCount(1)
  })
}

const resolveToken = async (page: Page, token: string): Promise<string> => page.evaluate(name => {
  const probe = document.createElement('span')
  probe.style.color = `var(${name})`
  document.body.append(probe)
  const color = getComputedStyle(probe).color
  probe.remove()
  return color
}, token)

for (const theme of ['light', 'dark'] as const) for (const width of [1280, 720] as const) {
test(`R10.39 Flow cards use the approved selection and graph colours at ${width}px in ${theme}`, async ({ page }) => {
  await openTeam(page, theme, width)
  await expect(page.getByRole('button', { name: 'Write and review', exact: true })).toBeVisible()
  const dialog = page.getByRole('dialog', { name: 'New Team', exact: true })
  await expect(dialog.locator('[data-slot="flow-card"][data-selected]')).toHaveCount(0)
  const selected = dialog.getByRole('button', { name: 'Write and review', exact: true })
  await selected.click()
  await expect(selected).toHaveAttribute('data-selected', 'true')
  await expect(selected).toBeEnabled()
  const active = await resolveToken(page, '--hd-active')
  const hover = await resolveToken(page, '--hd-hover')
  const border = await resolveToken(page, '--hd-border-strong')
  const accent = await resolveToken(page, '--hd-accent')
  const muted = await resolveToken(page, '--hd-muted')
  const ink = await resolveToken(page, '--hd-foreground')
  const card = await selected.evaluate(node => ({
    background: getComputedStyle(node).backgroundColor,
    border: getComputedStyle(node).borderColor,
    steps: [...node.querySelectorAll('[data-step] rect')].map(step => ({ fill: getComputedStyle(step).fill, border: getComputedStyle(step).stroke })),
    labels: [...node.querySelectorAll('[data-slot="flow-mini-label"]')].map(label => getComputedStyle(label).color),
  }))
  expect(card.background).toBe(active)
  expect(card.border).toBe(accent)
  expect(card.steps.length).toBeGreaterThan(0)
  expect(card.steps.every(step => step.fill === muted && step.border === border)).toBe(true)
  expect(card.labels.every(label => label === ink)).toBe(true)
  const hovered = page.getByRole('button', { name: 'Side by side', exact: true })
  await expect(hovered).toBeEnabled()
  await hovered.hover()
  expect(await hovered.evaluate(node => getComputedStyle(node).backgroundColor)).toBe(hover)
  expect(await hovered.evaluate(node => getComputedStyle(node).borderColor)).toBe(border)

  await openNewWorktree(page, theme, width)
  expect(await inspectActionFooter(page.getByRole('dialog'))).toBe(520)
  const branchCheck = page.getByRole('radio', { name: /main/ }).locator('svg').last()
  const checkColor = await branchCheck.evaluate(node => getComputedStyle(node).color)
  const inkColor = await resolveToken(page, '--hd-foreground')
  expect(checkColor).toBe(inkColor)
})
}

test('R10.40 New worktree names its project with the shared context chip', async ({ page }) => {
  await openNewWorktree(page, 'light', 1280)
  const dialog = page.getByRole('dialog', { name: 'New worktree', exact: true })
  const title = dialog.locator('[data-slot="dialog-head"]')
  const chip = title.locator('[data-slot="chip"]')
  await expect(chip).toHaveText('storefront')
  await expect(chip).toHaveAttribute('title', '/work/storefront')
  await expect(title.locator('[data-slot="dialog-description"]')).not.toContainText('/work/storefront')
})

const openPreviewWall = async (page: Page, query: string): Promise<void> => {
  await installFramePreviewFixture(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.mouse.move(1279, 899)
  await page.goto(`/preview.html?${query}&theme=light`)
  await page.evaluate(async () => { await document.fonts.ready })
}

test('R10.38 every preview dialog keeps its named width and shared action footer', async ({ page }) => {
  await openTeam(page, 'light', 1280)
  let dialog = page.getByRole('dialog', { name: 'New Team', exact: true })
  const teamWidth = await inspectActionFooter(dialog)
  await dialog.getByRole('button', { name: 'Write and review', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'New Team', exact: true })
  await expect(dialog.getByRole('button', { name: 'Write and review', exact: true })).toHaveAttribute('aria-pressed', 'true')
  expect(await inspectActionFooter(dialog)).toBe(teamWidth)

  await page.goto('/preview.html?theme=light')
  const gitSheet = page.getByLabel('git sheet')
  const dialogs = [
    ['create branch', 'dialog'],
    ['ask agent', 'dialog'],
    ['worktree manager', 'dialog'],
    ['new worktree', 'dialog'],
    ['folder picker', 'dialog'],
    ['provenance', 'dialog'],
    ['delete session', 'alertdialog'],
    ['commit', 'dialog'],
    ['merge', 'dialog'],
    ['rename branch', 'dialog'],
    ['delete branch', 'dialog'],
    ['tag', 'dialog'],
    ['reset', 'dialog'],
    ['stash', 'dialog'],
    ['diff range', 'dialog'],
  ] as const
  for (const [name, kind] of dialogs) {
    await gitSheet.selectOption(name)
    const surface = page.getByRole(kind).last()
    await inspectActionFooter(surface)
  }

  await openPreviewWall(page, 'frame-wall=library')
  await page.locator('[data-slot="top-bar"]:visible').getByRole('button', { name: 'More', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Import', exact: true }).click()
  await inspectActionFooter(page.getByRole('dialog', { name: 'Import between runtimes', exact: true }))

  await openPreviewWall(page, 'frame-wall=plugins')
  await page.locator('[data-page-destination="plugins"]:visible').getByRole('button', { name: 'Add plugin', exact: true }).click()
  let plugin = page.getByRole('dialog').last()
  const pluginWidth = await inspectActionFooter(plugin)
  await plugin.getByRole('textbox').fill('/work/sample-plugin')
  await plugin.getByRole('button', { name: 'Continue', exact: true }).click()
  plugin = page.getByRole('dialog').last()
  expect(await inspectActionFooter(plugin)).toBe(pluginWidth)

  await openPreviewWall(page, 'frame-wall=agents&frame-detail=agent&frame-agent-case=release')
  await page.locator('[data-slot="top-bar"]:visible').getByRole('button', { name: 'More', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Run automatically…', exact: true }).click()
  await inspectActionFooter(page.getByRole('dialog', { name: 'Run Release checker automatically', exact: true }))
})

for (const theme of ['light', 'dark'] as const) for (const width of [1280, 720] as const) {
  test(`R10.41 New Team keeps its context header and New session footer alternative at ${width}px in ${theme}`, async ({ page }) => {
    await openTeam(page, theme, width)
    const picker = page.getByRole('dialog', { name: 'New Team', exact: true })
    await expect(picker.getByRole('button', { name: 'Write and review', exact: true })).toBeVisible()
    await picker.getByRole('button', { name: 'Write and review', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'New Team', exact: true })
    await expect(dialog.getByRole('heading', { name: 'New Team', exact: true })).toBeVisible()
    await expect(dialog.locator('[data-slot="dialog-head"] [data-slot="chip"]')).toHaveText('storefront')
    await expect(dialog.locator('[data-slot="dialog-head"] [data-slot="icon-tile"]')).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: 'Back', exact: true })).toHaveCount(0)
    await expect(dialog.locator('[data-slot="dialog-footer-navigation"]').getByRole('button', { name: /^New session/ })).toBeVisible()
    await expect(dialog.getByRole('region', { name: 'Flow', exact: true })).toBeVisible()
    await expect(dialog.locator('[data-slot="dialog-body-prelude"]')).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: 'Change', exact: true })).toHaveCount(0)
  })
}
