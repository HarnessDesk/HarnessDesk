import { measureDestination, expectDestinationTab } from './frame-page-contract'
import { expect, test } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'
import { WALL_THEMES } from './frame-wall-destinations'
import { PAGE_WALL_DESTINATIONS } from './frame-wall-destinations'
import { applyFrameActions, selectFrameTab } from './frame-actions'
import { openFrame, resolvedPx, layoutDestinations } from './frame-contract-helpers'


// Contract runs measure the preview; the final wall owns images and recordings.
test.use({ screenshot: 'off', trace: 'off', video: 'off' })


for (const theme of WALL_THEMES) for (const destination of ['settings', 'agents', 'teams', 'dashboard']) {
  test(`Owner fix 2 ${destination} has one shell bar and no footer in ${theme}`, async ({ page }) => {
    await openFrame(page, `frame-wall=${destination}`, theme, 720)
    const destinationPage = page.locator(`[data-page-destination="${destination}"]:visible`)
    await expect(destinationPage).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const bar = page.locator('[data-slot="top-bar"]:visible')
    await expect(bar).toHaveCount(1)
    await expect(page.locator('[data-slot="status-bar"], [data-frame-region="status"]')).toHaveCount(0)
    await expect(page.locator('[data-slot="top-bar"]:visible')).toHaveCount(1)
    await expect(bar.locator('[data-work-tool]')).toHaveCount(0)
    expect((await bar.locator('..').boundingBox())!.height).toBe(FRAME.bar.height)
    const more = bar.getByRole('button', { name: 'More', exact: true })
    await more.focus()
    await expect(more).toBeFocused()
    await page.keyboard.press('Meta+w')
    await expect(destinationPage).toHaveCount(0)
    await expect(page.locator('[data-slot="top-bar"]:visible')).toHaveCount(1)
    await expect(page.locator('[data-slot="status-bar"]:visible')).toHaveCount(0)
  })
}

test('FIX3 page section headings share one page text edge', async ({ page }) => {
  const destinations = [
    ['Settings', 'frame-wall=settings&frame-section=runtimes'],
    ['Dashboard overview', 'frame-wall=dashboard&frame-view=overview'],
    ['Dashboard plans', 'frame-wall=dashboard&frame-view=plans'],
    ['Dashboard spend', 'frame-wall=dashboard&frame-view=spend'],
    ['Dashboard activity', 'frame-wall=dashboard&frame-view=activity'],
    ['Dashboard projects', 'frame-wall=dashboard&frame-view=projects'],
    ['Agents', 'frame-wall=agents'],
    ['Library', 'frame-wall=library'],
    ['Plugins', 'frame-wall=plugins&frame-plugin-page=installed'],
    ['Teams', 'frame-wall=teams&frame-filter=active'],
    ['Review', 'frame-wall=changes-review'],
  ] as const
  for (const [name, query] of destinations) {
    await openFrame(page, query, 'light', 1440)
    const offsets = await page.locator('[data-section-head] h2, [data-slot="section-head"] h2').evaluateAll(headings =>
      headings.filter(heading => heading.getClientRects().length).map(heading => {
        const columns = heading.closest('[data-slot="dashboard-columns"]')
        const column = columns && [...columns.children].findIndex(child => child.contains(heading))
        return { group: columns ? `column-${column}` : 'page', left: Math.round(heading.getBoundingClientRect().left * 2) / 2 }
      }),
    )
    for (const group of new Set(offsets.map(item => item.group))) {
      const groupOffsets = offsets.filter(item => item.group === group).map(item => item.left)
      expect(Math.max(...groupOffsets) - Math.min(...groupOffsets), `${name} ${group} headings share one text edge: ${groupOffsets.join(', ')}`).toBeLessThanOrEqual(1)
    }
  }
})

