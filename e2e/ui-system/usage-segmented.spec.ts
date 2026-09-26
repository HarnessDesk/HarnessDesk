import { expect, test, type Locator, type Page } from '@playwright/test'

test('the conversation header keeps the plan track and separates its reading from the roster token', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/preview.html')
  const strip = page.getByRole('group', { name: 'Plan usage' })
  await expect(strip).toBeVisible()
  // The preview's plan strip holds a meter with a track and a second reading
  // after it; whatever that reading says, it must sit clear of the first.
  await expect(strip.locator('[data-slot="plan-meter"]')).toHaveCount(2)

  const measured = await strip.evaluate(node => {
    const [meter, next] = [...node.querySelectorAll<HTMLElement>('[data-slot="plan-meter"]')]
    const track = meter!.querySelector<HTMLElement>('[data-slot="progress-track"]')!
    const figure = [...meter!.querySelectorAll<HTMLElement>('[data-slot="text"]')].at(-1)!
    const icon = next!.querySelector('svg')
    const reading = [...next!.querySelectorAll<HTMLElement>('[data-slot="text"]')].at(-1)!
    return {
      trackWidth: track.getBoundingClientRect().width,
      gap: next!.getBoundingClientRect().left - figure.getBoundingClientRect().right,
      iconColor: icon ? getComputedStyle(icon).color : null,
      readingColor: getComputedStyle(reading).color,
    }
  })
  expect(measured.trackWidth).toBeGreaterThan(0)
  expect(measured.gap).toBeGreaterThan(0)
  if (measured.iconColor) expect(measured.iconColor).toBe(measured.readingColor)
})

for (const theme of ['light', 'dark'] as const) {
  for (const width of [1440, 980]) {
    test(`dashboard account rows keep their padding and contents at ${width}px in ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/preview.html')
      await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
      const dashboard = page.getByRole('dialog', { name: 'Dashboard', exact: true })
      const accounts = dashboard.locator('nav button[class*="acct_"]')
      await expect(accounts.first()).toBeVisible()
      expect(await accounts.count()).toBeGreaterThan(3)
      await accounts.first().scrollIntoViewIfNeeded()
      const measurements = await accounts.evaluateAll(nodes => nodes.map(node => {
        const box = node.getBoundingClientRect()
        const css = getComputedStyle(node)
        const name = node.querySelector('[class*="acctName"]')!.getBoundingClientRect()
        const meter = node.querySelector('[class*="acctTrack"]')?.getBoundingClientRect()
        return {
          label: node.textContent,
          height: box.height,
          paddingTop: parseFloat(css.paddingTop),
          paddingBottom: parseFloat(css.paddingBottom),
          fontSize: css.fontSize,
          meter: meter ? { width: meter.width, rowWidth: box.width, gap: meter.top - name.bottom } : null,
          contents: [...node.children].map(child => {
            const rect = child.getBoundingClientRect()
            return { top: rect.top - box.top, bottom: box.bottom - rect.bottom }
          }),
        }
      }))
      await testInfo.attach('account-layout', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' })
      await dashboard.locator('nav').screenshot({ path: testInfo.outputPath('accounts.png') })
      for (const row of measurements) {
        expect.soft(row.paddingTop, row.label ?? '').toBeGreaterThanOrEqual(4)
        expect.soft(row.paddingBottom, row.label ?? '').toBeGreaterThanOrEqual(4)
        expect.soft(row.height, row.label ?? '').toBeGreaterThanOrEqual(26)
        if (row.meter) {
          expect.soft(row.meter.width).toBeGreaterThan(row.meter.rowWidth / 2)
          expect.soft(row.meter.gap).toBeGreaterThanOrEqual(3)
        }
        for (const content of row.contents) {
          expect.soft(content.top).toBeGreaterThanOrEqual(4)
          expect.soft(content.bottom).toBeGreaterThanOrEqual(4)
        }
      }
      await accounts.nth(1).click()
      await expect(accounts.nth(1)).toHaveAttribute('data-selected', '')
      await expect.poll(() => accounts.nth(1).evaluate(node => getComputedStyle(node).backgroundColor))
        .not.toBe('rgba(0, 0, 0, 0)')
      await expect(accounts.first()).not.toHaveAttribute('data-selected')
    })

    test(`permission segments contain unequal labels at ${width}px in ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/preview.html')
      await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
      await page.getByRole('combobox', { name: 'settings page', exact: true }).selectOption('permissions')
      const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
      const reviewers = settings.getByRole('radiogroup', { name: 'Reviewed by', exact: true })
      await expect(reviewers.getByRole('radio')).toHaveCount(3)
      await reviewers.scrollIntoViewIfNeeded()
      const measurements = await settings.locator('[data-slot="toggle-group-item"]').evaluateAll(nodes => nodes.map(node => {
        const box = node.getBoundingClientRect()
        const range = document.createRange()
        range.selectNodeContents(node)
        const text = range.getBoundingClientRect()
        const css = getComputedStyle(node)
        return {
          label: node.textContent,
          width: box.width,
          height: box.height,
          fontSize: css.fontSize,
          paddingLeft: parseFloat(css.paddingLeft),
          paddingRight: parseFloat(css.paddingRight),
          textLeft: text.left - box.left,
          textRight: box.right - text.right,
        }
      }))
      await testInfo.attach('segment-layout', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' })
      await settings.screenshot({ path: testInfo.outputPath('permissions.png') })
      for (const option of measurements) {
        expect.soft(option.textLeft, option.label ?? '').toBeGreaterThanOrEqual(option.paddingLeft - 1)
        expect.soft(option.textRight, option.label ?? '').toBeGreaterThanOrEqual(option.paddingRight - 1)
      }
      await expect(reviewers.getByRole('radio', { name: 'You', exact: true })).toBeChecked()
    })
  }
}

