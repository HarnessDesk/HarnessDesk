import { expect, test, type Page } from '@playwright/test'

const dial = (page: Page, label: string) =>
  page.locator('label').filter({ hasText: new RegExp(`^${label}`) }).locator('select').first()

const setPreviewDials = async (page: Page, theme: 'light' | 'dark', look: 'desk' | 'studio') => {
  await dial(page, 'theme').selectOption(theme)
  await expect(dial(page, 'theme')).toHaveValue(theme, { timeout: 10_000 })
  await dial(page, 'interface').selectOption(look)
  await expect(dial(page, 'interface')).toHaveValue(look, { timeout: 10_000 })
  await expect.poll(() => page.evaluate(() => document.body.getAttribute('data-hd-interface') ?? 'desk'), { timeout: 10_000 }).toBe(look)
}

const gotoPreview = async (page: Page) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/preview.html?side-by-side')
  await page.waitForSelector('[class*="rowWrap_"]')
  await page.waitForSelector('[data-frame-id="side-by-side-four"] [data-slot="side-by-side-grid"]')
  await page.evaluate(async () => { await document.fonts.ready })
}

const frame = (page: Page, id: string) => page.locator(`[data-frame-id="${id}"]`)
const grid = (page: Page, id: string) => frame(page, id).locator('[data-slot="side-by-side-grid"]')

const measure = async (target: ReturnType<typeof grid>) => target.evaluate((node) => {
  const rect = (element: Element) => {
    const box = element.getBoundingClientRect()
    return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom }
  }
  const all = [...node.querySelectorAll<HTMLElement>('[data-slot="side-by-side-tile"]')]
  const shown = all.filter((tile) => !tile.hasAttribute('data-hidden'))
  const xs = [...new Set(shown.map((tile) => Math.round(tile.getBoundingClientRect().x)))]
  const ys = [...new Set(shown.map((tile) => Math.round(tile.getBoundingClientRect().y)))]
  return {
    all: all.length,
    shown: shown.length,
    columns: xs.length,
    rows: ys.length,
    widths: shown.map((tile) => tile.getBoundingClientRect().width),
    grid: rect(node),
    shownRects: shown.map(rect),
  }
})

const setWidth = async (page: Page, id: string, width: number) => {
  await frame(page, id).locator('[data-side-by-side-container]').evaluate((node, px) => {
    const element = node as HTMLElement
    const grid = element.querySelector<HTMLElement>('[data-slot="side-by-side-grid"]')
    if (!grid) throw new Error('room frame has no Side by side grid')
    const delta = px - grid.getBoundingClientRect().width
    element.style.width = `${element.getBoundingClientRect().width + delta}px`
    element.style.maxWidth = 'none'
  }, width)
  await expect.poll(async () => (await grid(page, id).boundingBox())?.width, { timeout: 10_000 }).toBe(width)
  await expectGridLayout(grid(page, id))
}

const expectedLayout = (width: number, count: number) => {
  // Keep this in step with columnsThatFit: floor((width + seam) / (tile + seam)).
  const fittingColumns = Math.max(0, Math.floor((width + 1) / (420 + 1)))
  const shown = count <= 1 || fittingColumns < 2 ? Math.min(count, 1) : count
  const columns = count <= 1 || fittingColumns < 2 ? 1 : count === 3 && fittingColumns >= 3 ? 3 : 2
  return { all: count, shown, columns, rows: Math.max(1, Math.ceil(shown / columns)) }
}

const expectGridLayout = async (target: ReturnType<typeof grid>) => {
  await expect.poll(async () => {
    const current = await measure(target)
    const expected = expectedLayout(current.grid.width, current.all)
    return current.all === expected.all && current.shown === expected.shown && current.columns === expected.columns && current.rows === expected.rows
  }, { timeout: 10_000 }).toBe(true)
}

