import { expectPageJourney } from './frame-page-contract'
import { expect, test } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'
import { PREVIEW_ROOT } from '../../packages/ui/src/preview/sidebar-fixture'
import { WALL_TIME } from './frame-wall-destinations'
import { applyFrameActions } from './frame-actions'
import { openFrame, resolvedPx, layoutDestinations } from './frame-contract-helpers'


// Contract runs measure the preview; the final wall owns images and recordings.
test.use({ screenshot: 'off', trace: 'off', video: 'off' })


test('FIX3 Dashboard figures share one treatment and value baseline', async ({ page }) => {
  await openFrame(page, 'frame-wall=dashboard&frame-view=overview', 'light', 1440)
  const facts = page.locator('[aria-label="What it cost, in brief"] [data-slot="stat"]')
  await expect(facts).toHaveCount(4)
  const geometry = await facts.evaluateAll(nodes => nodes.map(node => {
    const value = [...node.querySelectorAll<HTMLElement>('*')].find(child => child.className.toString().includes('text-xl'))!
    return { treatment: (node as HTMLElement).dataset['variant'], top: value.getBoundingClientRect().top }
  }))
  expect(new Set(geometry.map(item => item.treatment)).size, 'all four overview figures use one stat treatment').toBe(1)
  expect(Math.max(...geometry.map(item => item.top)) - Math.min(...geometry.map(item => item.top)), 'all four values share a baseline').toBeLessThanOrEqual(1)
})

test('FIX3 Dashboard Plans link text starts on its section text edge', async ({ page }) => {
  await openFrame(page, 'frame-wall=dashboard&frame-view=overview', 'light', 1440)
  const geometry = await page.getByRole('button', { name: 'See all in Plans', exact: true }).evaluate(button => {
    const range = document.createRange()
    range.selectNodeContents(button)
    const text = range.getBoundingClientRect()
    const heading = document.querySelector('[aria-label="What is left"] [data-section-name]')!.getBoundingClientRect()
    return { textLeft: text.left, headingLeft: heading.left }
  })
  expect(Math.abs(geometry.textLeft - geometry.headingLeft), 'link text aligns with the section name').toBeLessThanOrEqual(1)
})

test('FIX3 partial spend qualifier sits beside its figure', async ({ page }) => {
  await openFrame(page, 'frame-wall=dashboard&frame-view=spend', 'light', 1440)
  const qualifiers = page.locator('[data-page-destination="dashboard"]:visible').getByText('so far', { exact: true })
  await expect(qualifiers).toHaveCount(2)
  for (const node of await qualifiers.all()) {
    const positions = await node.evaluate(node => {
      const stat = node.closest('[data-slot="stat"]')!
      const figure = stat.querySelector<HTMLElement>('[data-role="metric"]')!
      return { figure: figure.getBoundingClientRect().toJSON(), qualifier: node.getBoundingClientRect().toJSON() }
    })
    expect(positions.qualifier.left, 'the qualifier follows the value').toBeGreaterThanOrEqual(positions.figure.right - 1)
    expect(positions.qualifier.top, 'the qualifier shares the figure line').toBeLessThan(positions.figure.bottom)
  }
})

{

  for (const [item0, [tab, sections]] of ([
    ['overview', ['Where it went']],
    ['spend', ['What it cost', 'Where it went']],
    ['activity', ['When it ran']],
  ] as const).entries()) test(`FIX3 section choices live in the same page head across Dashboard tabs [item ${[item0].join('-')}]`, async ({ page }) => {

    await openFrame(page, `frame-wall=dashboard&frame-view=${tab}`, 'light', 1440)
    for (const title of sections) {
      const section = page.locator(`[aria-label="${title}"]`)
      const headOptions = section.locator('[data-slot="section-head"] [data-slot="page-options"]')
      await expect(headOptions).toHaveCount(tab === 'spend' && title === 'What it cost' ? 2 : 1)
      await expect(section.locator(':scope > [data-slot="rows"]')).toHaveCount(0)
    }


  })
}

