import { expect, test } from '@playwright/test'

test('real sidebar footer fills its column and its menu is painted and clickable', async ({ page }) => {
  await page.goto('/preview.html')
  const trigger = page.locator('button[class*="accountRow"]')
  await trigger.scrollIntoViewIfNeeded()
  // Exercise a wide sidebar as well as its usual width: a shrink-to-label
  // wrapper can look almost right at the minimum width and fail on resize.
  for (const width of [260, 480]) {
    await trigger.evaluate((node, width) => {
      const sidebar = node.closest('[class*="sidebar_"]')
      if (!sidebar?.parentElement) throw new Error('sidebar frame missing')
      sidebar.parentElement.style.width = `${width}px`
    }, width)
    const gap = await trigger.evaluate(node => {
      const footer = node.parentElement!.parentElement!
      // The row is the seat and the inbox bell beside it: the seat opens the
      // row, the bell closes it, and together they fill the column.
      const end = footer.lastElementChild!.getBoundingClientRect()
      const box = footer.getBoundingClientRect(), seat = node.getBoundingClientRect()
      const row = { left: seat.left, right: end.right }
      // The column states one inset for every row it holds; the footer row is
      // one of them, so read the number rather than repeating it here — a
      // literal would have to be edited every time the column is re-spaced,
      // and the claim is "level with its neighbours", not "four pixels".
      const rail = parseFloat(getComputedStyle(node.closest('[class*="sidebar_"]')!).getPropertyValue('--rail'))
      return { left: row.left - box.left, right: box.right - row.right, rail }
    })
    expect(gap.right).toBeCloseTo(gap.left, 0)
    expect(gap.right).toBeCloseTo(gap.rail, 0)
  }
  await trigger.click()
  const popup = page.locator('[data-slot="popover-popup"]')
  const settings = popup.getByRole('menuitem', { name: /^Settings/ })
  await expect(settings).toBeVisible()
  const bounds = await settings.evaluate(node => {
    const rect = node.getBoundingClientRect()
    const box = node.closest('[data-slot="popover-popup"]')!.getBoundingClientRect()
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2
    return { contained: y >= box.top && y <= box.bottom, hit: node.contains(document.elementFromPoint(x, y)) }
  })
  expect(bounds).toEqual({ contained: true, hit: true })
  // Real pointer dispatch, not element.click(): clipped menus must not pass.
  await settings.click()
  await expect(popup).toHaveCount(0)
  await trigger.click()
  await page.keyboard.press('ArrowDown')
  await expect(popup.getByRole('menuitem').first()).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(popup).toHaveCount(0)
  await expect(trigger).toBeFocused()
})

