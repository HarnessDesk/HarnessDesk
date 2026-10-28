import { expect, test, type Page } from '@playwright/test'

const frame = (page: Page) => page.locator('[data-frame-id="flows-page"]')
const tools = (page: Page) => page.getByRole('group', { name: 'Flow tools', exact: true })
const sourceField = (page: Page) => page.getByRole('textbox', { name: 'Source', exact: true })

for (const theme of ['light', 'dark'] as const) {
  test(`unavailable folders leave the Flow gallery usable · ${theme}`, async ({ page }, testInfo) => {
    await page.goto(`/preview.html?flows-page=unavailable&theme=${theme}`)
    const surface = frame(page)
    const notice = surface.locator('[data-slot="alert"]')
    await expect(notice).toHaveCount(1)
    await expect(notice).toContainText('Flows could not be read from 20 project folders.')
    await expect(surface.getByRole('alert')).toHaveCount(0)
    await expect(surface.getByText('ENOENT', { exact: false })).toHaveCount(0)
    const card = surface.getByRole('button', { name: 'Open Write and review', exact: true })
    await expect(card).toBeInViewport()
    await expect(surface.getByRole('button', { name: 'New Flow', exact: true })).toBeEnabled()
    await expect(surface.getByLabel('Flow origin').locator('option')).toHaveCount(3)
    await page.screenshot({ path: testInfo.outputPath(`unavailable-folders-${theme}.png`) })
    await page.setViewportSize({ width: 720, height: 900 })
    await expect(surface.getByRole('button', { name: 'Open Just a Team', exact: true })).toBeInViewport()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`unavailable-folders-${theme}-narrow.png`) })
    await surface.getByRole('button', { name: 'Folder details', exact: true }).click()
    await expect(surface.getByText("realpath '/work/removed-20'", { exact: false })).toBeVisible()
    await surface.getByRole('button', { name: 'Folder details', exact: true }).click()
    await card.click()
    await expect(surface.getByRole('button', { name: 'Start Team', exact: true })).toBeEnabled()
  })

  test(`unavailable folders cannot be used for a new Flow or Team · ${theme}`, async ({ page }) => {
    await page.goto(`/preview.html?flows-page=all-unavailable&theme=${theme}`)
    const surface = frame(page)
    await expect(surface.locator('[data-slot="alert"]')).toContainText('Flows could not be read from 20 project folders.')
    await expect(surface.getByRole('button', { name: 'New Flow', exact: true })).toBeDisabled()
    await expect(surface.getByRole('button', { name: 'Open Just a Team', exact: true })).toBeDisabled()
    await expect(surface.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled()
  })

  test(`catalogue keeps its title in the body and the Flow subject in the bar · ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto(`/preview.html?flows-page=list&theme=${theme}`)
    const bar = page.locator('[data-slot="top-bar"]:visible')
    const column = page.locator('[data-page-destination]:visible [data-slot="page"]').first()
    const heading = column.getByRole('heading', { level: 1, name: 'Flows', exact: true })
    await expect(heading).toBeVisible()
    await expect(bar.locator('[data-topbar-title]')).toHaveCount(0)
    const edge = await column.evaluate(node => node.getBoundingClientRect().x + parseFloat(getComputedStyle(node).paddingLeft))
    expect((await heading.boundingBox())!.x).toBeCloseTo(edge, 1)
    await column.getByRole('button', { name: 'New Flow', exact: true }).click()
    await expect(page.getByRole('region', { name: 'Shape graph', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(0)
    await expect(bar.locator('[data-topbar-title]')).toHaveText('New Flow')
  })

  test(`builds, edits, saves and starts the current Flow entirely from its page · ${theme}`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto(`/preview.html?flows-page=draft&theme=${theme}`)
    await expect(page.getByRole('region', { name: 'Shape graph', exact: true })).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    await tools(page).getByRole('button', { name: 'Step', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Check', exact: true }).click()
    const step = page.getByRole('region', { name: 'Step · check', exact: true })
    await step.getByRole('textbox', { name: 'Run', exact: true }).fill('node --version')
    await step.getByRole('textbox', { name: 'Step name', exact: true }).fill('validate-step')
    await expect(page.locator('.react-flow__node[data-id="validate-step"]')).toBeVisible()

    await tools(page).getByRole('button', { name: 'Rule', exact: true }).click()
    const rules = page.getByRole('region', { name: 'Flow settings', exact: true })
    await expect(rules.getByRole('button', { name: 'Flow settings', exact: true })).toHaveAttribute('aria-expanded', 'true')
    await rules.getByRole('combobox', { name: 'Opens', exact: true }).selectOption('validate-step')
    await rules.getByRole('textbox', { name: 'Card title', exact: true }).fill('Check the edited draft')
    await expect(page.locator('.react-flow__edge[data-id="review-rule"]')).toBeAttached()

    await page.locator('[data-slot="flow-canvas-toolbar"]').getByRole('button', { name: 'Save…', exact: true }).click()
    const save = page.getByRole('dialog', { name: 'Save Flow', exact: true })
    await save.getByRole('textbox', { name: 'File name', exact: true }).fill('browser-flow')
    await expect(save).toContainText('node --version')
    await expect(frame(page)).not.toHaveAttribute('data-flow-saved-source')
    await save.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(save).toBeHidden()
    await rules.getByRole('button', { name: 'Source', exact: true }).click()
    await expect(rules.locator('[data-slot="tool-fold"]').filter({ has: page.getByRole('button', { name: 'Source', exact: true }) })).toContainText('browser-flow.yml')

    await tools(page).getByRole('tab', { name: 'File', exact: true }).click()
    const savedSource = await sourceField(page).inputValue()
    await expect(frame(page)).toHaveAttribute('data-flow-saved-source', savedSource)
    const edited = JSON.parse(savedSource)
    edited.name = 'Browser Flow edited after saving'
    edited.inputs = [{ id: 'task', label: 'Task', default: '' }]
    edited.roles.find((role: { id: string }) => role.id === 'validate-step').check.timeout = 321
    const currentSource = JSON.stringify(edited)
    await sourceField(page).fill(currentSource)
    await expect(page.getByRole('button', { name: 'Start a Team', exact: true })).toBeEnabled()
    await expect(frame(page)).toHaveAttribute('data-flow-saved-source', savedSource)
    expect(currentSource).not.toBe(savedSource)
    await tools(page).getByRole('tab', { name: 'Graph', exact: true }).click()
    await page.getByRole('button', { name: 'Dry run', exact: true }).click()
    const dryRun = page.getByRole('dialog', { name: 'Dry run', exact: true })
    await expect(dryRun).toContainText('node --version')
    await dryRun.locator('[data-slot="dialog-footer"]').getByRole('button', { name: 'Close', exact: true }).click()
    const screenshot = testInfo.outputPath(`flow-page-edited-${theme}.png`)
    await page.screenshot({ path: screenshot })
    await testInfo.attach(`flow-page-edited-${theme}`, { path: screenshot, contentType: 'image/png' })

    await page.getByRole('button', { name: 'Start a Team', exact: true }).click()
    const team = page.getByRole('dialog', { name: 'New Team', exact: true })
    await expect(team.getByRole('region', { name: 'Selected Flow', exact: true })).toContainText('Browser Flow edited after saving')
    await expect(team.getByRole('button', { name: 'Change', exact: true })).toBeVisible()
    await expect(team.getByRole('searchbox', { name: 'Search Flows', exact: true })).toHaveCount(0)
    await team.getByRole('textbox', { name: 'What should they do?', exact: true }).fill('Verify this synthetic Flow')
    const completion = team.getByRole('button', { name: 'Completion and dry run', exact: true })
    await expect(completion).toHaveAttribute('aria-expanded', 'false')
    await completion.click()
    await team.getByRole('textbox', { name: 'Done when · optional', exact: true }).fill('The local preview is accepted')
    await expect(team.getByRole('button', { name: 'Start Team', exact: true })).toBeEnabled()
    await team.getByRole('button', { name: 'Start Team', exact: true }).click()
    await expect(team).toBeHidden()
    await expect(frame(page)).toHaveAttribute('data-flow-started-source', currentSource)
    await expect(frame(page)).toHaveAttribute('data-flow-started-task', 'Verify this synthetic Flow')
    await expect(frame(page)).toHaveAttribute('data-flow-started-sentence', 'The local preview is accepted')
    await expect(frame(page)).toHaveAttribute('data-flow-started-goal', 'synthetic-flow-team')
    await expect(frame(page)).toHaveAttribute('data-flow-opened-goal', 'synthetic-flow-team')
    await expect(frame(page)).toHaveAttribute('data-flow-start-count', '1')
    expect(errors).toEqual([])
  })
}

test('a narrow Flow page floats its rail and keeps every canvas toolbar control reachable', async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 800 })
  await page.goto('/preview.html?flows-page=draft&theme=light')
  const workspace = page.locator('[data-slot="flow-canvas-workspace"]')
  await expect(workspace).toHaveAttribute('data-rail-floating', 'true')
  await page.getByRole('button', { name: 'Flow details', exact: true }).click()
  await expect(page.getByRole('complementary', { name: 'Flow details', exact: true })).toBeHidden()
  const toolbar = page.locator('[data-slot="flow-canvas-toolbar"]')
  const mainBox = await page.getByRole('main', { name: 'Flow editor', exact: true }).boundingBox()
  expect(mainBox).not.toBeNull()
  for (const control of await toolbar.getByRole('button').all()) {
    await expect(control).toBeVisible()
    const box = await control.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(mainBox!.x)
    expect(box!.x + box!.width).toBeLessThanOrEqual(mainBox!.x + mainBox!.width)
    expect(box!.y).toBeGreaterThanOrEqual(mainBox!.y)
    expect(box!.y + box!.height).toBeLessThanOrEqual(mainBox!.y + mainBox!.height)
  }
  for (const label of ['Graph', 'Steps', 'File']) await expect(tools(page).getByRole('tab', { name: label, exact: true })).toBeVisible()
  await tools(page).getByRole('button', { name: 'Step', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Person', exact: true }).click()
  await expect(page.locator('.react-flow__node[data-id="person"]')).toBeAttached()
})

for (const theme of ['light', 'dark'] as const) {
  test(`Flow example pauses and resumes the real ring paint and relay in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'no-preference' })
    await page.goto(`/preview.html?flows-page&theme=${theme}`)
    await page.getByRole('button', { name: 'Open Write and review', exact: true }).click()
    const example = page.locator('[data-slot="flow-example"]')
    // Step once so both the current card and a declared transition have motion.
    await example.getByRole('button', { name: 'Next', exact: true }).click()
    const ring = example.locator('[data-slot="flow-ring"]')
    const baton = example.locator('[data-slot="flow-baton"]')
    await expect(ring).toHaveCount(1)
    await expect(baton).toHaveCount(1)
    const states = () => example.evaluate(root => ({
      ring: getComputedStyle(root.querySelector('[data-slot="flow-ring"]')!, '::before').animationPlayState,
      relay: getComputedStyle(root.querySelector('[data-slot="flow-baton"]')!).animationPlayState,
    }))
    await expect.poll(states).toEqual({ ring: 'paused', relay: 'paused' })
    await example.getByRole('button', { name: 'Play', exact: true }).click()
    await expect.poll(states).toEqual({ ring: 'running', relay: 'running' })
    await example.getByRole('button', { name: 'Pause', exact: true }).click()
    await expect.poll(states).toEqual({ ring: 'paused', relay: 'paused' })
    const held = await example.evaluate(async root => {
      const animations = [...root.querySelectorAll('[data-slot="flow-ring"], [data-slot="flow-baton"]')]
        .flatMap(node => node.getAnimations({ subtree: true }))
      await Promise.all(animations.map(animation => animation.ready))
      const before = animations.map(animation => animation.currentTime)
      await new Promise(requestAnimationFrame)
      await new Promise(requestAnimationFrame)
      return { count: animations.length, states: animations.map(animation => animation.playState),
        before, after: animations.map(animation => animation.currentTime) }
    })
    expect(held.count).toBe(2)
    expect(held.states).toEqual(['paused', 'paused'])
    expect(held.after).toEqual(held.before)
    await example.getByRole('button', { name: 'Play', exact: true }).click()
    await expect.poll(states).toEqual({ ring: 'running', relay: 'running' })
    await example.getByRole('button', { name: 'Pause', exact: true }).click()

    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(example.getByRole('button', { name: 'Play', exact: true })).toBeDisabled()
    await expect(example).toContainText('Use Next with reduced motion.')
    expect(await example.evaluate(root => ({
      ring: getComputedStyle(root.querySelector('[data-slot="flow-ring"]')!, '::before').animationName,
      relay: getComputedStyle(root.querySelector('[data-slot="flow-baton"]')!).animationName,
      active: [...root.querySelectorAll('[data-slot="flow-ring"], [data-slot="flow-baton"]')]
        .flatMap(node => node.getAnimations({ subtree: true })).length,
    }))).toEqual({ ring: 'none', relay: 'none', active: 0 })
    await example.getByRole('button', { name: 'Next', exact: true }).click()
    await expect(example).toHaveAttribute('data-playing', 'false')
    await expect(example).toContainText('Use Next with reduced motion.')
  })
}