test('shared heading and page or panel stacks hold across preview destinations', async ({ page }) => {
  test.setTimeout(120_000)
  const stackGap = await resolvedPx(page, '--hd-card-gap')
  for (const destination of layoutDestinations) {
    await openFrame(page, destination.query, 'light', 1440)
    await applyFrameActions(page, destination)
    if (destination.id === 'settings-runtimes-add') {
      await page.getByRole('button', { name: 'Add a runtime', exact: true }).click()
      await expect(page.getByRole('searchbox', { name: 'Search the ACP registry' })).toBeVisible()
    }
    const issues = await page.evaluate(minimum => {
      const failures: string[] = []
      for (const head of document.querySelectorAll<HTMLElement>('[data-section-head], [data-slot="section-head"]')) {
        const name = head.querySelector<HTMLElement>('[data-slot="section-name"], [data-section-name]')
        const action = head.querySelector<HTMLElement>('[data-slot="section-action"]')
        if (!name || !action || !name.getClientRects().length || !action.getClientRects().length) continue
        const one = name.getBoundingClientRect(), two = action.getBoundingClientRect()
        if (one.left < two.right && two.left < one.right && one.top < two.bottom && two.top < one.bottom) {
          failures.push(`heading overlaps its control: ${name.textContent?.trim() ?? 'section'}`)
        }
      }
      const selector = [
        '[data-slot="rows"]', '[data-slot="card"]', '[data-slot="summary-list"]',
        '[data-slot="note"]', '[data-slot="banner"]', '[data-slot="search"]',
        '[data-slot="table-container"]', '[data-slot="tool-pane-message"]',
        '[data-slot="tool-pane-empty"]', '[data-slot="inspector-empty"]',
        '[data-slot="section"][data-variant="card"]', '[data-slot="section"][data-variant="quiet"]',
        '[data-slot="section"][data-variant="panel"]',
      ].join(',')
      const roots = document.querySelectorAll<HTMLElement>(
        '[data-slot="page"], [data-slot="tool-pane-body"], [data-slot="inspector-body"], [data-slot="section"][data-variant="panel"]',
      )
      for (const root of roots) {
        const candidates = [...root.querySelectorAll<HTMLElement>(selector)].filter(node => {
          const rect = node.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0 && !node.parentElement?.closest(selector)
        })
        for (let index = 0; index < candidates.length; index++) for (let next = index + 1; next < candidates.length; next++) {
          const a = candidates[index]!.getBoundingClientRect(), b = candidates[next]!.getBoundingClientRect()
          const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left)
          const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
          const gapY = a.bottom <= b.top ? b.top - a.bottom : b.bottom <= a.top ? a.top - b.bottom : null
          const gapX = a.right <= b.left ? b.left - a.right : b.right <= a.left ? a.left - b.right : null
          const gap = overlapX > 0 ? gapY : overlapY > 0 ? gapX : null
          if (gap !== null && gap < minimum - 0.5) {
            failures.push(`adjacent surfaces are ${gap.toFixed(1)}px apart (${candidates[index]!.dataset['slot']} / ${candidates[next]!.dataset['slot']})`)
          }
        }
      }
      return [...new Set(failures)]
    }, stackGap)
    expect(issues, `${destination.id} violates a shared layout rule`).toEqual([])
  }

  await openFrame(page, 'frame-wall=dashboard', 'light', 720)
  const dashboardIssues = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-section-head]')].flatMap(head => {
    const name = head.querySelector<HTMLElement>('[data-slot="section-name"]')
    const action = head.querySelector<HTMLElement>('[data-slot="section-action"]')
    if (!name || !action || !name.getClientRects().length || !action.getClientRects().length) return []
    const one = name.getBoundingClientRect(), two = action.getBoundingClientRect()
    return one.left < two.right && two.left < one.right && one.top < two.bottom && two.top < one.bottom
      ? [`${name.textContent?.trim() ?? 'section'} overlaps its control`] : []
  }))
  expect(dashboardIssues, 'Dashboard section headings must remain clear of their controls when narrow').toEqual([])

  await openFrame(page, 'frame-wall=settings-runtimes&layout-registry=1', 'light', 1440)
  await page.getByRole('button', { name: 'Add a runtime', exact: true }).click()
  const search = page.locator('[data-slot="search"]').filter({ has: page.getByRole('searchbox', { name: 'Search the ACP registry' }) })
  await expect(search).toBeVisible()
  const searchBottom = (await search.boundingBox())!.y + (await search.boundingBox())!.height
  const firstRegistryRows = page.locator('[data-page-destination="settings"]:visible [data-slot="rows"]:visible').filter({has:page.getByText('Runtime 01',{exact:true})})
  await expect(firstRegistryRows).toBeVisible()
  const firstRegistryBox = (await firstRegistryRows.boundingBox())!
  expect(firstRegistryBox.y - searchBottom).toBeGreaterThanOrEqual(stackGap - 0.5)
})