const removeDelta = async (page: Page) => {
  await grid(page, 'side-by-side-four').locator('[data-slot="side-by-side-tile"]')
    .filter({ has: page.getByText('Delta', { exact: true }) })
    .getByRole('button', { name: 'Delta actions' }).click()
  await expect(page.getByRole('menuitem', { name: 'Take off the grid' })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('menuitem', { name: 'Take off the grid' }).click()
  await expect(grid(page, 'side-by-side-four').locator('[data-slot="side-by-side-tile"]')).toHaveCount(3, { timeout: 10_000 })
}

const expandedGeometry = (target: ReturnType<typeof grid>) => target.evaluate((node) => {
  const box = node.getBoundingClientRect()
  const tiles = [...node.querySelectorAll<HTMLElement>('[data-slot="side-by-side-tile"]')]
  const shown = tiles.filter((tile) => !tile.hasAttribute('data-hidden'))
  const hidden = tiles.filter((tile) => tile.hasAttribute('data-hidden'))
  const expanded = shown[0]?.getBoundingClientRect()
  const outside = (tile: HTMLElement) => {
    const rect = tile.getBoundingClientRect()
    return rect.right <= box.left || rect.left >= box.right || rect.bottom <= box.top || rect.top >= box.bottom
  }
  return {
    all: tiles.length,
    shown: shown.length,
    hidden: hidden.length,
    fills: Boolean(expanded && Math.abs(expanded.left - box.left) < 1 && Math.abs(expanded.top - box.top) < 1 && Math.abs(expanded.width - box.width) < 1 && Math.abs(expanded.height - box.height) < 1),
    hiddenStates: hidden.map((tile) => ({
      visibility: getComputedStyle(tile).visibility,
      transform: getComputedStyle(tile).transform,
      outside: outside(tile),
    })),
  }
})

const focusedIndex = (target: ReturnType<typeof grid>) => target.evaluate((node) => {
  const tiles = [...node.querySelectorAll<HTMLElement>('[data-slot="side-by-side-tile"]')]
  return tiles.findIndex((tile) => tile.querySelector('header[data-active]') !== null)
})

/** Keys reach a room only when focus is in it — a terminal elsewhere on the page eats them, as a terminal should. */
const focusRoom = (page: Page, id: string) =>
  page.evaluate((frameId) => {
    // A tile on the grid has no composer of its own (one composer speaks for
    // the grid), so the keys rest on the first tile itself.
    const tile = document.querySelector<HTMLElement>(`[data-frame-id="${frameId}"] [data-slot="side-by-side-tile"]`)
    if (!tile) throw new Error(`no tile in ${frameId} to focus`)
    tile.focus()
  }, id)

const returnedToGrid = (target: ReturnType<typeof grid>) => target.evaluate((node) =>
  [...node.querySelectorAll('[data-slot="side-by-side-tile"]')].every((tile) => !tile.hasAttribute('data-hidden')),
)

const expectExpansion = async (target: ReturnType<typeof grid>, shown: number) => {
  await expect.poll(async () => {
    const geometry = await expandedGeometry(target)
    return geometry.shown === shown && geometry.hidden === geometry.all - shown && (shown !== 1 || geometry.fills)
  }, { timeout: 10_000 }).toBe(true)
}

test('room tiles choose columns by count and width, keep 420px, and show the narrow strip', async ({ page }) => {
  await gotoPreview(page)
  await setPreviewDials(page, 'light', 'desk')
  await setWidth(page, 'side-by-side-two', 1200)
  const two = await measure(grid(page, 'side-by-side-two'))
  expect(two).toMatchObject(expectedLayout(two.grid.width, 2))

  // A 1-column mutation must make the same geometry contract fail.
  await page.addStyleTag({ content: '[data-frame-id="side-by-side-two"] [data-slot="side-by-side-tile"] { grid-column: 1 !important; }' })
  const mutatedTwo = await measure(grid(page, 'side-by-side-two'))
  expect(mutatedTwo).not.toMatchObject(expectedLayout(mutatedTwo.grid.width, 2))

  // Three 420px tiles and two one-pixel seams: 1262px, the narrowest that holds three.
  await setWidth(page, 'side-by-side-four', 1262)
  const fourWide = await measure(grid(page, 'side-by-side-four'))
  expect(fourWide).toMatchObject(expectedLayout(fourWide.grid.width, 4))
  expect(fourWide.widths.every((width) => width >= 420)).toBe(true)
  const fourLayoutMutation = await page.addStyleTag({ content: '[data-frame-id="side-by-side-four"] [data-slot="side-by-side-tile"] { grid-column: 1 !important; }' })
  const brokenFour = await measure(grid(page, 'side-by-side-four'))
  expect(brokenFour).not.toMatchObject(expectedLayout(brokenFour.grid.width, 4))
  await fourLayoutMutation.evaluate((style) => style.remove())
  await removeDelta(page)
  await expectGridLayout(grid(page, 'side-by-side-four'))
  const threeWide = await measure(grid(page, 'side-by-side-four'))
  expect(threeWide).toMatchObject(expectedLayout(threeWide.grid.width, 3))
  const threeWideMutation = await page.addStyleTag({ content: '[data-frame-id="side-by-side-four"] [data-slot="side-by-side-tile"] { grid-column: 1 !important; }' })
  const brokenThreeWide = await measure(grid(page, 'side-by-side-four'))
  expect(brokenThreeWide).not.toMatchObject(expectedLayout(brokenThreeWide.grid.width, 3))
  await threeWideMutation.evaluate((style) => style.remove())

  await setWidth(page, 'side-by-side-four', 1000)
  const threeNarrow = await measure(grid(page, 'side-by-side-four'))
  expect(threeNarrow).toMatchObject(expectedLayout(threeNarrow.grid.width, 3))
  const threeNarrowMutation = await page.addStyleTag({ content: '[data-frame-id="side-by-side-four"] [data-slot="side-by-side-tile"] { grid-column: 1 !important; }' })
  const brokenThreeNarrow = await measure(grid(page, 'side-by-side-four'))
  expect(brokenThreeNarrow).not.toMatchObject(expectedLayout(brokenThreeNarrow.grid.width, 3))
  await threeNarrowMutation.evaluate((style) => style.remove())

  // At 1262px the two one-pixel seams leave three tracks of at least 420px.
  await setWidth(page, 'side-by-side-four', 1262)
  const widths = await measure(grid(page, 'side-by-side-four'))
  expect(widths.widths.length).toBeGreaterThan(0)
  expect(widths.widths.every((width) => width >= 420)).toBe(true)

  await setWidth(page, 'side-by-side-four', 1261)
  await expectGridLayout(grid(page, 'side-by-side-four'))
  // Two tiles and a seam: 841px holds two, 840px holds one.
  await setWidth(page, 'side-by-side-four', 841)
  const fourGrid = await measure(grid(page, 'side-by-side-four'))
  expect(fourGrid).toMatchObject(expectedLayout(fourGrid.grid.width, 3))
  expect(fourGrid.widths.every((width) => width >= 420)).toBe(true)
  await setWidth(page, 'side-by-side-four', 840)
  const oneWide = await measure(grid(page, 'side-by-side-four'))
  expect(oneWide).toMatchObject(expectedLayout(oneWide.grid.width, 3))
  await setWidth(page, 'side-by-side-four', 800)
  const narrow = await measure(grid(page, 'side-by-side-four'))
  const strip = frame(page, 'side-by-side-four').getByRole('tablist', { name: 'Side by side tiles' })
  expect(narrow).toMatchObject(expectedLayout(narrow.grid.width, 3))
  await expect(strip).toBeVisible()
  await expect(strip.getByRole('tab')).toHaveCount(3)

  await page.addStyleTag({ content: '[data-frame-id="side-by-side-four"] [role="tablist"] { display: none !important; }' })
  // By CSS, not by role: a role lookup cannot see an element under display: none.
  const stripVisible = await frame(page, 'side-by-side-four').locator('[role="tablist"]').evaluate((node) => getComputedStyle(node).display !== 'none')
  expect(stripVisible).toBe(false)

  // Force four equal tracks: the shown tile widths must fall below the floor.
  await setWidth(page, 'side-by-side-four', 1262)
  await page.addStyleTag({ content: '[data-frame-id="side-by-side-four"] [data-slot="side-by-side-tile"]:not([data-hidden]) { width: 300px !important; }' })
  const thin = await measure(grid(page, 'side-by-side-four'))
  expect(thin.widths.every((width) => width >= 420)).toBe(false)
})

test('expansion fills the grid, keeps hidden tiles mounted and offscreen, and Escape returns', async ({ page }) => {
  await gotoPreview(page)
  await setPreviewDials(page, 'dark', 'desk')
  const target = grid(page, 'side-by-side-four')
  const alpha = frame(page, 'side-by-side-four').getByRole('button', { name: 'Expand Alpha' })
  await alpha.click()
  await expectExpansion(target, 1)
  const expanded = await expandedGeometry(target)
  expect(expanded).toMatchObject({ all: 4, shown: 1, hidden: 3, fills: true })
  expect(expanded.hiddenStates.every((tile) => tile.visibility === 'hidden' && tile.transform !== 'none' && tile.outside)).toBe(true)

  await page.addStyleTag({ content: '[data-frame-id="side-by-side-four"] [data-slot="side-by-side-tile"][data-hidden] { transform: none !important; }' })
  const moved = await expandedGeometry(target)
  expect(moved.hiddenStates.every((tile) => tile.outside)).toBe(false)
  await page.addStyleTag({ content: '[data-frame-id="side-by-side-four"] [data-slot="side-by-side-tile"][data-hidden] { transform: translateX(-101%) !important; }' })

  await page.addStyleTag({ content: '[data-frame-id="side-by-side-four"] [data-slot="side-by-side-tile"][data-hidden] { visibility: visible !important; }' })
  const visibleHidden = await expandedGeometry(target)
  expect(visibleHidden.hiddenStates.every((tile) => tile.visibility === 'hidden')).toBe(false)
  await page.addStyleTag({ content: '[data-frame-id="side-by-side-four"] [data-slot="side-by-side-tile"][data-hidden] { visibility: hidden !important; }' })

  const narrowed = await page.addStyleTag({ content: '[data-frame-id="side-by-side-four"] [data-slot="side-by-side-tile"]:not([data-hidden]) { width: 120px !important; }' })
  const notFilling = await expandedGeometry(target)
  expect(notFilling.fills).toBe(false)
  // Spent: the expansions below must fill again.
  await narrowed.evaluate((style) => style.remove())

  await page.keyboard.press('Escape')
  await expect.poll(() => returnedToGrid(target), { timeout: 10_000 }).toBe(true)
  await alpha.click()
  await expectExpansion(target, 1)
  await page.evaluate(() => {
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') event.preventDefault()
    }, { capture: true, once: true })
  })
  await page.keyboard.press('Escape')
  await expect.poll(() => returnedToGrid(target), { timeout: 10_000 }).toBe(false)

  // Still expanded (the Escape above was taken first): take a hidden tile away.
  await target.locator('[data-slot="side-by-side-tile"][data-hidden]').first().evaluate((tile) => tile.remove())
  const missingTile = await expandedGeometry(target)
  expect(missingTile.all === 4 && missingTile.hidden === 3).toBe(false)
})