/** What the ink has to reach against what it is drawn on: a glyph's 3, text's 4.5. */
const floorOf = (part: string) => part.includes('acctMark') ? 3 : 4.5

/**
 * Override fixture data at its module boundary; Usage still renders the real
 * accounts, selection state, tones and no-meter subline.
 */
async function stageAccounts(page: Page) {
  await page.route('**/src/preview/sidebar-fixture.ts*', async route => {
    const response = await route.fetch()
    await route.fulfill({
      response,
      body: `${await response.text()}\n{
        const templates = [...previewUsage];
        previewUsage.splice(0, previewUsage.length, ...[
          ['normal', 22], ['warning', 90], ['bad', 100], ['no-meter', null]
        ].map(([state, usedPercent], index) => ({
          ...templates[index],
          account: state + '@example.com',
          credits: null,
          reached: null,
          lanes: usedPercent === null ? [] : [{ ...templates[index].lanes[0], usedPercent }],
        })));
      }`,
    })
  })
}

/**
 * Read an account row's ink against what it is drawn on, once nothing on the
 * page is still moving.
 *
 * A transition holds its property at the old value until the next animation
 * frame starts it, so a read straight after a change can be the ink from
 * before it. Selecting a row is one transition for each element that changes:
 * the button's fill, and the colour of each child that takes the selected ink
 * (`.acctMark`, `.acctFigure`, `.acctSub`). The suite runs with motion
 * reduced, and app.css used to answer that with a 0.01ms `transition-duration`
 * on every element (#785), which made all of them transitions. This spec
 * waited on `node.getAnimations()`, which lists only the button's own. On a
 * quiet machine those end together with the children's, so it passed there,
 * but nothing makes them. CI read the fill already the selected one and the
 * ink still the unselected one (run 35386407892, #792): a no-meter row's mark,
 * figure and sub at 2.916, which is `--hd-muted-foreground` on `--hd-active`
 * to three decimals, where the selected ink reads 4.614. The rule is zero now
 * and starts no transition, but a declared delay still starts one, and so does
 * any motion a test turns back on, so the wait still has to be on what is
 * read. The read also paints every ancestor's background under the text, so it
 * is the document's rather than the row's subtree, which
 * `getAnimations({ subtree: true })` would leave out.
 *
 * So wait for the transitions themselves. `getAnimations()` flushes style
 * before it answers, which lists the ones the click has only just made; ask
 * again after each batch finishes, since one can hand over to the next. The
 * read comes in the turn the last look found nothing running, so nothing can
 * start between them. That is why the wait and the read are one function, not
 * a helper the read calls: the page runs only what `evaluate` sends it. The
 * wait is bounded, and the bound can wake it: an animation that outlasts
 * `within`, or whose timeline never advances, fails the read by name rather
 * than holding it until the test's own timeout.
 */
