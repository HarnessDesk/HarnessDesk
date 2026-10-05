import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) {
  test(`runtime sign-out and Archive refusal stay truthful and visible in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/preview.html')
    const runtimes = page.locator('[data-frame-id="runtimes-status"]')
    const row = (name: string) => runtimes.locator('[data-slot="agent-row"]').filter({ has: page.locator('[data-slot="runtime-name"]', { hasText: name }) })
    await expect(row('Amp')).not.toContainText('Not signed in')
    await expect(row('OpenCode')).not.toContainText('Not signed in')
    await expect(row('DeepSeek')).toContainText('Not signed in')

    const archive = page.locator('[data-frame-id="settings-archive"]')
    await archive.getByRole('button', { name: 'Review the workspace settings actions', exact: true }).first().click()
    const refused = page.getByRole('menuitem', { name: 'Delete…', exact: true })
    await expect(refused).toBeDisabled()
    const description = await refused.getAttribute('aria-describedby')
    const reason = page.locator(`[id="${description}"]`)
    await expect(reason).toBeVisible()
    await expect(reason).toHaveText('Alpha keeps no way to delete one.')
    const geometry = await reason.evaluate(el => {
      const rect = el.getBoundingClientRect()
      return { width: rect.width, height: rect.height, position: getComputedStyle(el).position }
    })
    expect(geometry.width).toBeGreaterThan(1)
    expect(geometry.height).toBeGreaterThan(1)
    expect(geometry.position).not.toBe('absolute')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menuitem', { name: 'Delete…', exact: true })).toHaveCount(0)
  })

  test(`the table family shares row centres, density and selection in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/preview.html?tables')
    await page.evaluate(async () => { await document.fonts.ready })
    for (const density of ['comfortable', 'compact'] as const) {
      const section = page.locator(`section[data-hd-table="${density}"]`)
      const geometry = await section.evaluate(root => {
        const centre = (el: Element) => { const r = el.getBoundingClientRect(); return (r.top + r.bottom) / 2 }
        const firstCell = root.querySelector('[data-slot="table-cell"]')!
        const lead = firstCell.querySelector('[data-slot="table-cell-lead"]')!
        const list = root.querySelector('[data-slot="list-row"]')!
        const settings = root.querySelector('[data-slot="row"]:has([data-slot="row-ctl"])')!
        const record = root.querySelector('[data-slot="row"][data-kind="record"]')!
        const action = root.querySelector('[data-slot="row-folding"]')!
        const rule = action.querySelector('button')!
        const stack=root.querySelector('[data-slot="table-cell-lead"] [data-slot="avatar-stack"]')!
        const stackLead=stack.parentElement!.getBoundingClientRect()
        return {
          head: root.querySelector('[data-slot="table-head"]')!.getBoundingClientRect().height,
          row: firstCell.getBoundingClientRect().height,
          face: lead.getBoundingClientRect().width,
          radius: getComputedStyle(lead).borderTopLeftRadius,
          centreAlign: getComputedStyle(root.querySelector('[data-slot="table-cell"][data-align="center"]')!).textAlign,
          cellCentre: Math.abs(centre(firstCell) - centre(lead)),
          listFace: list.querySelector('[data-shape="face"]')!.getBoundingClientRect().width,
          listRadius: getComputedStyle(list.querySelector('[data-shape="face"]')!).borderTopLeftRadius,
          listCentre: Math.abs(centre(list) - centre(list.querySelector('[data-slot="list-row-lead"]')!)),
          controlCentre: Math.abs(centre(settings) - centre(settings.querySelector('[data-slot="row-ctl"]')!)),
          divider: getComputedStyle(action).borderBottomWidth,
          innerDivider: getComputedStyle(rule, '::after').display,
          description: getComputedStyle(settings.querySelector('[data-slot="row-desc"]')!).fontSize,
          name: getComputedStyle(list.querySelector('[data-slot="list-row-title"]')!).fontSize,
          recordFace: record.querySelector('[data-slot="row-face"]')!.getBoundingClientRect().width,
          recordName: getComputedStyle(record.querySelector('[data-slot="row-title"]')!).fontSize,
          recordFact: getComputedStyle(record.querySelector('[data-slot="row-desc"]')!).fontSize,
          numeric: getComputedStyle(root.querySelector('[data-slot="table-cell"][data-align="end"]')!).textAlign,
          stackFits:[...stack.querySelectorAll('[data-shape="face"]'),stack.lastElementChild!].every(el=>{
            const box=el.getBoundingClientRect();return box.left>=stackLead.left-1&&box.right<=stackLead.right+1
          }),
        }
      })
      expect(geometry.head).toBe(density === 'compact' ? 32 : 40)
      expect(geometry.row).toBeGreaterThanOrEqual(density === 'compact' ? 40 : 56)
      expect(geometry.face).toBe(density === 'compact' ? 24 : 32)
      expect(geometry.listFace).toBe(density === 'compact' ? 24 : 32)
      expect(geometry.listRadius).toBe(density === 'compact' ? '6px' : '8px')
      expect(geometry.radius).toBe(density === 'compact' ? '6px' : '8px')
      expect(geometry.centreAlign).toBe('center')
      expect(geometry.description).toBe('13px')
      expect(geometry.recordFace).toBe(density === 'compact' ? 24 : 32)
      expect(geometry.recordName).toBe(density === 'compact' ? '13px' : '14px')
      expect(geometry.recordFact).toBe('12px')
      expect(geometry.name).toBe(density === 'compact' ? '13px' : '14px')
      for (const delta of [geometry.cellCentre, geometry.listCentre, geometry.controlCentre]) expect(delta).toBeLessThan(1)
      expect(geometry.divider).toBe('1px')
      expect(geometry.innerDivider).toBe('none')
      expect(geometry.numeric).toBe('right')
      expect(geometry.stackFits).toBe(true)

      const interactive = section.locator('[data-interactive]').first()
      const reading = section.locator('[data-slot="table-row"]').nth(3)
      const resting = await reading.evaluate(el => getComputedStyle(el).backgroundColor)
      await reading.hover()
      expect(await reading.evaluate(el => getComputedStyle(el).backgroundColor)).toBe(resting)
      await interactive.hover()
      expect(await interactive.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(resting)
      const selected = section.locator('[data-slot="table-row"][data-state="selected"]').first()
      const fill = await selected.evaluate(el => getComputedStyle(el).backgroundColor)
      await selected.hover()
      expect(await selected.evaluate(el => getComputedStyle(el).backgroundColor)).toBe(fill)
      const pinned = section.locator('[data-slot="table-head"][data-pinned]')
      const selectedGround = await pinned.evaluate(el => getComputedStyle(el).backgroundImage)
      await pinned.hover()
      expect(await pinned.evaluate(el => getComputedStyle(el).backgroundImage)).toBe(selectedGround)
    }
  })
}