test('FIX3 Plans status chips fit their words in the Status column', async ({ page }) => {
  await openFrame(page, 'frame-wall=dashboard&frame-view=plans', 'light', 1440)
  const status = page.locator('[data-dashboard-table="plans"] [data-slot="chip"]').filter({ hasText: 'Not reporting' }).first()
  await expect(status).toBeVisible()
  const fits = await status.evaluate(node => {
    const text = node.querySelector('[data-slot="text"]') ?? node
    return { label: text.textContent?.trim(), client: text.clientWidth, scroll: text.scrollWidth, column: node.closest('td')?.getBoundingClientRect().width ?? 0 }
  })
  expect(fits.label).toBe('Not reporting')
  expect(fits.scroll).toBeLessThanOrEqual(fits.client + 1)
  expect(fits.column, 'the Status column leaves room for the whole chip').toBeGreaterThanOrEqual(152)
})

test('FIX3 Projects warning spans the usage table', async ({ page }) => {
  await openFrame(page, 'frame-wall=dashboard&frame-view=projects&amounts=unknown', 'light', 1440)
  const warning = page.locator('[data-slot="alert"]').filter({ hasText: 'Amounts are unknown for this range' })
  await expect(warning).toBeVisible()
  const widths = await warning.evaluate(node => ({ warning: node.getBoundingClientRect().width, table: document.querySelector('[data-dashboard-table="insight"]')?.getBoundingClientRect().width ?? 0 }))
  expect(Math.abs(widths.warning - widths.table), 'the range warning and attribution table share a section width').toBeLessThanOrEqual(1)
})

{

  for (const [item0, tab] of (['activity', 'overview']).entries()) test(`FIX3 heatmap cells follow weekday labels and keep a partial first week [item ${[item0].join('-')}]`, async ({ page }) => {
    await page.clock.install({ time: WALL_TIME })
    await openFrame(page, `frame-wall=dashboard&frame-view=${tab}`, 'light', 1440)
    const geometry = await page.locator('[role="group"][aria-label="Tokens or cost per day, last 12 months"]').evaluate(grid => {
      const labels = [...grid.querySelectorAll<HTMLElement>('[class*="header"]')]
      const first = [...grid.querySelectorAll<HTMLElement>('[data-level], [data-state]')]
        .filter(cell => cell.style.gridRow === '8').sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0]!
      const blanks = [...grid.querySelectorAll<HTMLElement>('[aria-hidden="true"]')]
        .filter(cell => !cell.hasAttribute('data-level') && !cell.hasAttribute('data-state') && cell.style.gridColumn === '2' && Number(cell.style.gridRow) >= 2 && Number(cell.style.gridRow) <= 8)
      const labelEdge = Math.max(...labels.map(label => label.getBoundingClientRect().right + Number.parseFloat(getComputedStyle(label).marginRight)))
      return { labelEdge, firstCell: first.getBoundingClientRect().left, leadingBlanks: blanks.length }
    })
    expect(geometry.firstCell, `${tab} cells start after the weekday labels`).toBeGreaterThanOrEqual(geometry.labelEdge)
    expect(geometry.leadingBlanks, `${tab} leaves the partial first week blank before its weekend`).toBeGreaterThan(0)


  })
}

