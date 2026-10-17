import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) {
  test(`Library state details stay on runtime marks and findings stay within cards in ${theme}`, async ({ page }) => {
    await page.goto('/preview.html')
    await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
    await page.getByRole('combobox', { name: 'settings page', exact: true }).selectOption('library')
    const sheet = page.locator('[data-frame-id="settings-sheet"] [data-page-destination]:visible')
    await expect(sheet.locator('[data-runtime-state="stale"][title="Gamma: Not loaded yet"]')).toBeVisible()
    await expect(sheet.locator('[data-runtime-state="off"][title="Alpha: Switched off"]')).toBeVisible()
    await expect(sheet.getByText('Not read yet by Gamma', { exact: true })).toHaveCount(0)
    await expect(sheet.getByText('Off in Alpha', { exact: true })).toHaveCount(0)
    for (const width of [1440, 1024]) {
      await page.setViewportSize({ width, height: 900 })
      const readings = await sheet.locator('[data-card-finding]').evaluateAll(nodes => nodes.map(node => {
        const card = node.closest('[data-slot="skill-card"]')!, rect = card.getBoundingClientRect(), style = getComputedStyle(card)
        const range = document.createRange(); range.selectNodeContents(node)
        return {left:rect.left+parseFloat(style.paddingLeft),right:rect.right-parseFloat(style.paddingRight),
          lines:[...range.getClientRects()].map(line=>({left:line.left,right:line.right}))}
      }))
      expect(readings.length).toBeGreaterThan(0)
      for (const reading of readings) for (const line of reading.lines) {
        expect(line.left).toBeGreaterThanOrEqual(reading.left - 1)
        expect(line.right).toBeLessThanOrEqual(reading.right + 1)
      }
    }
  })

  test(`capability lists keep the table anatomy in ${theme}`, async ({ page }) => {
    await page.goto('/preview.html')
    await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
    const library = page.locator('[data-frame-id="settings-library"]')
    const cards = library.locator('[data-slot="skill-card"]')
    await expect(cards).toHaveCount(6)
    const first = cards.first()
    await expect(first.locator('[data-runtime-state]')).toHaveCount(3)
    const copy = await first.evaluate(card => {
      const name = card.querySelector('[data-role="member"]')!, description = card.querySelector('[data-skill-description]')!
      const mark = card.querySelector('[data-runtime-state]')!
      return { mark: mark.getBoundingClientRect().width, separateLines: description.getBoundingClientRect().top >= name.getBoundingClientRect().bottom }
    })
    expect(copy.mark).toBe(20)
    expect(copy.separateLines).toBe(true)
    await expect(library.locator('[data-slot="row-mark"]')).toHaveCount(0)

    const sheet = page.locator('[data-frame-id="settings-sheet"] [data-page-destination]:visible')
    const dial = page.getByRole('combobox', { name: 'settings page', exact: true })
    await dial.selectOption('plugins')
    const pluginGeometry = await sheet.locator('[data-slot="row-title"]').evaluateAll(titles => titles.map(title => {
      const row = title.closest('button')!
      return { title: title.textContent, height: row.getBoundingClientRect().height, face: Boolean(row.querySelector('[data-slot="row-mark"]')) }
    }))
    // 12px above and below a 23px control line, once past the 44px floor.
    expect(pluginGeometry.map(row => row.height)).toEqual(Array(12).fill(47))
    expect(pluginGeometry.every(row => !row.face)).toBe(true)
    expect(pluginGeometry[2]?.title).toBe('Plugin 2')
    expect(pluginGeometry[10]?.title).toBe('Plugin 10')

    await dial.selectOption('skills')
    await expect(sheet.locator('[data-slot="row-mark"]')).toHaveCount(2) // hooks, no repeated skill faces
    const description = sheet.locator('[data-slot="row-desc"]').nth(1)
    expect(await description.locator('span').evaluate(node => getComputedStyle(node).webkitLineClamp)).toBe('2')
    await expect(sheet.getByText('Hooks · 2', { exact: true })).toBeVisible()
    await expect(sheet.getByText('Trusted', { exact: true })).toBeVisible()
    await sheet.getByRole('button', { name: /Playwright/ }).click()
    await expect(sheet.getByText('Always on', { exact: true })).toBeVisible()

    await dial.selectOption('models')
    await expect(sheet.getByText('Always thinks', { exact: true })).toBeVisible()
    const titleSizes = await sheet.locator('[data-slot="row-title"]').evaluateAll(titles => titles.map(title => getComputedStyle(title).fontSize))
    expect(new Set(titleSizes).size).toBe(1)
    const titleChildren = await sheet.locator('[data-slot="row-title"] [data-slot="text"]').count()
    expect(titleChildren).toBe(0)
    await expect(sheet.locator('[data-slot="row-desc"]').first()).toContainText('Low, Medium, High, Extra high')
    await expect(sheet.getByText('Not available', { exact: true })).toBeVisible()
    const unavailable = sheet.locator('[data-slot="row"]').filter({ hasText: 'Not available with' })
    const opacity = await unavailable.evaluate(row => {
      const read = (selector: string) => getComputedStyle(row.querySelector(selector)!).opacity
      return {
        row: getComputedStyle(row).opacity,
        mark: read('[data-slot="row-mark"]'),
        title: read('[data-slot="row-title-name"]'),
        chip: read('[data-slot="chip"]'),
        description: read('[data-slot="row-desc"]'),
        reason: read('[data-slot="row-desc"] [data-slot="text"]'),
      }
    })
    expect(opacity).toEqual({ row: '1', mark: '0.55', title: '0.55', chip: '1', description: '1', reason: '1' })
    await expect(sheet.getByRole('button', { name: 'Remove…', exact: true })).toHaveCount(0)
    await sheet.locator('button[aria-label="Team proxy actions"]').click()
    const removeEndpoint = page.getByRole('menuitem', { name: 'Remove…', exact: true })
    await expect(removeEndpoint).toHaveAttribute('data-variant', 'destructive')
    const removeIcon = removeEndpoint.locator('svg')
    await expect(removeIcon).toHaveCount(0)
    await expect(removeEndpoint.locator('xpath=ancestor::*[@role="menu"]')).toHaveAttribute('data-menu-icons', 'none')
    await expect(removeEndpoint.locator('xpath=ancestor::*[@role="menu"]').locator('svg')).toHaveCount(0)
    await removeEndpoint.click()
    await expect(page.getByRole('alertdialog', { name: 'Remove Team proxy?', exact: true }).getByRole('heading', { name: 'Remove Team proxy?', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')

    await dial.selectOption('extensions')
    await expect(sheet.getByText('Reference', { exact: true })).toBeVisible()
    await expect(sheet.getByText('Turned off by an administrator', { exact: true })).toBeVisible()
    await sheet.getByRole('tab', { name: 'MCP servers', exact: true }).click()
    await expect(sheet.getByText('2 tools · 3 resources', { exact: true })).toBeVisible()
    await expect(sheet.getByText('1 tool · 0 resources', { exact: true })).toBeVisible()
    await expect(sheet.getByText('1 tool · 1 resource', { exact: true })).toBeVisible()
    await expect(sheet.getByText('Authorised', { exact: true })).toBeVisible()
    await expect(sheet.getByText('Signed in', { exact: true })).toBeVisible()

    await dial.selectOption('shortcuts')
    const tiles = sheet.locator('[data-slot="row"]').filter({ hasText: 'Focus tile' })
    await expect(tiles).toHaveCount(1)
    await expect(tiles.locator('kbd')).toHaveText(['⌥', '⌘', '1 – 4'])
  })
}


for (const theme of ['light', 'dark'] as const) {
  test(`Library cards keep descriptions and every runtime mark within narrow panes in ${theme}`, async ({ page }) => {
    await page.goto(`/preview.html?capability-lists=stress&theme=${theme}`)
    await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
    await page.getByRole('combobox', { name: 'settings page', exact: true }).selectOption('library')
    const sheet = page.locator('[data-frame-id="settings-sheet"] [data-page-destination]:visible')
    for (const width of [1024, 900, 720, 560]) {
      await page.setViewportSize({ width, height: 900 })
      const grid = sheet.locator('[data-slot="skill-cards"]')
      const cards = grid.locator('[data-slot="skill-card"]')
      await expect(cards).toHaveCount(9)
      const loaded = cards.filter({ hasText: 'Shared review' })
      await expect(loaded).toHaveAccessibleName('Shared review')
      await expect(loaded.locator('[aria-label="Loaded by 4 of 4 runtimes"]')).toBeVisible()
      await expect(loaded.locator('[data-runtime-state]')).toHaveCount(4)
      const readings = await cards.evaluateAll(nodes => nodes.map(node => {
        const box = node.getBoundingClientRect()
        const name = node.querySelector('[data-role="member"]')!
        const description = node.querySelector('[data-detail-lines]')!
        const css = getComputedStyle(description), rect = description.getBoundingClientRect()
        const text = document.createTreeWalker(name, NodeFilter.SHOW_TEXT).nextNode()!
        const prefix = document.createRange(); prefix.setStart(text, 0); prefix.setEnd(text, Math.min(8, text.textContent!.length))
        const font = getComputedStyle(name), canvas = document.createElement('canvas').getContext('2d')!
        canvas.font = `${font.fontWeight} ${font.fontSize} ${font.fontFamily}`
        const ellipsis = name.scrollWidth > name.clientWidth ? canvas.measureText('…').width : 0
        return { name: name.getBoundingClientRect().width, prefix: prefix.getBoundingClientRect().right, nameRight: name.getBoundingClientRect().right - ellipsis, height: rect.height, line: parseFloat(css.lineHeight), clamp: css.webkitLineClamp,
          marks: [...node.querySelectorAll('[data-runtime-state]')].map(mark => ({ left: mark.getBoundingClientRect().left, right: mark.getBoundingClientRect().right })), left: box.left, right: box.right }
      }))
      for (const reading of readings) {
        expect(reading.name).toBeGreaterThan(40)
        expect(reading.prefix).toBeLessThanOrEqual(reading.nameRight)
        expect(reading.clamp).toBe('2')
        expect(reading.height).toBeLessThanOrEqual(reading.line * 2 + 1)
        for (const mark of reading.marks) { expect(mark.left).toBeGreaterThanOrEqual(reading.left); expect(mark.right).toBeLessThanOrEqual(reading.right) }
      }
      expect(await grid.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
      await loaded.hover()
      expect(await loaded.evaluate(node => getComputedStyle(node).textDecorationLine)).toBe('none')
      await sheet.getByRole('button', { name: 'brainstorming', exact: true }).click()
      const detail = page.getByRole('dialog').getByText('Use before any creative work — creating features, building components, adding functionality. Explores intent and requirements before implementation.', { exact: true })
      await expect(detail).toBeVisible()
      expect(await detail.evaluate(node => getComputedStyle(node).webkitLineClamp)).toBe('none')
      await page.keyboard.press('Escape')
    }
  })

  test(`mixed skills keep fallback marks small and long descriptions bounded in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 720, height: 900 })
    await page.goto(`/preview.html?capability-lists=stress&theme=${theme}`)
    await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
    await page.getByRole('combobox', { name: 'settings page', exact: true }).selectOption('skills')
    const sheet = page.locator('[data-frame-id="settings-sheet"] [data-page-destination]:visible')
    await expect(sheet.locator('[data-slot="row-mark"]')).toHaveCount(6) // four skills, two hooks
    for (const name of ['Brainstorming', 'Deploy Notes']) {
      const row = sheet.getByRole('button', { name: new RegExp(name) })
      expect(await row.locator('[data-slot="row-mark"] svg').evaluate(node => node.getBoundingClientRect().width)).toBe(15)
    }
    const row = sheet.getByRole('button', { name: /Brainstorming/ })
    const paragraph = row.locator('[data-slot="row-desc"] span')
    expect(await paragraph.evaluate(node => node.getBoundingClientRect().height)).toBeLessThanOrEqual(60)
    await row.click()
    const full = sheet.getByText('Explore requirements, constraints and the design before implementation. '.repeat(12).trim(), { exact: true })
    await expect(full).toBeVisible()
    expect(await full.evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThan(60)
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`built-in plugin marks and disabled extension reasons read clearly in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 900 })
    await page.goto(`/preview.html?capability-lists=stress&theme=${theme}`)
    await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
    const sheet = page.locator('[data-frame-id="settings-sheet"] [data-page-destination]:visible')
    const dial = page.getByRole('combobox', { name: 'settings page', exact: true })

    await dial.selectOption('plugins')
    const builtin = sheet.getByRole('button', { name: /Version control/ })
    await expect(builtin.locator('[data-slot="row-mark"] svg')).toHaveCount(1)
    await expect(sheet.locator('[data-slot="row-mark"]')).toHaveCount(12)

    await dial.selectOption('extensions')
    await expect(sheet.getByText('Turned off by an administrator', { exact: true })).toBeVisible()
  })
}


for (const theme of ['light', 'dark'] as const) {
  test(`Library keeps Add skill in its page head and attention under Needs you at 720px and 560px in ${theme}`, async ({ page }) => {
    await page.goto(`/preview.html?capability-lists=stress&theme=${theme}`)
    await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
    await page.getByRole('combobox', { name: 'settings page', exact: true }).selectOption('library')
    const sheet = page.locator('[data-frame-id="settings-sheet"]')
    for (const width of [720, 560]) {
      await page.setViewportSize({ width, height: 1100 })
      const head = sheet.locator('[data-slot="top-bar"]:visible')
      const pageBody = sheet.locator('[data-page-destination="library"]:visible')
      const actions = head.getByRole('button')
      const bounds = (await head.locator('..').boundingBox())!
      const body = (await sheet.locator('[data-page-destination="library"]:visible [data-slot="page"]').boundingBox())!
      await expect(pageBody.locator('p[data-role="prose"]')).toHaveCount(0)
      const add = (await pageBody.getByRole('button', { name: 'Add skill', exact: true }).boundingBox())!
      expect(add.x).toBeGreaterThanOrEqual(body.x)
      expect(add.x + add.width).toBeLessThanOrEqual(body.x + body.width)
      expect(bounds.height).toBe(40)
      expect(await actions.count()).toBeGreaterThan(0)
      for (const action of await actions.all()) {
        const box = (await action.boundingBox())!
        expect(box.x).toBeGreaterThanOrEqual(bounds.x - 1)
        expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1)
      }
      expect(await head.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
      await pageBody.getByRole('radio', { name: 'All', exact: true }).click()
      await expect(sheet.locator('[data-slot="library-attention"]')).toHaveCount(0)
      await pageBody.getByRole('radio', { name: 'Needs you', exact: true }).click()
      await expect(sheet.locator('[data-slot="library-attention"] [data-part="banner-icon"]').first()).toBeVisible()
    }
  })
}