for (const height of [900, 520]) {
  test(`open sidebar menu repositions after theme changes and account expansion at ${height}px`, async ({ page }, testInfo) => {
    // Add synthetic accounts at the fixture boundary. The real Sidebar,
    // disclosure, scrolling menu and canonical Popover remain unchanged.
    // Enough of them that the one-line account rows still outgrow a 900px
    // window: sixteen fit once each row stopped carrying its address.
    await page.route('**/src/preview/sidebar-fixture.ts*', async route => {
      const response = await route.fetch()
      await route.fulfill({
        response,
        body: `${await response.text()}\n{
          const status = previewAccounts[Object.keys(previewAccounts)[1]];
          status.accounts.push(...Array.from({ length: 32 }, (_, index) => ({
            kind: 'oauth', label: 'Account ' + (index + 1), email: 'account' + (index + 1) + '@example.com'
          })));
        }`,
      })
    })
    await page.setViewportSize({ width: 1440, height })
    await page.goto('/preview.html')
    const trigger = page.locator('button[class*="accountRow"]')
    await expect(trigger).toBeAttached()
    // Put this existing preview frame at the viewport's bottom edge, just
    // like the production sidebar; do not alter the menu or its positioning.
    await trigger.evaluate(node => {
      const frame = node.closest('[class*="sidebar_"]')?.parentElement
      if (!frame) throw new Error('sidebar frame missing')
      Object.assign(frame.style, { position: 'fixed', top: '8px', left: '8px', width: '240px', height: 'calc(100vh - 8px)' })
    })
    const theme = page.getByRole('combobox', { name: 'theme', exact: true })
    await theme.selectOption('light')
    await trigger.click()
    const popup = page.locator('[data-slot="popover-popup"]')
    await expect(popup).toBeVisible()
    const compact = await popup.boundingBox()
    expect(compact).not.toBeNull()
    await theme.selectOption('dark')
    await expect(popup).toBeVisible()
    await theme.selectOption('light')
    await popup.locator('[role="menuitem"][data-current][aria-expanded="false"]').click()
    await expect(popup.locator('[role="menuitem"][data-current]')).toHaveAttribute('aria-expanded', 'true')
    await expect.poll(async () => popup.evaluate(node => {
      const box = node.getBoundingClientRect()
      return box.top >= 0 && box.bottom <= window.innerHeight
    })).toBe(true)
    const expanded = await popup.evaluate(node => {
      const box = node.getBoundingClientRect()
      return { top: box.top, bottom: box.bottom, height: box.height, clientHeight: node.clientHeight, scrollHeight: node.scrollHeight }
    })
    await testInfo.attach('dynamic-menu-layout', { body: JSON.stringify({ compact, expanded }, null, 2), contentType: 'application/json' })
    expect(expanded.height).toBeGreaterThan(compact!.height + 100)
    expect(expanded.top).toBeLessThan(compact!.y)
    expect(expanded.scrollHeight).toBeGreaterThan(expanded.clientHeight)
    const settings = popup.getByRole('menuitem', { name: /^Settings/ })
    await settings.scrollIntoViewIfNeeded()
    expect(await settings.evaluate(node => {
      const box = node.getBoundingClientRect()
      return node.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2))
    })).toBe(true)
    await settings.click()
    await expect(popup).toHaveCount(0)
  })
}

test('settings rows contain their labels, descriptions and marks', async ({ page }) => {
  await page.goto('/design.html?view=row')
  const row = page.getByRole('button', { name: 'Worktrees Two checkouts on this machine' })
  await expect(row).toBeVisible()
  const bounds = await row.evaluate(node => {
    const box = node.getBoundingClientRect()
    return [...node.querySelectorAll('span, svg')].filter(child => child.textContent?.trim() || child.tagName === 'svg')
      .map(child => { const rect = child.getBoundingClientRect(); return { top: rect.top - box.top, bottom: box.bottom - rect.bottom } })
  })
  for (const bound of bounds) {
    expect(bound.top).toBeGreaterThanOrEqual(0)
    expect(bound.bottom).toBeGreaterThanOrEqual(0)
  }
})

test('a long tinted identity keeps its icon, edge and ellipsis inside the chip', async ({ page }) => {
  await page.goto('/design.html?view=state')
  const chip = page.locator('[data-tint="blue"][title="feat/promo-stacking-for-the-seasonal-storefront"]')
  await expect(chip).toBeVisible()
  const box = await chip.evaluate(node => {
    const chipBox = node.getBoundingClientRect()
    const iconBox = node.querySelector('svg')!.getBoundingClientRect()
    const label = node.querySelector<HTMLElement>('[data-slot="chip-words"] > span')!
    const labelBox = label.getBoundingClientRect()
    return {
      width: chipBox.width,
      iconGap: labelBox.left - iconBox.right,
      labelRight: labelBox.right,
      chipRight: chipBox.right,
      truncated: label.scrollWidth > label.clientWidth,
      edge: getComputedStyle(node).boxShadow,
    }
  })
  expect(box.width).toBeLessThanOrEqual(190)
  expect(box.iconGap).toBeGreaterThanOrEqual(4)
  expect(box.labelRight).toBeLessThan(box.chipRight)
  expect(box.truncated).toBe(true)
  expect(box.edge).not.toBe('none')
})