test.describe('FIX4 Dashboard contracts', () => {
  test('Overview captions and figure labels share their text baseline', async ({ page }) => {
    await openFrame(page, 'frame-wall=dashboard&frame-view=overview&frame-unpriced-paid=1', 'light', 1440)
    const geometry = await page.locator('[aria-label="What it cost, in brief"]').evaluate(root => {
      const figures = [...root.querySelectorAll<HTMLElement>('[data-slot="stat"]')]
      const paid = figures[0]!.querySelector<HTMLElement>('[data-slot="stat-label"]')!
      const paidText = document.createRange()
      paidText.selectNodeContents(paid)
      const link = [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('Set plan prices'))!
      const linkText = document.createRange()
      linkText.selectNodeContents(link)
      const labelTops = figures.map(figure => {
        const label = figure.querySelector<HTMLElement>('[data-slot="stat-label"]')!
        const firstLabel = label.firstElementChild ?? label
        const text = document.createRange()
        text.selectNode([...firstLabel.childNodes].find(node => node.nodeType === Node.TEXT_NODE)!)
        return text.getBoundingClientRect().top
      })
      return { paidEdge: paidText.getBoundingClientRect().left, linkEdge: linkText.getBoundingClientRect().left, labelTops }
    })
    expect(Math.abs(geometry.linkEdge - geometry.paidEdge), 'Set plan prices begins at the Paid text edge').toBeLessThanOrEqual(1)
    expect(Math.max(...geometry.labelTops) - Math.min(...geometry.labelTops), 'all Overview figure labels share a baseline').toBeLessThanOrEqual(1)
  })

  test('Overview selection is a chip and the figure hover plate is outdented', async ({ page }) => {
    await openFrame(page, 'frame-wall=dashboard&frame-view=overview', 'light', 1440)
    const turns = page.locator('[aria-label="What it cost, in brief"] button').filter({ hasText: 'Turns' })
    await turns.click()
    await expect(page.getByText('Turns per day', { exact: true })).toBeVisible()
    const selected = page.locator('[aria-label="What it cost, in brief"] button[aria-pressed="true"]')
    const chip = selected.locator('[data-slot="chip"]')
    await expect(chip).toHaveText('Selected')
    await expect(chip).toHaveAttribute('data-variant', 'default')
    await selected.hover()
    const geometry = await selected.evaluate(button => {
      const label = button.querySelector<HTMLElement>('[data-slot="stat-label"]')!
      const firstLabel = label.firstElementChild ?? label
      const text = document.createRange()
      text.selectNode([...firstLabel.childNodes].find(node => node.nodeType === Node.TEXT_NODE)!)
      const style = getComputedStyle(button)
      return { plateLeft: button.getBoundingClientRect().left, textLeft: text.getBoundingClientRect().left, paddingLeft: parseFloat(style.paddingLeft) }
    })
    const inset = await resolvedPx(page, '--hd-space-2')
    expect(geometry.textLeft - geometry.plateLeft, 'the hover plate pulls back by its inset').toBeCloseTo(inset, 1)
    expect(geometry.paddingLeft, 'button padding keeps the figure text on its column edge').toBeCloseTo(inset, 1)
  })

  {

    for (const [item0, width] of ([1100, 720]).entries()) test(`four Overview figures never wrap into a lone final row [item ${[item0].join('-')}]`, async ({ page }) => {

      await openFrame(page, 'frame-wall=dashboard&frame-view=overview', 'light', width)
      const rows = await page.locator('[aria-label="What it cost, in brief"] [data-slot="stat-row"]').evaluate(row => {
        const figures = [...row.querySelectorAll<HTMLElement>('[data-slot="stat"]')]
        const sorted = figures.map(figure => figure.getBoundingClientRect().top).sort((a, b) => a - b)
        const grouped: { top: number; count: number }[] = []
        for (const top of sorted) {
          const row = grouped[grouped.length - 1]
          if (row && top - row.top <= 2) row.count += 1
          else grouped.push({ top, count: 1 })
        }
        return grouped.map(row => row.count)
      })
      expect(rows.every(count => count >= 2) && (rows.length === 1 ? rows[0] === 4 : rows.length === 2 && rows.every(count => count === 2)), `four figures at ${width}px do not leave one alone`).toBe(true)


    })
  }

  test('empty Activity uses no busiest day and its five figures have no lone row', async ({ page }) => {
    await openFrame(page, 'frame-wall=dashboard&frame-view=activity&frame-empty-usage=1', 'light', 720)
    const stats = await page.locator('[data-page-destination="dashboard"] [data-slot="stat-row"] [data-slot="stat"]').evaluateAll(figures => figures.map(figure => ({
      label: figure.querySelector<HTMLElement>('[data-slot="stat-label"]')?.textContent?.trim(),
      value: figure.querySelector<HTMLElement>('.text-xl')?.textContent?.trim(),
      y: Math.round(figure.getBoundingClientRect().top),
    })))
    expect(stats).toHaveLength(5)
    expect(stats[3]?.label, 'zero activity uses the busiest day label, not the range start date').toBe('Busiest day')
    expect(stats[3]?.value, 'zero activity has no busiest day or zero figure').toBe('—')
    const rows = new Map<number, number>()
    for (const stat of stats) rows.set(stat.y, (rows.get(stat.y) ?? 0) + 1)
    expect([...rows.values()].every(count => count > 1), 'a wrapped five-figure strip never strands one figure').toBe(true)
  })

  test('empty Projects keeps amount warning and attribution copy in one section surface', async ({ page }) => {
    await openFrame(page, 'frame-wall=dashboard&frame-view=projects&frame-empty-usage=1', 'light', 1440)
    const project = PREVIEW_ROOT.split('/').at(-1)!
    const section = page.getByRole('region', { name: `Team usage in ${project}`, exact: true })
    await expect(section.getByText(`No Team usage in ${project} in the last 30 days`, { exact: true })).toBeVisible()
    await expect(section.locator('[data-slot="alert"], [data-slot="rows"], [data-dashboard-table="insight"]')).toHaveCount(0)
    await expect(section.getByRole('button', { name: 'Last 24 hours', exact: true })).toHaveCount(0)
    const geometry = await section.evaluate(node => {
      const page = node.closest('[data-slot="page"]')!
      const css = getComputedStyle(page)
      return { width: node.getBoundingClientRect().width, content: page.getBoundingClientRect().width - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight) }
    })
    expect(geometry.width, 'the empty section fills the page content').toBeCloseTo(geometry.content, 1)
    expect(geometry.width).toBeLessThanOrEqual(FRAME.page.wide)
  })

  test('Projects view select uses sentence case', async ({ page }) => {
    await openFrame(page, 'frame-wall=dashboard&frame-view=projects&frame-empty-usage=1', 'light', 1440)
    const select = page.getByRole('combobox', { name: 'Project usage view' })
    const options = await select.locator('option').evaluateAll(nodes => nodes.map(node => node.textContent?.trim()))
    expect(options).toEqual(['By team', 'By agent'])
  })

  for (const destination of layoutDestinations) {
    test(`section headings and controls share a center line on every preview page: ${destination.id}`, async ({ page }) => {
      await openFrame(page, destination.query, 'light', 1440)
      await applyFrameActions(page, destination)
      const offsets = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-section-head], [data-slot="section-head"]')].flatMap(head => {
        const name = head.querySelector<HTMLElement>('[data-section-name], [data-slot="section-name"]')
        const action = head.querySelector<HTMLElement>('[data-slot="section-action"]')
        if (!name || !action || !name.getClientRects().length || !action.getClientRects().length) return []
        return [{ name: name.textContent?.trim() ?? 'section', difference: Math.abs(name.getBoundingClientRect().bottom - action.getBoundingClientRect().bottom) }]
      }))
      for (const offset of offsets) expect(offset.difference, `${destination.id} ${offset.name} title/control centers`).toBeLessThanOrEqual(1)

    })
  }

  test('empty Spend plot message stays inside its ChartCard', async ({ page }) => {
    await openFrame(page, 'frame-wall=dashboard&frame-view=spend&frame-empty-usage=1', 'light', 1440)
    const empty = page.getByText('No usage recorded in this window', { exact: true })
    await expect(empty).toBeVisible()
    await expect(empty.locator('xpath=ancestor::*[@data-slot="chart-card"]')).toHaveCount(1)
  })
})