// The retired window stopgap survives as navigation behavior on actual pages.
for (const kind of ['settings', 'dashboard', 'agents', 'teams', 'library', 'plugins', 'changes-review']) {
  test(`E9 owner page ${kind} leaves main through new-work shortcuts`, async ({ page }) => {
    const open = async () => {
      await openFrame(page, 'frame-wall=navigation&frame-review=1', 'light')
      if (kind === 'changes-review') await page.evaluate(() => window.dispatchEvent(new CustomEvent('harnessdesk:review')))
      else await page.locator('[data-left-column]:visible').getByRole('button', {name: kind === 'settings' ? 'Settings' : kind[0]!.toUpperCase() + kind.slice(1), exact:true}).click()
      await expect(page.locator(`[data-page-destination="${kind}"]:visible`)).toHaveCount(1)
    }
    for (const chord of ['Meta+n', 'Meta+Shift+n']) {
      await open()
      await page.keyboard.press(chord)
      if (chord === 'Meta+Shift+n') {
        await expect(page.locator(`[data-page-destination="${kind}"]:visible`)).toHaveCount(1)
        await expect(page.getByRole('dialog', { name: 'New Team', exact: true })).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(page.locator(`[data-page-destination="${kind}"]:visible`)).toHaveCount(1)
      } else {
        await expect(page.locator(`[data-page-destination="${kind}"]:visible`)).toHaveCount(0)
        await expect(page.locator('[data-slot="retained-work"]:visible')).toHaveCount(1)
      }
    }
  })
  if (kind !== 'settings') test(`E9 owner page ${kind} every column door and work row navigates`, async ({ page }) => {
    for (const label of ['Teams','Agents','Library','Plugins','Dashboard','Settings','New session','conversation']) {
      if (label.toLowerCase() === kind) continue
      await openFrame(page, 'frame-wall=navigation&frame-review=1', 'light')
      const column = page.locator('[data-left-column]:visible')
      if (kind === 'changes-review') await page.evaluate(() => window.dispatchEvent(new CustomEvent('harnessdesk:review')))
      else await column.getByRole('button', {name:kind[0]!.toUpperCase()+kind.slice(1),exact:true}).click()
      await expect(page.locator(`[data-page-destination="${kind}"]:visible`)).toHaveCount(1)
      if (label === 'conversation') await column.locator('[data-region="session-row"] [data-slot="sidebar-menu-button"]').first().click()
      else await column.getByRole('button', {name:label,exact:true}).click()
      await expect(page.locator(`[data-page-destination="${kind}"]:visible`)).toHaveCount(0)
      if (label === 'conversation' || label === 'New session') await expect(page.locator('[data-slot="retained-work"]:visible')).toHaveCount(1)
      else await expect(page.locator(`[data-page-destination="${label.toLowerCase()}"]:visible`)).toHaveCount(1)
    }
  })
}

// E9: the More door exists only while its destination has at least one row.
test('E9 every destination More either stays absent or opens rows, and returns for actions', async ({ page }) => {
  test.setTimeout(120_000)
  await openFrame(page, 'frame-wall=navigation', 'light')
  const column = page.locator('[data-left-column]:visible')
  const more = page.locator('[data-slot="top-bar"]:visible [data-topbar="more"] button')
  await column.getByRole('button', { name: 'Dashboard', exact: true }).click()
  await expect(page.locator('[data-page-destination="dashboard"]:visible')).toHaveCount(1)
  await expect(more).toHaveCount(0)
  await column.getByRole('button', { name: 'Library', exact: true }).click()
  await expect(page.locator('[data-page-destination="library"]:visible')).toHaveCount(1)
  await expect(more).toBeVisible()
  await more.click()
  await expect(page.getByRole('menu').locator('[role^="menuitem"], [role="switch"]')).toHaveCount(2)

  const routes = [...new Set(PAGE_WALL_DESTINATIONS.map(destination => destination.query))]
  for (const query of routes) {
    await openFrame(page, query, 'light')
    const trigger = page.locator('[data-slot="top-bar"]:visible [data-topbar="more"] button')
    if (await trigger.count()) {
      await trigger.click()
      const rows = page.getByRole('menu').locator('[role^="menuitem"], [role="switch"]')
      expect(await rows.count(), `${query} opens a menu with at least one row`).toBeGreaterThan(0)
    }
  }
})

