import { measureDestination, expectSettingsChrome } from './frame-page-contract'
import { expect, test } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'
import { WALL_THEMES } from './frame-wall-destinations'
import { openFrame } from './frame-contract-helpers'


// Contract runs measure the preview; the final wall owns images and recordings.
test.use({ screenshot: 'off', trace: 'off', video: 'off' })


test('FIX4 Settings sections follow the page and subgroup rhythm on every page', async ({ page }) => {
  const sections = [
    'profile', 'general', 'appearance', 'notifications', 'shortcuts', 'workspaces',
    'history', 'storage', 'archive', 'runtimes', 'models', 'skills', 'extensions',
    'permissions', 'browser',
  ] as const
  const violations: string[] = []

  for (const section of sections) {
    await openFrame(page, `frame-wall=settings&frame-section=${section}&frame-settings-round4=1`, 'light', 1440)
    const destinationState = await page.evaluate(() => ({
      frame: document.querySelector<HTMLElement>('[data-frame-id="frame-wall"]')?.dataset.destination ?? null,
      pages: [...document.querySelectorAll<HTMLElement>('[data-page-destination]')]
        .map(node => ({ id: node.dataset.pageDestination ?? '', visible: node.getClientRects().length > 0 })),
    }))
    expect(destinationState.frame, `${section} preview frame`).toBe('settings')
    expect(destinationState.pages.some(page => page.id === 'settings' && page.visible),
      `${section} Settings page must be the visible destination: ${JSON.stringify(destinationState.pages)}`).toBe(true)
    const measurements = await page.locator('[data-page-destination="settings"]').evaluate(scope => {
      const page = scope.querySelector<HTMLElement>('[data-slot="page"]')!
      const gapBefore = (node: HTMLElement, container: HTMLElement): number | null => {
        let block = node
        while (block.parentElement && block.parentElement !== container) block = block.parentElement
        const previous = block.previousElementSibling
        return previous ? node.getBoundingClientRect().top - previous.getBoundingClientRect().bottom : null
      }
      const heads = [...page.querySelectorAll<HTMLElement>('[data-section-head]')]
        .filter(head => head.getClientRects().length > 0)
        .map(head => ({
          name: head.textContent?.trim() ?? '',
          parent: head.closest<HTMLElement>('[data-slot="section"][data-variant="page"]'),
          top: head.getBoundingClientRect().top,
          gap: gapBefore(head, head.closest<HTMLElement>('[data-slot="section"][data-variant="page"]') ?? page),
        }))
      const pageSections = [...page.querySelectorAll<HTMLElement>('[data-slot="section"][data-variant="page"]')]
        .filter(node => node.getClientRects().length > 0)
        .map(node => ({
          title: node.querySelector<HTMLElement>('[data-section-name]')?.textContent?.trim() ?? '',
          gap: gapBefore(node, page),
        }))
      return { heads, pageSections }
    })

    for (const head of measurements.heads) {
      if (head.gap !== null) {
        const level = head.parent ? 'subgroup' : 'page'
        const expected = level === 'subgroup' ? 24 : 32
        if (Math.abs(head.gap - expected) > 1) {
          violations.push(`${section}: ${level} ${JSON.stringify(head.name)} has ${head.gap}px before it; expected ${expected}px`)
        }
      }
    }
    for (const pageSection of measurements.pageSections) {
      if (pageSection.gap !== null && Math.abs(pageSection.gap - 32) > 1) {
        violations.push(`${section}: section ${JSON.stringify(pageSection.title)} has ${pageSection.gap}px before it; expected 32px`)
      }
    }
  }

  expect(violations, 'every Settings page uses 32px between sections and 24px for a subgroup').toEqual([])
})