test('⌥⌘1–⌥⌘4 focus each tile by header; ⌥⌘↵ expands and returns', async ({ page }) => {
  await gotoPreview(page)
  await setPreviewDials(page, 'light', 'studio')
  const target = grid(page, 'side-by-side-four')
  await focusRoom(page, 'side-by-side-four')
  for (let index = 0; index < 4; index++) {
    await page.keyboard.press(`Alt+Meta+Digit${index + 1}`)
    await expect.poll(() => focusedIndex(target), { timeout: 10_000 }).toBe(index)
  }

  await page.evaluate(() => document.querySelector('[data-frame-id="side-by-side-four"] header[data-active]')?.removeAttribute('data-active'))
  await expect.poll(() => focusedIndex(target), { timeout: 10_000 }).toBe(-1)

  await page.keyboard.press('Alt+Meta+Digit2')
  await expect.poll(() => focusedIndex(target), { timeout: 10_000 }).toBe(1)
  await page.keyboard.press('Alt+Meta+Enter')
  await expectExpansion(target, 1)
  const expanded = await expandedGeometry(target)
  expect(expanded).toMatchObject({ shown: 1, hidden: 3, fills: true })
  await page.keyboard.press('Alt+Meta+Enter')
  await expect.poll(() => returnedToGrid(target), { timeout: 10_000 }).toBe(true)

  await page.evaluate(() => {
    // Not `once`: the chord's own modifier keydowns arrive first and would spend it.
    const block = (event: KeyboardEvent) => {
      if (!(event.altKey && event.metaKey && event.code === 'Enter')) return
      event.preventDefault()
      document.removeEventListener('keydown', block, true)
    }
    document.addEventListener('keydown', block, true)
  })
  await page.keyboard.press('Alt+Meta+Enter')
  await expectExpansion(target, 4)
})