/**
 * Selection is a fill, never weight (U014), for every role that can be chosen.
 *
 * Each chosen instance is compared with a resting instance of its own role,
 * because a sidebar destination and a branch row start from different grounds
 * and comparing across them proves nothing. A choice is chosen three ways —
 * `data-selected`, `data-on`, or a radio's `aria-checked` — and each must fill.
 * Pointing at an option must not look like choosing it: hover takes the plain
 * hover fill, and a chosen option keeps its own fill under the pointer.
 */
test('every chosen row, destination and option is filled, and none changes weight', async ({ page }) => {
  await page.goto('/design.html?view=propagation')
  const section = page.getByTestId('selection-contracts')
  await expect(section).toBeVisible()
  const look = (name: string, role: 'button' | 'radio' = 'button') => section.getByRole(role, { name, exact: true })
    .evaluate(node => { const style = getComputedStyle(node); return { fill: style.backgroundColor, weight: style.fontWeight } })
  await page.mouse.move(0, 0)
  type Role = 'button' | 'radio'
  const pairs: [string, Role, string, Role][] = [
    ['Resting page', 'button', 'Chosen page', 'button'],
    ['Resting branch', 'button', 'Checked-out branch', 'button'],
    ['Resting option', 'button', 'Option turned on', 'button'],
    ['Resting option', 'button', 'Option checked', 'radio'],
    // The settings list of answers, as RowChoice draws it.
    ['Resting answer', 'radio', 'Chosen answer', 'radio'],
  ]
  for (const [resting, restingRole, chosen, chosenRole] of pairs) {
    const [rest, pick] = [await look(resting, restingRole), await look(chosen, chosenRole)]
    expect.soft(pick.fill, `${chosen} is filled`).not.toBe(rest.fill)
    expect.soft(pick.weight, `${chosen} keeps the weight of ${resting}`).toBe(rest.weight)
  }
  const chosen = await look('Option turned on')
  await section.getByRole('button', { name: 'Resting option', exact: true }).hover()
  await expect.poll(() => look('Resting option').then(style => style.fill)).not.toBe(chosen.fill)
  await section.getByRole('button', { name: 'Option turned on', exact: true }).hover()
  await expect.poll(() => look('Option turned on').then(style => style.fill)).toBe(chosen.fill)
  const answer = await look('Chosen answer', 'radio')
  await section.getByRole('radio', { name: 'Chosen answer', exact: true }).hover()
  await expect.poll(() => look('Chosen answer', 'radio').then(style => style.fill)).toBe(answer.fill)
})

test('canonical controls retain selected, drop, icon and deferred-send states', async ({ page }) => {
  await page.goto('/design.html?view=propagation')
  const states = page.getByTestId('state-contracts')
  await expect(states).toBeVisible()
  await expect.soft(states.getByRole('button', { name: 'Drop target' })).not.toHaveCSS('box-shadow', 'none')
  expect.soft(await states.getByRole('textbox', { name: 'Icon input' }).evaluate(node => parseFloat(getComputedStyle(node).paddingLeft))).toBeGreaterThanOrEqual(24)
  await expect(states.getByRole('button', { name: 'Avatar mark' }).locator('svg')).toHaveCSS('width', '32px')
  await expect.soft(states.getByRole('button', { name: 'Avatar mark' })).toHaveCSS('box-shadow', 'none')
  await expect.soft(states.getByRole('button', { name: 'Background tasks' })).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect.soft(states.getByRole('button', { name: 'Transcript step' })).toHaveCSS('padding-left', '2px')
  await expect.soft(states.getByRole('button', { name: 'Transcript step' })).toHaveCSS('padding-right', '6px')
  const send = states.getByRole('button', { name: 'Queue message' })
  const normal = await send.evaluate(node => getComputedStyle(node).backgroundColor)
  await send.hover()
  await expect.poll(() => send.evaluate(node => getComputedStyle(node).backgroundColor)).not.toBe(normal)
})

/**
 * A tool row outside a turn's work fold draws on the shared `Card
 * variant="plate"`, with its default `gap-4`/`py-4` zeroed back to the
 * app's one-line rung (`Items.tsx`'s `Row`). That override is a class name a
 * unit test can read without a browser, but the height it is supposed to
 * hold only a layout engine can confirm — a lost override still shows the
 * right class and a ~62px row. This measures the rendered row itself, so it
 * fails the day the rung grows back.
 */