test('FIX4 runtime names, versions and the default chip have their own gaps', async ({ page }) => {
  await openFrame(page, 'frame-wall=settings&frame-section=runtimes&frame-settings-round4=1', 'light', 1440)
  for (const [name, version, hasDefault] of [
    ['Runtime 6', '1.0.0', false],
    ['Runtime 1', '0.149.0', true],
    ['Runtime 2', '1.0.0', false],
  ] as const) {
    const row = page.locator('[data-slot="agent-row"]').filter({ has: page.getByText(name, { exact: true }) })
    await expect(row).toBeVisible()
    const geometry = await row.evaluate((node, expectedVersion) => {
      const runtimeName = node.querySelector<HTMLElement>('[data-slot="runtime-name"]')!
      const version = [...node.querySelectorAll<HTMLElement>('[data-slot="text"]')]
        .find(item => item.textContent?.trim() === expectedVersion)!
      const chip = [...node.querySelectorAll<HTMLElement>('[data-slot="chip"]')]
        .find(item => item.textContent?.trim() === 'Default')
      const nameBox = runtimeName.getBoundingClientRect()
      const versionBox = version.getBoundingClientRect()
      const chipBox = chip?.getBoundingClientRect()
      return {
        nameToVersion: versionBox.left - nameBox.right,
        versionToDefault: chipBox ? chipBox.left - versionBox.right : null,
        chipText: chip?.textContent?.trim() ?? null,
      }
    }, version)
    expect(geometry.nameToVersion, `${name} has a chip gap before its version`).toBeGreaterThanOrEqual(7)
    if (hasDefault) {
      expect(geometry.versionToDefault, `${name} has a chip gap before Default`).toBeGreaterThanOrEqual(7)
      expect(geometry.chipText).toBe('Default')
    } else expect(geometry.versionToDefault).toBeNull()
  }
})

test('FIX4 ceiling chips keep a chip gap and distinguish asked from held once per group', async ({ page }) => {
  await openFrame(page, 'frame-wall=settings&frame-section=permissions&frame-settings-round4=1', 'light', 1440)
  const section = page.locator('[data-page-destination="settings"] section[aria-label="Ceilings"]')
  await expect(section).toBeVisible()
  const rows = section.locator('[data-slot="row"]')
  await expect(rows).toHaveCount(12)
  for (const [index, row] of (await rows.all()).entries()) {
    const options = row.locator('[data-slot="toggle-group-item"]')
    await expect(options).toHaveCount(4)
    expect(await options.allTextContents()).toEqual(['Read only', 'Edit', 'Publish', 'Merge'])
    for (const option of await options.all()) { await expect(option).toBeVisible(); await expect(option).toBeDisabled() }
    // AUDIT-4 R11.15 replaces four held/asked chips with one readout and a state chip.
    const expected = index === 0 ? 'Edit' : index === 1 ? 'Read only' : index % 2 === 0 ? 'Publish' : 'Merge'
    await expect(row.locator('[data-slot="toggle-group-item"][aria-pressed="true"]')).toHaveCount(1)
    await expect(row.locator('[data-slot="toggle-group-item"][aria-pressed="true"]')).toHaveText(expected)
    const chip = row.locator('[data-slot="row-title-chip"] [data-slot="chip"]')
    await expect(chip).toHaveCount(1)
    await expect(chip).toHaveText(index === 1 ? 'Asked' : 'Enforced')
    const gap = await row.evaluate(node => {
      const name = node.querySelector('[data-slot="row-title-name"]')!.getBoundingClientRect()
      const chip = node.querySelector('[data-slot="row-title-chip"]')!.getBoundingClientRect()
      return chip.left - name.right
    })
    expect(gap, 'the earned ceiling state keeps the 8px chip gap').toBeGreaterThanOrEqual(7)
    expect(gap).toBeLessThanOrEqual(9)
  }
  await expect(section.locator('[data-slot="ceiling-group-note"]')).toHaveCount(0)
})

test('FIX4 Settings filters are standalone first fields on History, Runtimes, Skills and Extensions', async ({ page }) => {
  for (const [section, label] of [
    ['history', 'Search history titles'],
    ['runtimes', 'Search runtimes or accounts'],
    ['skills', 'Search skills'],
    ['extensions', 'Search plugins'],
  ] as const) {
    await openFrame(page, section === 'history' ? 'history=rows' : `frame-wall=settings&frame-section=${section}&frame-settings-round4=1`, 'light', 1440)
    const field = page.getByRole('searchbox', { name: label, exact: true })
    await expect(field, `${section} renders the search with its named data`).toBeVisible()
    const fieldPlacement = await field.evaluate(input => {
      const search = input.closest<HTMLElement>('[data-slot="search"]')!
      return {
        placeholder: (input as HTMLInputElement).placeholder,
        pageChild: search.parentElement?.getAttribute('data-slot'),
        borderedRow: search.closest('[data-slot="row"]') !== null,
        rowsCard: search.closest('[data-slot="rows"]') !== null,
      }
    })
    expect(fieldPlacement.pageChild, `${section} search is its own page block`).toBe('page')
    expect(fieldPlacement.borderedRow, `${section} has no repeated label row`).toBe(false)
    expect(fieldPlacement.rowsCard, `${section} search is not inside a bordered card`).toBe(false)
  }
})