async function inkOf(account: Locator, within = 10_000) {
  return account.evaluate(async (node, within) => {
    const deadline = performance.now() + within
    for (;;) {
      // Paused and endless animations never finish; only the rest can settle.
      const moving = document.getAnimations().filter(animation =>
        animation.playState === 'running' && animation.effect?.getComputedTiming().endTime !== Infinity)
      if (moving.length === 0) break
      const remaining = deadline - performance.now()
      if (remaining <= 0) {
        const names = moving.map(animation =>
          (animation as CSSTransition).transitionProperty ?? (animation as CSSAnimation).animationName ?? (animation.id || 'an animation'))
        throw new Error(`still moving after ${within}ms: ${names.join(', ')}`)
      }
      // Until the batch finishes or the bound comes, whichever is first. A
      // transition the next change interrupts rejects; either way the next
      // pass asks again, so a batch that ends as the bound lands is read, and
      // only what is still running then is named.
      let timer = 0
      await Promise.race([
        Promise.all(moving.map(animation => animation.finished.catch(() => undefined))),
        new Promise(resolve => {
          timer = window.setTimeout(resolve, remaining)
        }),
      ])
      window.clearTimeout(timer)
    }
    const context = document.createElement('canvas').getContext('2d')!
    const stack: Element[] = []
    for (let ancestor: Element | null = node; ancestor; ancestor = ancestor.parentElement) stack.unshift(ancestor)
    const paint = (color: string) => {
      context.fillStyle = color
      context.fillRect(0, 0, 1, 1)
    }
    const luminance = (rgb: Uint8ClampedArray) => {
      const channels = [...rgb].slice(0, 3).map(channel => {
        const value = channel / 255
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
      })
      return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
    }
    return [...node.querySelectorAll('[class*="acctMark"], [class*="acctName"], [class*="acctFigure"], [class*="acctSub"]')].map(child => {
      context.clearRect(0, 0, 1, 1)
      for (const ancestor of stack) paint(getComputedStyle(ancestor).backgroundColor)
      const background = luminance(context.getImageData(0, 0, 1, 1).data)
      const color = getComputedStyle(child).color
      paint(color)
      const foreground = luminance(context.getImageData(0, 0, 1, 1).data)
      return {
        part: child.className,
        text: child.textContent,
        color,
        ratio: (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05),
      }
    })
  }, within)
}