// E3 owns these appended witnesses. Shared wall replacement belongs to Task 9.
for (const width of [1440, 720]) {
  test(`E3 Dashboard normal column page journey ${width}`, async ({ page }) => {
    await expectPageJourney(page, 'Dashboard', 'dashboard', width)
  })
  test(`E3 Dashboard section heading clears its controls ${width}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=navigation', 'light', width)
    await page.keyboard.press('Meta+u')
    const heading = page.getByText('Where it went', { exact: true }).first()
    await expect(heading).toBeVisible()
    const head = heading.locator('xpath=ancestor::*[@data-slot="section-head"]')
    await expect(head).toHaveCount(1)
    const controls = head.locator('[data-slot="page-options"]')
    await expect(controls).toHaveCount(1)
    const textBox = await heading.evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); const box = range.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height } })
    const controlBox = (await controls.boundingBox())!
    expect(textBox.x + textBox.width <= controlBox.x || controlBox.x + controlBox.width <= textBox.x || textBox.y + textBox.height <= controlBox.y || controlBox.y + controlBox.height <= textBox.y, 'heading text never intersects its switch').toBe(true)
  })
}
test('E3 Dashboard command opens main and Back restores work', async ({ page }) => {
  await openFrame(page, 'frame-wall=navigation', 'light')
  await page.keyboard.press('Meta+u')
  await expect(page.locator('[data-page-destination="dashboard"]:visible')).toHaveCount(1)
  await expect(page.locator('[data-slot="app-window"]:visible')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-slot="retained-work"]:visible')).toHaveCount(1)
  await page.keyboard.press('Meta+[')
  await expect(page.locator('[data-page-destination="dashboard"]:visible')).toHaveCount(1)
  await page.keyboard.press('Meta+[')
  await expect(page.locator('[data-slot="retained-work"]:visible')).toHaveCount(1)
})
test('E3 Dashboard More offers the chosen project Terminal', async ({ page }) => {
  await openFrame(page, 'frame-wall=navigation', 'light')
  await page.keyboard.press('Meta+u')
  await page.locator('[data-slot="top-bar"]:visible').getByRole('button', { name: 'More', exact: true }).click()
  await expect(page.getByRole('menuitemradio', { name: /Terminal/ })).toHaveCount(1)
})
for (const theme of ['light', 'dark'] as const) for (const width of [2200, 1440, 1100, 720]) {
  for (const view of ['overview', 'plans', 'spend', 'activity', 'projects']) {
    test(`E3 Dashboard ${view} wide column ${width} ${theme}`, async ({ page }) => {
      await openFrame(page, 'frame-wall=navigation', theme, width)
      await page.keyboard.press('Meta+u')
      await expect(page.locator('[data-slot="app-window"]:visible')).toHaveCount(0)
      await page.locator('[data-page-destination="dashboard"]:visible').getByRole('tab', { name: new RegExp(`^${view[0]!.toUpperCase()}${view.slice(1)}`) }).click()
      const body = page.locator('[data-page-destination="dashboard"]:visible [data-slot="page"][data-width="wide"]')
      await expect(body).toBeVisible()
      const measure = await body.evaluate(node => { const box = node.getBoundingClientRect(), css = getComputedStyle(node), parent = node.parentElement!.getBoundingClientRect(); return { width: box.width - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight), available: parent.width, padding: [css.paddingLeft, css.paddingRight, css.paddingTop].map(parseFloat), center: (box.left + box.right - parent.left - parent.right) / 2 } })
      expect(measure.padding).toEqual([FRAME.page.gutter, FRAME.page.gutter, FRAME.page.gutter])
      expect(measure.width).toBeCloseTo(Math.min(FRAME.page.wide, measure.available - 2 * FRAME.page.gutter), 0)
      expect(Math.abs(measure.center)).toBeLessThanOrEqual(1)
      const bar = page.locator('[data-slot="top-bar"]:visible')
      await expect(bar).toHaveCount(1)
      expect((await bar.locator('..').boundingBox())!.height).toBe(FRAME.bar.height)
      await expect(bar.locator('[data-work-tool], [data-topbar="view"] button, [role="tab"]')).toHaveCount(0)
      const title = bar.locator('[data-topbar-title] [data-slot="text"]').first()
      await expect(title).toHaveText('Dashboard')
      const type = await title.evaluate(node => { const css = getComputedStyle(node); return { size: parseFloat(css.fontSize), weight: css.fontWeight, family: css.fontFamily } })
      expect(type.size).toBe(14); expect(type.weight).toBe('400'); expect(type.family).toContain('Geist')
      const options = body.locator('[data-slot="page-options"]').first()
      expect((await body.getByRole('tablist', { name: 'Dashboard views' }).boundingBox())!.y).toBeLessThan((await options.boundingBox())!.y)
      const edges = await body.evaluate(node => { const start = node.getBoundingClientRect().left + parseFloat(getComputedStyle(node).paddingLeft); return [...node.children].filter(child => child.getClientRects().length > 0).map(child => child.getBoundingClientRect().left - start) })
      for (const edge of edges) expect(Math.abs(edge)).toBeLessThanOrEqual(1)
      for (const control of await bar.locator('button:visible').all()) expect(await control.evaluate(node => getComputedStyle(node).getPropertyValue('-webkit-app-region'))).toBe('no-drag')
      await expect(page.locator('[data-frame-region="right"]:visible, [data-slot="status-bar"]')).toHaveCount(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    })
  }
}
test('E3 Dashboard keeps scope through Back/Forward and local chart state through page visits', async ({ page }) => {
  await openFrame(page, 'frame-wall=navigation', 'light')
  await page.keyboard.press('Meta+u')
  await page.getByRole('tab', { name: 'Spend', exact: true }).click()
  await page.getByRole('combobox', { name: 'Group spend by', exact: true }).selectOption('project')
  const scope = page.getByTitle('Scope the dashboard to one account', { exact: true })
  await scope.click()
  const account = page.getByRole('menuitemradio').filter({ hasNotText: 'All accounts' }).first()
  const name = await account.innerText()
  await account.click()
  await page.keyboard.press('Meta+,')
  await page.keyboard.press('Meta+[')
  await expect(page.getByRole('combobox', { name: 'Group spend by', exact: true })).toHaveValue('project')
  await expect(scope).toContainText(name)
  await page.keyboard.press('Meta+]')
  await expect(page.locator('[data-page-destination="settings"]:visible')).toHaveCount(1)
})

for (const width of [1440, 720]) test(`E3 Dashboard New session and conversation rows select work ${width}`, async ({ page }) => {
  await openFrame(page, 'frame-wall=navigation', 'light', width)
  const reveal = async () => { if (width < FRAME.fold.sidebarFloats) await page.getByRole('button', { name: 'Show sidebar', exact: true }).click() }
  await page.keyboard.press('Meta+u'); await reveal()
  await page.locator('[data-left-column]:visible').getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.locator('[data-slot="retained-work"]:visible')).toHaveCount(1)
  await expect(page.locator('[data-page-destination="dashboard"]:visible')).toHaveCount(0)
  await page.keyboard.press('Meta+u'); await reveal()
  const column = page.locator('[data-left-column]:visible')
  await column.locator('[data-region="session-row"] [data-slot="sidebar-menu-button"]').first().click()
  await expect(page.locator('[data-slot="retained-work"]:visible')).toHaveCount(1)
  await expect(page.locator('[data-page-destination="dashboard"]:visible')).toHaveCount(0)
})
