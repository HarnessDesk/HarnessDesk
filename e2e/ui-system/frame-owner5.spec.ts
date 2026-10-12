import { expect, test, type Page } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'
import { installFramePreviewFixture } from './frame-preview-fixture'

test.use({ screenshot: 'off', trace: 'off', video: 'off' })

const openFrame = async (page: Page, query: string, theme: 'light' | 'dark', width: number): Promise<void> => {
  await installFramePreviewFixture(page)
  await page.setViewportSize({ width, height: 850 })
  await page.emulateMedia({ colorScheme: theme })
  await page.mouse.move(width - 1, 849)
  await page.goto(`/preview.html?${query}&theme=${theme}`)
  if (theme === 'dark') await expect(page.locator('body')).toHaveAttribute('data-hd-dark-theme', '')
  await page.evaluate(async () => { await document.fonts.ready })
}

const rect = async (page: Page, selector: string) => page.locator(selector).evaluate(element => {
  const box = element.getBoundingClientRect()
  return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom }
})

for (const theme of ['light', 'dark'] as const) for (const width of [1280, 720]) {
  test(`Owner 5 Settings has no page title or duplicate top controls at ${width} in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=settings&frame-section=general', theme, width)
    const topbar = page.locator('[data-slot="top-bar"]:visible')
    const titleTexts = await topbar.locator('[data-topbar-title]').allTextContents()
    expect(titleTexts.every(title => title.trim() === '')).toBe(true)
    await expect(page.getByRole('heading', { name: 'General', level: 1, exact: true })).toHaveCount(1)

    const visibleControls = await page.locator('[data-left-top]:visible button:visible, [data-topbar="lead"] button:visible')
      .evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')))
    expect(visibleControls.filter(label => label === 'Hide sidebar' || label === 'Show sidebar')).toHaveLength(1)
    expect(visibleControls.filter(label => label === 'Search everything' || label === 'Back' || label === 'Forward')).toEqual([])
  })

  test(`Owner 5 Settings shows only the column toggle at ${width} in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=settings&frame-section=general', theme, width)
    const visibleControls = await page.locator('[data-left-top]:visible button:visible, [data-topbar="lead"] button:visible')
      .evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')))
    expect(visibleControls.filter(label => label === 'Hide sidebar' || label === 'Show sidebar')).toHaveLength(1)
    expect(visibleControls.filter(label => label === 'Search everything' || label === 'Back' || label === 'Forward')).toEqual([])
  })
}