for (const [look, theme] of [
  ['desk', 'light'], ['desk', 'dark'], ['studio', 'light'], ['studio', 'dark'],
] as const) {
  test(`${look} Dashboard keeps the first band aligned and its hero readings judged in ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await stageAccounts(page)
    await page.goto('/preview.html')
    await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
    await page.getByRole('combobox', { name: 'interface', exact: true }).selectOption(look)
    const dashboard = page.getByRole('dialog', { name: 'Dashboard', exact: true })
    const firstBand = dashboard.getByRole('heading', { name: 'What is left', exact: true })
    await expect(firstBand).toBeVisible()

    const measurement = await firstBand.evaluate(node => {
      const dialog = node.closest('[role="dialog"]')!
      const blurb = dialog.querySelector<HTMLElement>('[class*="pageBlurb"]')!
      const card = dialog.querySelector<HTMLElement>('article')!
      const title = node.getBoundingClientRect()
      const text = document.createRange()
      text.selectNodeContents(node)
      const textBox = text.getBoundingClientRect()
      const pageTitle = dialog.querySelector<HTMLElement>('[data-slot="page-title"]')!
      const headingStyle = getComputedStyle(node)
      const figures = [...dialog.querySelectorAll<HTMLElement>('[data-role="figure"]')]
        .map(figure => ({ reading: figure.textContent, color: getComputedStyle(figure).color }))
      return {
        blurbToHeading: textBox.top - blurb.getBoundingClientRect().bottom,
        headingToCard: card.getBoundingClientRect().top - textBox.top,
        foreground: getComputedStyle(pageTitle).color,
        danger: headingStyle.getPropertyValue('--hd-danger-ink').trim(),
        warning: headingStyle.getPropertyValue('--hd-warning-ink').trim(),
        figures,
        titleTop: title.top,
      }
    })
    await testInfo.attach('dashboard-reading-layout', { body: JSON.stringify(measurement, null, 2), contentType: 'application/json' })

    // At rest the first band sits in the page's rhythm under the blurb. It
    // used to stand 55px down, behind a strip-high padding the sticky head
    // carried to cover the title strip once stuck — empty space at rest. The
    // head now paints that cover above itself instead (its ::before).
    expect.soft(measurement.blurbToHeading).toBeGreaterThanOrEqual(20)
    expect.soft(measurement.blurbToHeading).toBeLessThanOrEqual(34)
    expect(measurement.headingToCard).toBeGreaterThan(0)

    const sticky = await firstBand.evaluate(async node => {
      const page = node.closest<HTMLElement>('[data-slot="app-window-page"]')!
      page.scrollTop = page.scrollHeight
      // The cover over the title strip is drawn once the head is stuck, a
      // scroll-state query the engine settles on the next frames.
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const words = document.createRange()
      words.selectNodeContents(node)
      const text = words.getBoundingClientRect()
      const pageBox = page.getBoundingClientRect()
      return {
        scrollTop: page.scrollTop,
        textTop: text.top,
        pageTop: pageBox.top,
        offset: text.top - pageBox.top,
        // The strip is `max(26px, the title bar)`; once stuck, its resolved
        // height is the cover the head's text box hangs above the head.
        strip: parseFloat(getComputedStyle(node.closest('[data-sticky]')!.querySelector('[class*="sectionHeadText"]')!, '::before').height),
      }
    })
    await testInfo.attach('dashboard-sticky-layout', { body: JSON.stringify(sticky, null, 2), contentType: 'application/json' })
    // Scrolling the page must leave the first sticky band's words in the page
    // viewport, right under the title strip. A static heading would be above
    // it after this full scroll.
    expect(sticky.scrollTop).toBeGreaterThan(0)
    // Stuck, the words stop right under the title strip — never under it,
    // and no further down than one space step (Studio's page pads a little
    // deeper than Desk's).
    expect(sticky.offset).toBeGreaterThanOrEqual(sticky.strip)
    expect(sticky.offset).toBeLessThanOrEqual(sticky.strip + 4)
    expect(measurement.figures.find(figure => figure.reading === '0%')?.color).toBe(measurement.danger)
    expect(measurement.figures.find(figure => figure.reading === '10%')?.color).toBe(measurement.warning)
    for (const reading of ['78%']) {
      expect(measurement.figures.find(figure => figure.reading === reading)?.color, reading).toBe(measurement.foreground)
    }
  })

  test(`${look} selected account text meets AA in ${theme}`, async ({ page }, testInfo) => {
    await stageAccounts(page)
    await page.goto('/preview.html')
    await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
    await page.getByRole('combobox', { name: 'interface', exact: true }).selectOption(look)
    const dashboard = page.getByRole('dialog', { name: 'Dashboard', exact: true })
    for (const state of ['normal', 'warning', 'bad', 'no-meter']) {
      const account = dashboard.locator(`nav button[title$="${state}@example.com"]`)
      await account.click()
      await expect(account).toHaveAttribute('data-selected', '')
      const measurements = await inkOf(account)
      await testInfo.attach(`selected-${state}`, { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' })
      await account.screenshot({ path: testInfo.outputPath(`selected-${state}.png`) })
      for (const measurement of measurements) {
        expect.soft(measurement.ratio, `${state}: ${measurement.text || 'mark'}`).toBeGreaterThanOrEqual(floorOf(measurement.part))
      }
    }
  })
}

test('selected account ink waits for a child transition that the row does not carry', async ({ page }) => {
  await stageAccounts(page)
  await page.goto('/preview.html')
  await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption('light')
  await page.getByRole('combobox', { name: 'interface', exact: true }).selectOption('desk')
  const parts = '[class*="acctMark"], [class*="acctFigure"], [class*="acctSub"]'
  // The reduced-motion rule starts no transition for an element that declares
  // none, and a declared delay still starts one. That holds the children where
  // CI found them: each child's colour change is a transition of its own, made
  // with the selection and held at the unselected ink, while the row has none
  // of its own. It is long enough that no stall can end it.
  await page.addStyleTag({ content: `${parts} { transition-delay: 30s !important }` })
  const account = page.getByRole('dialog', { name: 'Dashboard', exact: true }).locator('nav button[title$="no-meter@example.com"]')
  const inks = () => account.locator(parts).evaluateAll(nodes => nodes.map(node => getComputedStyle(node).color))
  // Nothing moves once this returns, so what follows is the ink the row rests on.
  await inkOf(account)
  const unselected = await inks()
  await account.click()
  await expect(account).toHaveAttribute('data-selected', '')

  // The control: what this spec once waited on, the row's own animations, has
  // nothing in it while every child still holds the unselected ink. A read
  // here is the CI failure with no rig.
  await account.evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished)))
  expect(await inks()).toEqual(unselected)

  // The wait sees them: they are still running, so a bounded read gives up by
  // name instead of returning the unselected ink.
  await expect(inkOf(account, 300)).rejects.toThrow(/still moving after 300ms:.*\bcolor\b/)

  // And when they finish the wait comes back, on the ink they landed on. The
  // release comes while the wait is under way, so a wait that returned early
  // would read the held ink and miss the floors. It lets go of the whole
  // page's: the row that lost the selection holds its own colour change the
  // same way.
  await page.evaluate(() => {
    window.setTimeout(() => {
      for (const animation of document.getAnimations()) animation.effect?.updateTiming({ delay: 0 })
    }, 200)
  })
  for (const measurement of await inkOf(account)) {
    expect(measurement.ratio, measurement.text || 'mark').toBeGreaterThanOrEqual(floorOf(measurement.part))
  }
})

test('no band head covers what it heads, first band or not', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await stageAccounts(page)
  await page.goto('/preview.html')
  const dashboard = page.getByRole('dialog', { name: 'Dashboard', exact: true })
  await expect(dashboard.getByRole('heading', { name: 'What is left', exact: true })).toBeVisible()
  const overlaps = await dashboard.evaluate(node => {
    const found: string[] = []
    for (const head of node.querySelectorAll<HTMLElement>('[data-sticky]')) {
      // What the head names is the next thing laid out after it, in its band.
      let next = head.nextElementSibling as HTMLElement | null
      while (next && next.getBoundingClientRect().height === 0) next = next.nextElementSibling as HTMLElement | null
      if (!next) continue
      const gap = next.getBoundingClientRect().top - head.getBoundingClientRect().bottom
      if (gap < 0) found.push(`${head.textContent?.trim().slice(0, 30)}: ${Math.round(gap)}px`)
    }
    return found
  })
  expect(overlaps).toEqual([])
})