// R10 nav4 owns these round-four navigation and Changes review contracts.
test('R10 nav4 New Team keeps the Teams page behind the dialog from the top bar', async ({ page }) => {
  await openFrame(page, 'frame-wall=teams', 'light')
  await page.locator('[data-slot="top-bar"]:visible').getByRole('button', { name: 'New Team', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.locator('[data-page-destination="teams"]:visible')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('[data-page-destination="teams"]:visible')).toHaveCount(1)
})

test('R10 nav4 New Team keeps the empty Teams page behind the dialog', async ({ page }) => {
  await openFrame(page, 'frame-wall=teams&frame-empty=1', 'light')
  const teams = page.locator('[data-page-destination="teams"]:visible')
  await teams.getByRole('button', { name: 'New Team', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(teams).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(teams).toHaveCount(1)
})

test('R10 nav4 opening the fourth storefront conversation keeps project recency order', async ({ page }) => {
  await openFrame(page, 'frame-wall=navigation&frame-recency=1', 'light')
  const project = page.locator('[data-left-column]:visible [data-project-root="/work/storefront"]')
  await expect(project).toBeVisible()
  const rows = project.locator('[data-region="session-row"]')
  await expect(rows).toHaveCount(4)
  const labels = async () => rows.evaluateAll(elements => elements.map(element => element.querySelector('[data-left-row] > button')?.getAttribute('aria-label')))
  const before = await labels()
  expect(before).toEqual([
    'Review the checkout plan', 'Inspect basket validation', 'Adjust retry handling', 'Check payment edge cases',
  ])
  const fourth = rows.nth(3).locator('[data-left-row] > button')
  await fourth.click()
  await expect(fourth).toHaveAttribute('aria-current', 'page')
  expect(await labels()).toEqual(before)
})

for (const kind of ['library','plugins','dashboard']) test(`E9 owner Escape leaves the former ${kind} window destination`, async ({page}) => {
  await openFrame(page,'frame-wall=navigation','light')
  await page.locator('[data-left-column]:visible').getByRole('button',{name:kind[0]!.toUpperCase()+kind.slice(1),exact:true}).click()
  await expect(page.locator(`[data-page-destination="${kind}"]:visible`)).toHaveCount(1)
  const more = page.locator('[data-slot="top-bar"]:visible [data-topbar="more"] button')
  if (kind === 'library') {
    await expect(more).toBeVisible()
    await more.click()
    await page.keyboard.press('Escape')
    await expect(page.locator(`[data-page-destination="${kind}"]:visible`)).toHaveCount(1)
    await expect(page.locator('[role="menu"]:visible')).toHaveCount(0)
    await page.locator('[data-slot="top-bar"]:visible').getByRole('button',{name:'More',exact:true}).click()
    await page.getByRole('menuitem',{name:'Import',exact:true}).click()
  } else {
    await expect(more).toHaveCount(0)
  }
  if (kind === 'library' || kind === 'plugins') {
    if (kind === 'plugins') await page.getByRole('button',{name:'Add plugin',exact:true}).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator(`[data-page-destination="${kind}"]:visible`)).toHaveCount(1)
  }
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-slot="retained-work"]:visible')).toHaveCount(1)
})

for (const theme of ['light', 'dark'] as const) for (const width of [1440, 1100, 720]) {
  test(`E1a navigation model preserves the work frame ${width} ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=team', theme, width)
    const bar = page.locator('[data-slot="top-bar"]:visible')
    expect((await bar.locator('..').boundingBox())!.height).toBe(FRAME.bar.height)
    await expect(page.locator('[data-slot="status-bar"], [data-shell-host="status"]')).toHaveCount(0)
  })
}
for (const theme of WALL_THEMES) {
  test(`E1b retained work shares the terminal and notice in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=team&frame-terminal=1', theme)
    await expect(page.locator('[data-slot="retained-work"]')).toBeVisible()
    await expect(page.locator('[data-slot="top-bar"]:visible')).toHaveCount(1)
    await expect(page.locator('[data-slot="status-bar"], [data-shell-host="status"]')).toHaveCount(0)
    await expect(page.locator('[data-shell-host="main-notice"]')).toHaveCount(1)
    await expect(page.locator('[data-slot="retained-work"] [data-shell-host="main-notice"]')).toHaveCount(0)
    const terminal = page.locator('[data-frame-region="bottom"] [data-terminal-id]').first()
    await expect(terminal).toBeVisible()
    await terminal.evaluate(node => { node.setAttribute('data-retention-witness', 'E1b') })
    await selectFrameTab(page, 'overview')
    await expect(terminal).toHaveAttribute('data-retention-witness', 'E1b')
  })
  for (const width of [1440,720]) {
    test(`E1b linked ancestors remain clickable at the final fold ${width} ${theme}`, async ({ page }) => {
      await openFrame(page, 'frame-wall=topbar&frame-parents=1', theme, width)
      const bar = page.locator('[data-slot="top-bar"]')
      await expect(bar.locator('[data-topbar="place"] button')).toHaveCount(width===1440 ? 3 : 1)
      const labels = await bar.locator('[data-topbar="place"] button').allTextContents()
      expect(labels).toEqual(width===1440 ? ['Settings ›','Runtimes ›','Alpha ›'] : ['Alpha ›'])
      expect((await bar.locator('[data-topbar-title]').boundingBox())!.width).toBeGreaterThanOrEqual(FRAME.bar.titleMin)
      await bar.getByRole('button',{name:'Alpha ›',exact:true}).click()
      const receipt = page.locator('[data-parent-choice]')
      await expect(receipt).toHaveAttribute('data-parent-choice','Alpha')
      if (width===720) {
        await expect(bar).toHaveAttribute('data-fold','3')
        await bar.getByRole('button',{name:'More',exact:true}).click()
        const menu = page.getByRole('menu')
        await expect(menu.getByRole('menuitem').first()).toHaveText('Start a conversation with this account')
        await menu.getByRole('menuitem',{name:'Settings',exact:true}).click()
      } else await bar.getByRole('button',{name:'Settings ›',exact:true}).click()
      await expect(receipt).toHaveAttribute('data-parent-choice','Settings')
    })
    test(`E1b bar controls resolve to no-drag ${width} ${theme}`, async ({ page }) => {
      await openFrame(page, 'frame-wall=topbar&frame-parents=1', theme, width)
      const bar = page.locator('[data-slot="top-bar"]')
      expect(await bar.locator('..').evaluate(node=>getComputedStyle(node).getPropertyValue('-webkit-app-region'))).toBe('drag')
      const controls = bar.locator('button:visible, a:visible, input:visible, select:visible, textarea:visible, [role="tab"]:visible, [role="button"]:visible')
      const regions = await controls.evaluateAll(nodes=>nodes.map(node=>({label:node.getAttribute('aria-label')??node.textContent,region:getComputedStyle(node).getPropertyValue('-webkit-app-region')})))
      expect(regions.length).toBeGreaterThan(2)
      for (const control of regions) expect(control.region,control.label??'bar control').toBe('no-drag')
    })
  }
}

for (const theme of ['light', 'dark'] as const) for (const width of [1440, 1100, 720]) {
  test(`E9 only the permanent shell frames a destination ${width} ${theme}`, async ({ page }) => {
    await measureDestination(page, 'frame-wall=plugins&frame-plugin-page=capabilities', 'wide', theme, width, { more: 'absent' })
    await expect(page.locator('[data-app-window-left-frame], [data-slot="app-window"]')).toHaveCount(0)
    await expect(page.locator('[data-slot="page-head"], [data-slot="detail-head"]')).toHaveCount(0)
    await expectDestinationTab(page, 'capabilities')
  })
}
