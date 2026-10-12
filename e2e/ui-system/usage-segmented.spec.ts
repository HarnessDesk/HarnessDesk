import { expect, test, type Locator, type Page } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'

const mountPlanMeters = async (page: Page, fixtureUsage = false) => {
  await page.evaluate(async fixtureUsage => {
    const container = document.createElement('section')
    document.body.appendChild(container)
    const { mountPlanMetersSpecimen } = await import('/src/preview/frames-supported-controls.tsx' as string)
    mountPlanMetersSpecimen(container, fixtureUsage)
  }, fixtureUsage)
  await expect(page.locator('[data-frame-id="supported-plan-meters"]')).toBeVisible()
}

test('the PlanMeters specimen keeps the plan track and separates its reading from the roster token', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/preview.html')
  await page.evaluate(async () => {
    const { mountPlanMetersSpecimen } = await import('/src/preview/frames-supported-controls.tsx' as string)
    const host = document.createElement('section'); document.querySelector('[data-frame-id="dashboard-overview"] [data-page-destination="dashboard"]:not([hidden])')!.append(host); mountPlanMetersSpecimen(host, true)
  })
  const strip = page.locator('[data-frame-id="supported-plan-meters"]').getByRole('group', { name: 'Plan usage' })
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
    test(`dashboard view rows keep their padding and contents at ${width}px in ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/preview.html')
      await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
      const dashboard = page.locator('[data-frame-id="dashboard-overview"] [data-page-destination="dashboard"]:visible')
      const frame=page.locator('[data-frame-id="dashboard-overview"]')
      const bar=frame.locator('[data-slot="top-bar"]:visible')
      const views=dashboard.getByRole('tab')
      await expect(views.first()).toBeVisible()
      expect(await views.count()).toBe(5)
      const measurements=await views.evaluateAll(nodes=>nodes.map(node=>{
        const box=node.getBoundingClientRect()
        return {label:node.textContent,height:box.height,contents:[...node.children].map(child=>{const rect=child.getBoundingClientRect();return {top:rect.top-box.top,bottom:box.bottom-rect.bottom}})}
      }))
      await testInfo.attach('view-layout',{body:JSON.stringify(measurements,null,2),contentType:'application/json'})
      await bar.screenshot({path:testInfo.outputPath('views.png')})
      const track = await views.first().locator('..').evaluate(node => ({ height: node.getBoundingClientRect().height, padding: parseFloat(getComputedStyle(node).paddingTop) }))
      expect(track).toEqual({ height: 28, padding: 2 })
      for(const row of measurements){
        expect.soft(row.height,row.label??'').toBe(track.height - 2 * track.padding)
        for(const content of row.contents){
          expect.soft(content.top).toBeGreaterThanOrEqual(0)
          expect.soft(content.bottom).toBeGreaterThanOrEqual(0)
          expect.soft(Math.abs(content.top - content.bottom)).toBeLessThanOrEqual(1)
        }
      }
      await views.nth(1).click()
      await expect(views.nth(1)).toHaveAttribute('aria-selected','true')
      await expect.poll(()=>views.nth(1).evaluate(node=>getComputedStyle(node).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
      await expect(views.first()).toHaveAttribute('aria-selected','false')
    })

    test(`permission segments contain unequal labels at ${width}px in ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/preview.html')
      await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
      await page.getByRole('combobox', { name: 'settings page', exact: true }).selectOption('permissions')
      const settings = page.locator('[data-frame-id="settings-sheet"] [data-page-destination="settings"]:visible')
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
const floorOf = (part: string) => part.includes('sidebar-menu-icon') ? 3 : 4.5

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
    return [...node.children].map(child => {
      context.clearRect(0, 0, 1, 1)
      for (const ancestor of stack) paint(getComputedStyle(ancestor).backgroundColor)
      const background = luminance(context.getImageData(0, 0, 1, 1).data)
      const color = getComputedStyle(child).color
      paint(color)
      const foreground = luminance(context.getImageData(0, 0, 1, 1).data)
      return {
        part: child.getAttribute('data-slot') ?? child.className,
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
    const dashboard = page.locator('[data-frame-id="dashboard-overview"] [data-page-destination="dashboard"]:visible')
    const firstBand = dashboard.getByRole('heading', { name: 'What is left', exact: true })
    await expect(firstBand).toBeVisible()

    const column=dashboard.locator('[data-slot="page"][data-width="wide"]')
    const measurement=await column.evaluate(node=>{
      const style=getComputedStyle(node), box=node.getBoundingClientRect()
      const parent=node.parentElement!.getBoundingClientRect()
      const figures=[...node.querySelectorAll<HTMLElement>('[data-role="figure"]')].map(figure=>({reading:figure.textContent,color:getComputedStyle(figure).color}))
      return {gutter:[style.paddingTop,style.paddingLeft,style.paddingRight].map(parseFloat),
        width:box.width-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight),available:parent.width,
        danger:style.getPropertyValue('--hd-danger-ink').trim(),warning:style.getPropertyValue('--hd-warning-ink').trim(),figures}
    })
    await testInfo.attach('dashboard-reading-layout',{body:JSON.stringify(measurement,null,2),contentType:'application/json'})
    expect(measurement.gutter).toEqual([FRAME.page.gutter,FRAME.page.gutter,FRAME.page.gutter])
    expect(measurement.width).toBeCloseTo(Math.min(FRAME.page.wide,measurement.available-2*FRAME.page.gutter),0)
    await expect(dashboard.locator('[data-slot="page-head"], [data-slot="app-window-nav"]')).toHaveCount(0)
    expect(measurement.figures.find(figure=>figure.reading==='0%')?.color).toBe(measurement.danger)
    expect(measurement.figures.find(figure=>figure.reading==='10%')?.color).toBe(measurement.warning)
    // Overview lists accounts needing attention; Plans carries every account.
    // Left keeps neutral healthy text; its continuous bar carries the status tone.
    await dashboard.getByRole('tab',{name:'Plans',exact:true}).click()
    const plansTable = dashboard.getByRole('table')
    await expect(plansTable).toBeVisible()
    // Left is the third column, with the continuous meter and percent.
    const percentCellFor = (account: string) =>
      plansTable.getByRole('row', { name: new RegExp(account) }).getByRole('cell').nth(2)
    // `data-tone` is set synchronously with the render — no CSS transition to
    // settle before it can be read, unlike the computed colour it selects
    // (see `inkOf`'s own long comment on why a colour read cannot be trusted
    // right after a change here). It is the same attribute `usageReadingTone`
    // draws the colour from, so asserting it is asserting the ink without the
    // timing hazard.
    const readingAndTone = (locator: Locator) =>
      locator.evaluate(node => ({
        reading: node.textContent,
        tone: node.querySelector('[data-slot="text"]')?.getAttribute('data-tone') ?? null,
      }))

    const healthy = await readingAndTone(percentCellFor('normal@example.com'))
    expect(healthy.reading, 'healthy').toBe('78%')
    expect(healthy.tone, 'healthy').toBeNull()
    // The table's own low and spent percent cells carry the same judgement
    // the Overview headline figures do above — the tone the table now draws
    // is guarded where it is actually drawn, not only upstream (claude/plans-
    // table review, N2).
    const low = await readingAndTone(percentCellFor('warning@example.com'))
    expect(low.reading, 'low').toBe('10%')
    expect(low.tone, 'low').toBe('warning')
    const out = await readingAndTone(percentCellFor('bad@example.com'))
    expect(out.reading, 'out').toBe('0%')
    expect(out.tone, 'out').toBe('danger')
  })

  test(`${look} selected view row text meets AA in ${theme}`, async ({ page }, testInfo) => {
    await stageAccounts(page)
    await page.goto('/preview.html')
    await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
    await page.getByRole('combobox', { name: 'interface', exact: true }).selectOption(look)
    const dashboard = page.locator('[data-frame-id="dashboard-overview"] [data-page-destination="dashboard"]:visible')
    // Plans carries the "N low" count in the warning tone, which has to read on
    // the selected fill as well as the label does.
    for (const view of ['Overview', 'Plans', 'Spend', 'Activity', 'Projects']) {
      const row = dashboard.getByRole('tab',{name:view,exact:true})
      await row.click()
      await expect(row).toHaveAttribute('aria-selected', 'true')
      const measurements = await inkOf(row)
      await testInfo.attach(`selected-${view}`, { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' })
      await row.screenshot({ path: testInfo.outputPath(`selected-${view}.png`) })
      for (const measurement of measurements) {
        expect.soft(measurement.ratio, `${view}: ${measurement.text || 'icon'}`).toBeGreaterThanOrEqual(floorOf(measurement.part))
      }
    }
  })
}

test('selected view row ink waits for a child transition that the row does not carry', async ({ page }) => {
  await page.setContent(`<style>
    body{background:white;color:rgb(36,36,36)}button{background:white;color:rgb(95,95,95)}
    button[aria-selected=true]{color:rgb(36,36,36)}button span{transition:color 100ms;transition-delay:30s}
  </style><button role="tab" aria-selected="false"><span>Spend</span></button>`)
  const parts='span'
  const account=page.getByRole('tab',{name:'Spend',exact:true})
  await account.evaluate(node=>node.addEventListener('click',()=>node.setAttribute('aria-selected','true')))
  const inks = () => account.locator(parts).evaluateAll(nodes => nodes.map(node => getComputedStyle(node).color))
  // Nothing moves once this returns, so what follows is the ink the row rests on.
  await inkOf(account)
  const unselected = await inks()
  await account.click()
  await expect(account).toHaveAttribute('aria-selected', 'true')

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
  const dashboard = page.locator('[data-frame-id="dashboard-overview"] [data-page-destination="dashboard"]:visible')
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

test('the supported plan control keeps the plan track and separates its reading from the roster token', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/preview.html')
  await mountPlanMeters(page)
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