for (const width of [1280, 720]) {
  test(`Owner 5 keeps the ordinary work controls at ${width}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation', 'light', width)
    const visibleControls = await page.locator('[data-left-top]:visible button:visible, [data-topbar="lead"] button:visible')
      .evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')))
    expect(visibleControls).toContain('Search everything')
    expect(visibleControls).toContain(width === 1280 ? 'Hide sidebar' : 'Show sidebar')
    if (width === 1280) {
      expect(visibleControls).toContain('Back')
      expect(visibleControls).toContain('Forward')
    } else {
      expect(visibleControls).not.toContain('Back')
      expect(visibleControls).not.toContain('Forward')
    }
  })
}

test('Owner 5 Settings keeps its palette and leaves ⌘] without changing pages', async ({ page }) => {
  await openFrame(page, 'frame-wall=conversation', 'light', 1280)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settingsNav = page.getByRole('navigation', { name: 'Settings navigation' })
  await settingsNav.getByRole('button', { name: 'Appearance', exact: true }).click()
  await settingsNav.getByRole('button', { name: 'Runtimes', exact: true }).click()
  const runtimes = settingsNav.getByRole('button', { name: 'Runtimes', exact: true })
  await expect(runtimes).toHaveAttribute('aria-current', 'page')

  await page.keyboard.press('Meta+]')
  await expect(runtimes).toHaveAttribute('aria-current', 'page')
  await page.keyboard.press('Meta+k')
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0)
  await expect(page.locator('[data-page-destination="settings"]:visible')).toHaveCount(1)
  await expect(runtimes).toHaveAttribute('aria-current', 'page')
})

test('Owner 5 Settings ⌘[ leaves the whole Settings chain once', async ({ page }) => {
  await openFrame(page, 'frame-wall=conversation', 'light', 1280)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settingsNav = page.getByRole('navigation', { name: 'Settings navigation' })
  await settingsNav.getByRole('button', { name: 'Appearance', exact: true }).click()
  await settingsNav.getByRole('button', { name: 'Runtimes', exact: true }).click()
  await page.keyboard.press('Meta+[')
  await expect(page.locator('[data-page-destination="settings"]:visible')).toHaveCount(0)
  await expect(page.locator('[data-slot="retained-work"]:visible')).toHaveCount(1)
})

test('Owner 5 Settings Escape leaves the whole Settings chain once', async ({ page }) => {
  await openFrame(page, 'frame-wall=conversation', 'light', 1280)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settingsNav = page.getByRole('navigation', { name: 'Settings navigation' })
  await settingsNav.getByRole('button', { name: 'Appearance', exact: true }).click()
  await settingsNav.getByRole('button', { name: 'Runtimes', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-page-destination="settings"]:visible')).toHaveCount(0)
  await expect(page.locator('[data-slot="retained-work"]:visible')).toHaveCount(1)
})

test('Owner 5 Settings column Back returns to the pre-Settings page after visiting sections', async ({ page }) => {
  await openFrame(page, 'frame-wall=conversation', 'light', 1280)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settingsNav = page.getByRole('navigation', { name: 'Settings navigation' })
  await settingsNav.getByRole('button', { name: 'Appearance', exact: true }).click()
  await settingsNav.getByRole('button', { name: 'Runtimes', exact: true }).click()
  await settingsNav.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page.locator('[data-page-destination="settings"]:visible')).toHaveCount(0)
  await expect(page.locator('[data-slot="retained-work"]:visible')).toHaveCount(1)
})

test('Owner 5 Settings leaves a block gap between Back and Search settings', async ({ page }) => {
  await openFrame(page, 'frame-wall=conversation', 'light', 1280)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settingsNav = page.getByRole('navigation', { name: 'Settings navigation' })
  const back = settingsNav.getByRole('button', { name: 'Back', exact: true })
  const search = settingsNav.getByRole('searchbox', { name: 'Search settings', exact: true })
  await back.hover()
  const backBox = await rect(page, '[data-left-settings] > [data-left-row] button')
  const searchBox = await search.evaluate(element => {
    const box = element.getBoundingClientRect()
    return { y: box.y, height: box.height }
  })
  expect(searchBox.y - backBox.bottom).toBeGreaterThan(0)
})

test('Owner 5 terminal hides on folderless pages and restores its same shells and height', async ({ page }) => {
  await openFrame(page, 'frame-wall=conversation', 'light', 1280)
  await page.locator('[data-slot="top-bar"]:visible button[aria-label="More"]').click()
  await page.getByRole('menuitemradio', { name: /Terminal/ }).click()
  await expect(page.locator('[data-terminal-shell-tabs]')).toBeVisible()

  const tablist = page.getByRole('tablist', { name: 'Terminal shells', exact: true })
  await expect(tablist.getByRole('tab')).toHaveCount(1)
  const selectedLabel = await tablist.getByRole('tab').evaluateAll(nodes =>
    nodes.find(node => node.getAttribute('aria-selected') === 'true')?.textContent?.trim() ?? null)
  const shellIds = await page.locator('[data-terminal-mount]').evaluateAll(nodes =>
    nodes.map(node => node.getAttribute('data-terminal-mount')))
  await page.locator('[data-terminal-mount]').first().evaluate(node => node.setAttribute('data-owner5-witness', 'retained'))
  const bottomRegion = page.locator('[data-frame-region="bottom"]')
  const height = await bottomRegion.evaluate(element => element.getBoundingClientRect().height)

  const expectFolderless = async (destination: string): Promise<void> => {
    await expect(page.locator(`[data-page-destination="${destination}"]:visible`)).toHaveCount(1)
    await expect(page.locator('[data-slot="fixed-shell"]')).toHaveAttribute('data-bottom-open', 'false')
    await expect(page.locator('[data-terminal-shell-tabs]')).toBeHidden()
    await expect(page.locator('[data-terminal-mount][data-owner5-witness="retained"]')).toHaveCount(1)
    expect(await page.locator('[data-terminal-mount]').evaluateAll(nodes =>
      nodes.map(node => node.getAttribute('data-terminal-mount')))).toEqual(shellIds)
    expect(await bottomRegion.evaluate(element => element.getBoundingClientRect().height)).toBe(height)

    const more = page.locator('[data-topbar="more"] button:visible')
    if (await more.count()) {
      await more.first().click()
      await expect(page.getByRole('menuitemradio', { name: /Terminal/ })).toHaveCount(0)
      await expect(page.getByRole('menuitem', { name: /Terminal/ })).toHaveCount(0)
      await page.keyboard.press('Escape')
    }
  }

  const returnToWork = async (): Promise<void> => {
    await page.keyboard.press('Meta+[')
    await expect(page.locator('[data-slot="retained-work"]:visible')).toHaveCount(1)
    await expect(page.locator('[data-terminal-shell-tabs]')).toBeVisible()
    const selectedAfter = await tablist.getByRole('tab').evaluateAll(nodes =>
      nodes.find(node => node.getAttribute('aria-selected') === 'true')?.textContent?.trim() ?? null)
    expect(selectedAfter).toBe(selectedLabel)
    expect(await page.locator('[data-frame-region="bottom"]').evaluate(element => element.getBoundingClientRect().height)).toBe(height)
  }

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expectFolderless('settings')
  await page.getByRole('navigation', { name: 'Settings navigation' }).getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page.locator('[data-terminal-shell-tabs]')).toBeVisible()

  for (const [label, destination] of [
    ['Dashboard', 'dashboard'], ['Agents', 'agents'], ['Teams', 'teams'], ['Library', 'library'], ['Plugins', 'plugins'],
  ] as const) {
    await page.getByRole('navigation', { name: 'Workspace actions' }).getByRole('button', { name: label, exact: true }).click()
    await expectFolderless(destination)
    if (destination === 'dashboard') {
      await page.keyboard.press('Control+Backquote')
      await expectFolderless(destination)
    }
    await returnToWork()
  }

  await page.keyboard.press('Meta+n')
  await expect(page.locator('[data-terminal-shell-tabs]')).toBeVisible()
  await expect(page.locator('[data-terminal-mount][data-owner5-witness="retained"]')).toHaveCount(1)
  expect(await page.locator('[data-frame-region="bottom"]').evaluate(element => element.getBoundingClientRect().height)).toBe(height)
})

for (const theme of ['light', 'dark'] as const) for (const width of [1280, 720]) {
  test(`Owner 5 terminal tab row follows panel bar anatomy at ${width} in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation', theme, width)
    await page.locator('[data-slot="top-bar"]:visible button[aria-label="More"]').click()
    await page.getByRole('menuitemradio', { name: /Terminal/ }).click()
    const row = page.locator('[data-terminal-shell-tabs]')
    await expect(row).toBeVisible()
    await page.getByRole('button', { name: 'Close terminal', exact: true }).hover()

    const measurements = await row.evaluate(element => {
      const bounds = (node: Element) => {
        const box = node.getBoundingClientRect()
        return { top: box.top, bottom: box.bottom, right: box.right, height: box.height }
      }
      const rowBox = bounds(element)
      const bottomRule = Number.parseFloat(getComputedStyle(element).borderBottomWidth)
      const controls = [...element.querySelectorAll<HTMLButtonElement>('[data-terminal-shell-actions] button')].map(bounds)
      const allButtons = [...element.querySelectorAll<HTMLButtonElement>('button')].map(bounds)
      const close = element.querySelector<HTMLButtonElement>('[aria-label="Close terminal"]')
      return { row: rowBox, bottomRule, controls, buttons: allButtons, rightInset: close ? rowBox.right - bounds(close).right : null }
    })
    expect(measurements.row.height).toBe(FRAME.bar.height)
    expect(measurements.rightInset).toBe(FRAME.bar.pad)
    for (const control of [...measurements.controls, ...measurements.buttons]) {
      const topGap = control.top - measurements.row.top
      const bottomGap = measurements.row.bottom - measurements.bottomRule - control.bottom
      expect(topGap, 'each tab control stays below the top rule').toBeGreaterThan(0)
      expect(Math.abs(topGap - bottomGap), 'each tab control is vertically centred').toBeLessThanOrEqual(0.5)
    }
  })
}