test('a tile chord immediately after focus survives CPU throttling', async ({ page }) => {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 })
  try {
    await gotoPreview(page)
    await setPreviewDials(page, 'light', 'studio')
    const target = grid(page, 'side-by-side-four')
    await focusRoom(page, 'side-by-side-four')
    // Deliberately send the chord without waiting for the frame's focus
    // context to render. SideBySide must consult live DOM focus at receipt.
    await page.keyboard.press('Alt+Meta+Enter')
    await expectExpansion(target, 1)
  } finally {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
    await cdp.detach()
  }
})

test('a narrow tile keeps the full nickname, and bare ⌘1 is not a grid chord', async ({ page }) => {
  await gotoPreview(page)
  await setPreviewDials(page, 'dark', 'studio')
  await setWidth(page, 'side-by-side-two', 420)
  const target = grid(page, 'side-by-side-two')
  const alphaName = frame(page, 'side-by-side-two').locator('[data-slot="side-by-side-tile"] [data-role="row"]').first()
  const nameFits = () => alphaName.evaluate((node) => node.scrollWidth === node.clientWidth)
  expect(await nameFits()).toBe(true)
  await page.addStyleTag({ content: '[data-frame-id="side-by-side-two"] [data-slot="side-by-side-tile"] [data-role="row"] { width: 2px !important; max-width: 2px !important; overflow: hidden !important; white-space: nowrap !important; }' })
  expect(await nameFits()).toBe(false)

  await setWidth(page, 'side-by-side-two', 1200)
  await focusRoom(page, 'side-by-side-two')
  await page.keyboard.press('Alt+Meta+Digit2')
  await expect.poll(() => focusedIndex(target), { timeout: 10_000 }).toBe(1)
  const before = await focusedIndex(target)
  await frame(page, 'tools-browser').getByRole('textbox').first().focus()
  await page.keyboard.press('Meta+Digit1')
  await expect.poll(() => focusedIndex(target), { timeout: 10_000 }).toBe(before)
  // And with the room focused: bare ⌘1 is the browser's tab key, never a tile key.
  // Entering a tile's composer gives that tile the keys, so the baseline is read after.
  await focusRoom(page, 'side-by-side-two')
  const entered = await focusedIndex(target)
  await page.keyboard.press('Meta+Digit1')
  await expect.poll(() => focusedIndex(target), { timeout: 10_000 }).toBe(entered)
  await page.keyboard.press('Alt+Meta+Digit2')
  await expect.poll(() => focusedIndex(target), { timeout: 10_000 }).toBe(1)
  // The chord moved the keys, not only the highlight: typing goes to tile 2.
  expect(await target.evaluate((node) => {
    const tiles = [...node.querySelectorAll('[data-slot="side-by-side-tile"]')]
    return tiles.findIndex((tile) => tile.contains(document.activeElement))
  })).toBe(1)
  // The mutation routes bare ⌘1 to the grid while the room is focused, and the check bites.
  await page.evaluate(() => {
    // On window's capture phase: the browser pane takes bare ⌘1 on document's.
    const route = (event: KeyboardEvent) => {
      if (!(event.metaKey && !event.altKey && event.code === 'Digit1')) return
      window.removeEventListener('keydown', route, true)
      window.dispatchEvent(new CustomEvent('hd-side-by-side', { detail: 'tile-1' }))
    }
    window.addEventListener('keydown', route, true)
  })
  await page.keyboard.press('Meta+Digit1')
  await expect.poll(() => focusedIndex(target), { timeout: 10_000 }).toBe(0)
})