test('FIX4 History import choices are one marked row card and filters read Agent and Project', async ({ page }) => {
  await openFrame(page, 'frame-wall=settings&frame-section=history&frame-settings-round4=1', 'light', 1440)
  const empty = page.locator('[data-page-destination="settings"]:visible [data-slot="empty-state"]')
  await expect(empty).toBeVisible()
  expect(await empty.innerText()).toContain('Import history from an agent’s settings page.')
  await expect(empty).toContainText('Nothing imported yet')
  await expect(page.getByRole('searchbox', { name: 'Search history titles', exact: true })).toHaveCount(0)
  await expect(page.getByRole('combobox', { name: 'Agent', exact: true })).toHaveCount(0)
  await expect(page.getByRole('combobox', { name: 'Project', exact: true })).toHaveCount(0)
  const card = empty.locator('[data-slot="rows"]')
  const importRows = card.locator(':scope > button[data-kind="record"]')
  await expect(importRows).toHaveCount(6)
  for (const row of await importRows.all()) {
    await expect(row.locator('[data-slot="row-mark"]')).toBeVisible()
    expect(await row.locator('svg').count(), 'each import row has a trailing chevron').toBeGreaterThan(0)
  }
  // R11.18 hides filters only while there is nothing to search.
  await openFrame(page, 'history=rows', 'light', 1440)
  await expect(page.getByRole('searchbox', { name: 'Search history titles', exact: true })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Agent', exact: true })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Project', exact: true })).toBeVisible()
})

test('R10 nav4 Settings Back and Meta bracket leave in one step while Forward is ignored there', async ({ page }) => {
  await openFrame(page, 'frame-wall=navigation', 'light')
  const column = page.locator('[data-left-column]:visible')
  await column.locator('[data-left-seat]').getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.locator('[data-page-destination="settings"]:visible')
  const nav = page.getByRole('navigation', { name: 'Settings navigation' })
  await expect(settings).toHaveCount(1)
  await nav.getByRole('button', { name: 'General', exact: true }).click()
  await nav.getByRole('button', { name: 'Appearance', exact: true }).click()
  await nav.getByRole('button', { name: 'Runtimes', exact: true }).click()
  await page.keyboard.press('Meta+]')
  await expect(nav.getByRole('button', { name: 'Runtimes', exact: true })).toHaveAttribute('aria-current', 'page')
  await page.keyboard.press('Meta+[')
  await expect(settings).toHaveCount(0)
  await expect(page.locator('[data-slot="retained-work"]:visible')).toHaveCount(1)
  await column.locator('[data-left-seat]').getByRole('button', { name: 'Settings', exact: true }).click()
  const reopened = page.getByRole('navigation', { name: 'Settings navigation' })
  await reopened.getByRole('button', { name: 'General', exact: true }).click()
  await reopened.getByRole('button', { name: 'Appearance', exact: true }).click()
  await reopened.getByRole('button', { name: 'Runtimes', exact: true }).click()
  await nav.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page.locator('[data-page-destination="settings"]:visible')).toHaveCount(0)
  await expect(page.locator('[data-slot="retained-work"]:visible')).toHaveCount(1)
})