test('the preview and Tables catalogue mount the same family, including a narrow pane', async ({ page }) => {
  await page.goto('/design.html?view=tables')
  await expect(page.locator('[data-slot="tables-family"]')).toHaveCount(1)
  await expect(page.locator('[data-slot="table"]')).toHaveCount(4)
  await page.setViewportSize({ width: 600, height: 900 })
  await page.goto('/preview.html?tables')
  await expect(page.locator('[data-slot="tables-family"]')).toHaveCount(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(600)
})

for (const theme of ['light', 'dark'] as const) {
  test(`cut record names reveal the whole title and record layouts wrap in ${theme}`, async ({ page }) => {
    const name = 'Review the workspace settings with the shared library and project checks before starting another conversation'
    await page.route('**/src/preview/main.tsx*', async route => {
      const response = await route.fetch()
      const source = await response.text()
      const reactUrl = /from "([^"\n]*\/react\.js[^"\n]*)"/.exec(source)?.[1]
      if (!reactUrl) throw new Error('preview React import missing')
      await route.fulfill({ response, body: `${source}
        import recordReact from ${JSON.stringify(reactUrl)};
        import { Chip, Row, RowButton, Rows } from '/src/design/patterns/Settings.tsx';
        const recordFrame = document.createElement('section');
        recordFrame.setAttribute('data-frame-id', 'record-title-repair');
        recordFrame.style.cssText = 'position:fixed;inset:0 auto auto 0;width:320px;background:var(--hd-background);z-index:99999;padding:16px';
        document.body.append(recordFrame);
        const h = recordReact.createElement;
        createRoot(recordFrame).render(h(Rows, null,
          h(Row, { kind: 'record', title: ${JSON.stringify(name)} }),
          h(RowButton, { kind: 'record', title: ${JSON.stringify(name)}, onClick: () => {} }),
          h(RowButton, { kind: 'record', layout: 'record', title: ${JSON.stringify(name)}, onClick: () => {} }),
          h(RowButton, { layout: 'record', title: ${JSON.stringify(name)}, onClick: () => {} }),
          h(Row, { kind: 'record', title: ${JSON.stringify(name)}, titleChip: h(Chip, { tone: 'neutral', size: 'sm' }, 'Gateway') }),
          h(RowButton, { kind: 'record', title: ${JSON.stringify(name)}, titleChip: h(Chip, { tone: 'neutral', size: 'sm' }, 'Current'), onClick: () => {} })
        ));` })
    })
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/preview.html')
    const titles = page.locator('[data-frame-id="record-title-repair"] [data-slot="row-title"]')
    await expect(titles).toHaveCount(6)
    for (const index of [0, 1]) {
      const label = titles.nth(index).locator(':scope > span')
      expect(await label.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true)
      await label.hover()
      await expect(label).toHaveAttribute('title', name)
    }
    for (const index of [4, 5]) {
      const title = titles.nth(index)
      const chip = title.locator('[data-slot="chip"]')
      const column = await title.boundingBox()
      const mark = await chip.boundingBox()
      expect(mark!.x + mark!.width).toBeLessThanOrEqual(column!.x + column!.width + 1)
      const label = title.locator(':scope > span').first()
      await label.hover()
      await expect(label).toHaveAttribute('title', name)
    }
    for (const index of [2, 3]) {
      const label = titles.nth(index)
      expect(await label.evaluate(el => getComputedStyle(el.firstElementChild ?? el).whiteSpace)).toBe('normal')
      expect(await label.evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThan(30)
    }
  })
}