test('a name longer than the bar wraps whole, clear of the state chip and the actions', async ({ page }) => {
  await gotoPreview(page)
  await setWidth(page, 'side-by-side-two', 420)
  const header = frame(page, 'side-by-side-two').locator('[data-slot="side-by-side-tile"] header').first()
  const long = 'Alpha the long-running reviewer of everything in the checkout'
  await header.locator('[data-role="row"]').evaluate((node, text) => { node.textContent = text }, long)
  const measured = await header.evaluate((bar) => {
    const name = bar.querySelector<HTMLElement>('[data-role="row"]')!
    const box = (node: Element) => node.getBoundingClientRect()
    const others = [...bar.querySelectorAll('[data-slot="chip"], button')].map(box)
    const named = box(name)
    return {
      whole: name.scrollWidth <= name.clientWidth,
      overlaps: others.filter((other) => named.right > other.left + 0.5 && named.left < other.right - 0.5 && named.bottom > other.top && named.top < other.bottom).length,
      inside: named.right <= box(bar).right + 0.5 && named.bottom <= box(bar).bottom + 0.5 && named.top >= box(bar).top - 0.5,
    }
  })
  expect(measured).toEqual({ whole: true, overlaps: 0, inside: true })
  // A name three times as long still sits inside the bar, which grows for it.
  await header.locator('[data-role="row"]').evaluate((node, text) => { node.textContent = text }, `${long} ${long} ${long}`)
  expect(await header.evaluate((bar) => {
    const name = bar.querySelector<HTMLElement>('[data-role="row"]')!.getBoundingClientRect()
    const own = bar.getBoundingClientRect()
    return name.bottom <= own.bottom + 0.5 && name.top >= own.top - 0.5
  })).toBe(true)
})