for (const theme of WALL_THEMES) {
  test(`D5 preference groups and search in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=settings-middle', theme)
    const nav = page.locator('[data-left-settings]')
    const labels = await nav.locator('[data-left-group-text]').allTextContents()
    expect(labels).toEqual(['General', 'Conversations', 'Agents', 'Access'])
    for (const row of await nav.locator('[data-left-row]').all()) {
      expect((await row.boundingBox())!.height).toBe(FRAME.rail.rowHeight)
    }
    await expect(nav.getByRole('button', { name: 'Back', exact: true })).toBeVisible()
    await expect(nav.getByRole('button', { name: 'Library', exact: true })).toHaveCount(0)
    await expect(nav.getByRole('button', { name: 'Plugins', exact: true })).toHaveCount(0)
    await nav.getByRole('searchbox', { name: 'Search settings' }).fill('mute')
    await expect(nav.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible()
    await expect(nav.getByRole('button', { name: 'General', exact: true })).toHaveCount(0)
    await nav.getByRole('searchbox', { name: 'Search settings' }).fill('zzzz')
    await expect(nav).toContainText('Nothing in settings matches')
  })
}


for (const theme of WALL_THEMES) {
  test(`D5 controlled keyboard, Back and full search field in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=settings-middle', theme)
    const nav = page.locator('[data-left-settings]')
    const back = nav.getByRole('button', { name: 'Back', exact: true })
    const general = nav.getByRole('button', { name: 'General', exact: true })
    const appearance = nav.getByRole('button', { name: 'Appearance', exact: true })
    await expect(general).toHaveAttribute('aria-current', 'page')
    await back.focus()
    await page.keyboard.press('ArrowDown')
    await expect(general).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(appearance).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(appearance).toHaveAttribute('aria-current', 'page')
    await back.focus()
    await page.keyboard.press('Enter')
    await expect(general).toHaveAttribute('aria-current', 'page')
    const search = nav.getByRole('searchbox', { name: 'Search settings' })
    await search.focus()
    await page.keyboard.press('ArrowDown')
    await expect(search).toBeFocused()
    const field = (await nav.locator('[data-slot="search"]').boundingBox())!
    const middle = (await nav.boundingBox())!
    expect(field.x).toBe(middle.x)
    expect(field.width).toBe(middle.width)
    await search.fill('no matching preference with a deliberately long search phrase')
    const empty = await nav.locator('p').evaluate(node => ({
      height: node.getBoundingClientRect().height,
      line: parseFloat(getComputedStyle(node).lineHeight),
      width: node.clientWidth,
      scroll: node.scrollWidth,
    }))
    expect(empty.height).toBeGreaterThan(empty.line)
    expect(empty.scroll).toBeLessThanOrEqual(empty.width)
  })
}
for (const theme of WALL_THEMES) {
  test(`D6a owner top order and seat bell in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation', theme)
    const column = page.locator('[data-left-column]:visible')
    expect((await column.boundingBox())!.width).toBe(FRAME.sidebar.width)
    const top = column.locator('[data-left-top]')
    expect(await top.locator('button').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))))
      .toEqual(['Hide sidebar', 'Search everything', 'Back', 'Forward'])
    await expect(top.locator('[data-slot="inbox-button"]')).toHaveCount(0)
    const seat = column.locator('[data-left-seat]')
    const bell = seat.locator('[data-slot="inbox-button"]').locator('..')
    await expect(bell).toBeVisible()
    expect((await bell.boundingBox())!.width).toBe(FRAME.bar.iconButton)
    expect((await bell.boundingBox())!.height).toBe(FRAME.bar.iconButton)
    const gear = seat.getByRole('button', { name: 'Settings', exact: true })
    expect((await gear.boundingBox())!.x).toBeGreaterThan((await bell.boundingBox())!.x)
    await bell.click()
    await expect(page.getByRole('dialog', { name: 'Inbox', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
  })
}

test('D6 active Settings column owns the gear and keyboard focus', async ({ page }) => {
  await openFrame(page, 'frame-wall=settings', 'light')
  const modal = page.locator('[data-slot="app-window"]:visible')
  const column = modal.locator('[data-left-column]:visible')
  await expect(column).toHaveCount(1)
  await expect(column.locator('[data-left-seat] button[aria-label="Settings"]')).toHaveAttribute('aria-pressed', 'true')
  await column.getByRole('button', { name: 'Appearance', exact: true }).focus()
  await page.keyboard.press('ArrowDown')
  await expect(column.getByRole('button', { name: 'Notifications', exact: true })).toBeFocused()
  await expect(page.locator('[data-frame-region="left"] [data-left-column]:visible')).toHaveCount(0)
})

for (const theme of WALL_THEMES) {
  for (const width of [1440, 1100, 720]) {
    test(`D6 Settings is a visible aligned mode at ${width} in ${theme}`, async ({ page }) => {
      await openFrame(page, 'frame-wall=settings-navigation', theme, width)
      const modal = page.locator('[data-slot="app-window"]:visible')
      let column = modal.locator('[data-left-column]:visible')
      if (await column.count() === 0) {
        await modal.getByRole('button', { name: 'Show sidebar', exact: true }).click()
      }
      column = modal.locator('[data-left-column]:visible')
      await expect(column).toHaveCount(1)
      const top = column.locator('[data-left-top] [data-slot="bar"]')
      const main = modal.locator('[data-shell-host="top"] [data-slot="bar"]')
      const topBox = (await top.boundingBox())!, mainBox = (await main.boundingBox())!
      expect(topBox.height).toBe(FRAME.bar.height)
      expect(Math.abs(topBox.y + topBox.height - mainBox.y - mainBox.height)).toBeLessThanOrEqual(1)
      const seatBox = (await column.locator('[data-left-seat]').locator('..').boundingBox())!
      await expect(modal.locator('[data-slot="status-bar"], [data-shell-host="status"]')).toHaveCount(0)
      const windowBox = (await modal.boundingBox())!
      expect(seatBox.height).toBe(FRAME.bar.height)
      expect(Math.abs(seatBox.y + seatBox.height - windowBox.y - windowBox.height)).toBeLessThanOrEqual(1)
      await expect(column.locator('[data-left-seat]').getByRole('button', { name: 'Settings', exact: true }))
        .toHaveAttribute('aria-pressed', 'true')
      const values = await column.locator('[data-left-row]:visible').evaluateAll(nodes => nodes.map(node => {
        const button = node.querySelector<HTMLElement>('[data-slot="sidebar-menu-button"]')!
        return { height: button.getBoundingClientRect().height,
          icon: button.querySelector<HTMLElement>('[data-slot="sidebar-menu-icon"]')!.getBoundingClientRect().x,
          text: button.querySelector<HTMLElement>('[data-slot="sidebar-menu-label-content"]')!.getBoundingClientRect().x }
      }))
      expect(values.length).toBeGreaterThan(10)
      await expect(column.getByRole('button', { name: 'New session', exact: true })).toHaveCount(0)
      await expect(column.locator('[aria-label="Main sections"]:visible')).toHaveCount(0)
      for (const row of values) expect(row.height).toBe(FRAME.rail.rowHeight)
      for (const edge of ['text', 'icon'] as const) {
        const xs = values.map(row => row[edge])
        expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(1)
      }
      await column.getByRole('searchbox', { name: 'Search settings' }).fill('mute')
      await expect(column.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible()
      await expect(column.getByRole('button', { name: 'General', exact: true })).toHaveCount(0)
      await column.getByRole('searchbox', { name: 'Search settings' }).fill('')
      await column.getByRole('button', { name: 'Appearance', exact: true }).click()
      await expect(column.getByRole('button', { name: 'Appearance', exact: true })).toHaveAttribute('aria-current', 'page')
      await column.getByRole('button', { name: 'Settings', exact: true }).click()
      await expect(column.getByRole('button', { name: 'Appearance', exact: true })).toHaveAttribute('aria-current', 'page')
      await column.locator('[data-left-settings]').getByRole('button', { name: 'Back', exact: true }).click()
      await expect(page.locator('[data-slot="app-window"]:visible')).toHaveCount(0)
    })
  }
  for (const destination of ['library', 'plugins']) {
    test(`D6 ${destination} keeps its Sessions door in ${theme}`, async ({ page }) => {
      await openFrame(page, `frame-wall=${destination}`, theme)
      const column = page.locator('[data-slot="app-window"]:visible [data-left-column]:visible')
      const label = destination === 'library' ? 'Library' : 'Plugins'
      await expect(column.getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-current', 'page')
      await expect(column.locator('[data-left-seat]').getByRole('button', { name: 'Settings', exact: true }))
        .toHaveAttribute('aria-pressed', 'false')
      await expect(column.locator('[data-left-settings]:visible')).toHaveCount(0)
    })
  }
}
test('D6 Escape closes the Settings float before the window and restores its lead focus', async ({ page }) => {
  await openFrame(page, 'frame-wall=settings-navigation', 'light', 720)
  const modal = page.locator('[data-slot="app-window"]:visible')
  const show = modal.getByRole('button', { name: 'Show sidebar', exact: true })
  await show.click()
  const column = modal.locator('[data-left-column]:visible')
  await expect(column).toHaveCount(1)
  const back = column.locator('[data-left-settings]').getByRole('button', { name: 'Back', exact: true })
  await back.focus()
  await page.keyboard.press('Escape')
  await expect(modal).toHaveCount(1)
  await expect(modal.locator('[data-left-column]:visible')).toHaveCount(0)
  await expect(show).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-slot="app-window"]:visible')).toHaveCount(0)
})
test('D6 float keeps portalled account actions and traps its boundary', async ({ page }) => {
  await openFrame(page, 'frame-wall=settings-navigation', 'light', 720)
  const modal = page.locator('[data-slot="app-window"]:visible')
  const show = modal.getByRole('button', { name: 'Show sidebar', exact: true })
  await show.click()
  const column = modal.locator('[data-left-column]:visible')
  const hide = column.getByRole('button', { name: 'Hide sidebar', exact: true })
  const gear = column.locator('[data-left-seat]').getByRole('button', { name: 'Settings', exact: true })
  await gear.focus(); await page.keyboard.press('Tab'); await expect(hide).toBeFocused()
  await page.keyboard.press('Shift+Tab'); await expect(gear).toBeFocused()
  await column.locator('[data-left-seat] [data-slot="popover-trigger"]:not(:has([data-slot="inbox-button"]))').click()
  await page.locator('[data-layout="profile"]:visible').click()
  await expect(column).toBeVisible()
  await expect(modal.locator('input[aria-label="Your name"]')).toBeVisible()
  await column.locator('[data-left-seat] [data-slot="popover-trigger"]:not(:has([data-slot="inbox-button"]))').click()
  await page.keyboard.press('Escape')
  await expect(column).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(column).toBeHidden(); await expect(show).toBeFocused()
  await show.click()
  await modal.locator('[data-app-window-left-frame]').click({ position: { x: 500, y: 150 } })
  await expect(column).toBeHidden(); await expect(modal).toBeVisible()
})

for (const theme of WALL_THEMES) {
  test(`D8 Settings page title has no redundant Settings crumb in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=settings-general', theme)
    await expect(page.locator('[data-page-destination="settings"]:visible')).toHaveCount(1)
    const place = page.locator('[data-slot="top-bar"]:visible [data-topbar="place"]')
    await expect(place.locator('button')).toHaveCount(0)
    await expect(place.locator('[data-topbar-title]')).toContainText('General')
  })
}

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

