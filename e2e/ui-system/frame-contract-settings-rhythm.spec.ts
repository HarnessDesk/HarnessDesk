import { expect, test } from '@playwright/test'
import { openFrame } from './frame-contract-helpers'
import { useFrameContractEvidence } from './frame-contract-split-setup'

useFrameContractEvidence()



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