test('a tool row outside the work fold keeps the app\'s one-line rung', async ({ page }) => {
  await page.goto('/design.html?view=code')
  const sample = page.getByTestId('inline-diff-sample')
  await expect(sample).toBeVisible()
  const row = sample.locator('[data-slot="card"][data-variant="plate"]')
  await expect(row).toHaveCount(1)
  const height = await row.locator('button').first().evaluate(node => node.getBoundingClientRect().height)
  expect(height).toBeGreaterThanOrEqual(24)
  expect(height).toBeLessThanOrEqual(32)
})

test('the account marks case shows every size and the empty seat as the app draws it', async ({ page }) => {
  await page.goto('/design.html?view=row')
  const sizes = page.locator('[data-catalog-case="account-mark-sizes"]')
  await expect(sizes).toBeVisible()
  // sm, default and lg, tinted and plain, then the tinted and plain dot. These
  // widths mirror the `.avatarSm` (22px), `.avatar` (30px), `.avatarLg` (44px)
  // and `.avatarDot` (10px) literals in design/patterns/Settings.module.css —
  // resizing `AccountMark` means editing this spec too (#995).
  const widths = await sizes.locator(':scope > span').evaluateAll(marks => marks.map(mark => Math.round(mark.getBoundingClientRect().width)))
  expect(widths).toEqual([22, 22, 30, 30, 44, 44, 10, 10])
  // The empty seat: no plate and a dashed ring, drawn by the real rule in a real engine.
  const off = page.locator('[data-catalog-case="account-mark-off"] [data-off]')
  // A missing `data-off` would otherwise fail as a 30s "Test timeout …
  // locator.evaluate" rather than a named assertion (#995).
  await expect(off).toHaveCount(1)
  const look = await off.evaluate(node => {
    const style = getComputedStyle(node)
    return { background: style.backgroundColor, outline: style.outlineStyle, shadow: style.boxShadow }
  })
  expect(look).toEqual({ background: 'rgba(0, 0, 0, 0)', outline: 'dashed', shadow: 'none' })
})

/**
 * Two regressions a re-vendoring of `toggle-group.tsx` or a stale `cn()`
 * merge could reintroduce (`design/patterns/Settings.tsx`'s `Segmented`,
 * `design/ui/toggle-group.tsx`): the chosen answer must actually read as
 * lifted off its own track, not blend into it; and pointing at an unchosen
 * answer must never fade its label — the primitive's own `hover:text-
 * muted-foreground` lowers it from secondary ink toward tertiary, which is
 * dimmer, not stronger. Measured on the catalogue's own instance
 * (`view=control`, "Reasoning effort") rather than a fabricated fixture.
 */
test('a segmented control lifts its chosen answer off the track and never fades an unchosen one on hover', async ({ page }) => {
  await page.goto('/design.html?view=control')
  const track = page.getByRole('radiogroup', { name: 'Reasoning effort' })
  await expect(track).toBeVisible()
  const chosen = track.getByRole('radio', { name: 'Medium', exact: true })
  const unchosen = track.getByRole('radio', { name: 'Low', exact: true })

  const [trackBg, chosenBg] = await Promise.all([
    track.evaluate(node => getComputedStyle(node).backgroundColor),
    chosen.evaluate(node => getComputedStyle(node).backgroundColor),
  ])
  expect(chosenBg).not.toBe(trackBg)

  const brightness = (rgb: string) => {
    const channels = rgb.match(/\d+(\.\d+)?/g)!.map(Number)
    return (channels[0] + channels[1] + channels[2]) / 3
  }
  const resting = brightness(await unchosen.evaluate(node => getComputedStyle(node).color))
  await unchosen.hover()
  // Polls rather than reading once: `transition-colors` means the value right
  // after the hover event may still be mid-animation.
  await expect.poll(async () => brightness(await unchosen.evaluate(node => getComputedStyle(node).color)))
    .toBeLessThanOrEqual(resting)
})