for (const theme of ['light', 'dark'] as const) {
  for (const width of [2200, 1440, 1100, 720]) {
    for (const section of ['general', 'appearance', 'notifications', 'shortcuts', 'workspaces', 'history', 'storage', 'archive', 'runtimes', 'models', 'skills', 'extensions', 'permissions', 'browser']) {
      test(`E2 Settings ${section} is reading at ${width} in ${theme}`, async ({ page }) => {
        await measureDestination(page, `frame-wall=settings&frame-section=${section}`, 'reading', theme, width, { more: 'absent' })
        await expect(page.locator('[data-slot="app-window"]:visible')).toHaveCount(0)
        await expect(page.locator('[data-left-column]:visible')).toHaveCount(width < 1000 ? 0 : 1)
      })
    }
  }
  test(`E2 keyboard history keeps work and terminal under Settings in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=navigation&frame-terminal=1', theme)
    const work = page.locator('[data-slot="retained-work"]')
    const transcript = work.locator('[data-transcript]').first()
    const terminal = page.locator('[data-frame-region="bottom"] [data-terminal-id]').first()
    await expect(transcript).toBeVisible()
    await transcript.evaluate(el => { el.dataset.retentionWitness = 'transcript'; el.scrollTop = 120 })
    const scroll = await transcript.evaluate(el => el.scrollTop)
    await terminal.evaluate(el => { el.dataset.retentionWitness = 'terminal' })
    const terminalId = await terminal.getAttribute('data-terminal-id')
    await page.keyboard.press('Meta+,')
    await expect(page.locator('[data-page-destination="settings"]')).toBeVisible()
    await expect(work).toBeHidden()
    await expect(work).toHaveAttribute('inert', '')
    await expect(terminal).toBeHidden()
    await expect(terminal).toHaveAttribute('data-terminal-id', terminalId!)
    await expect(terminal).toHaveAttribute('data-retention-witness', 'terminal')
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent('harnessdesk:preview-connection',{detail:'reconnecting'})))
    await expect(page.locator('[data-shell-host="main-notice"]')).toContainText('Reconnecting to HarnessDesk.')
    await expect(page.locator('[data-page-destination="settings"]')).toBeVisible()
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent('harnessdesk:preview-connection',{detail:'open'})))
    await expect(page.locator('[data-shell-host="main-notice"] [role="status"]')).toHaveCount(0)
    await page.keyboard.press('Meta+]')
    await expect(page.locator('[data-page-destination="settings"]')).toBeVisible()
    await page.keyboard.press('Meta+[')
    await expect(work).toBeVisible()
    await expect(transcript).toHaveAttribute('data-retention-witness', 'transcript')
    expect(await transcript.evaluate(el => el.scrollTop)).toBe(scroll)
    await expect(terminal).toBeVisible()
    await page.keyboard.press('Meta+]')
    await expect(page.locator('[data-page-destination="settings"]')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(work).toBeVisible()
    await expect(terminal).toHaveAttribute('data-retention-witness', 'terminal')
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