test('a grid of tiles draws no composer in any tile, and an expanded tile draws its own', async ({ page }) => {
  await gotoPreview(page)
  await setWidth(page, 'side-by-side-two', 1200)
  const target = grid(page, 'side-by-side-two')
  await expect(target.locator('[data-slot="side-by-side-tile"] textarea')).toHaveCount(0, { timeout: 10_000 })
  await target.locator('button[aria-label^="Expand "]').first().click()
  await expectExpansion(target, 1)
  await expect(target.locator('[data-slot="side-by-side-tile"]:not([data-hidden]) textarea')).toHaveCount(1, { timeout: 10_000 })
})

test('a draft typed in an expanded tile is waiting when the tile is expanded again', async ({ page }) => {
  await gotoPreview(page)
  await setWidth(page, 'side-by-side-two', 1200)
  const target = grid(page, 'side-by-side-two')
  const expand = target.locator('button[aria-label="Expand Alpha"]')
  await expand.click()
  await expectExpansion(target, 1)
  const box = target.locator('[data-slot="side-by-side-tile"]:not([data-hidden]) textarea')
  await box.fill('half a thought, kept')
  await expect(box).toHaveValue('half a thought, kept', { timeout: 10_000 })
  await target.locator('button[aria-label="Collapse Alpha"]').click()
  await expect.poll(() => returnedToGrid(target), { timeout: 10_000 }).toBe(true)
  await expect(target.locator('[data-slot="side-by-side-tile"] textarea')).toHaveCount(0, { timeout: 10_000 })
  await expand.click()
  await expectExpansion(target, 1)
  await expect(box).toHaveValue('half a thought, kept')
})
