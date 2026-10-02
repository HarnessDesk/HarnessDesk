import { expect, test, type Locator, type Page } from '@playwright/test'

const sidebar = (page: Page) => page.locator('[class*="sidebar_"]')
const workspace = (page: Page) => page.locator('[data-region="sidebar-content"] [data-slot="sidebar-menu-item"]').filter({
  has: page.locator('button[aria-label="Actions for HarnessDesk"]'),
})

test('conversation labels reach the row rail without changing box width on hover', async ({ page }) => {
  await page.goto('/design.html?view=sidebar')
  const example = page.locator('[data-catalog-example="sidebar"]')
  const panel = example.locator(':scope > div').first()
  for (const width of [240, 200]) {
    await panel.evaluate((node, width) => {
      ;(node as HTMLElement).style.width = `${width}px`
      ;(node as HTMLElement).style.maxWidth = 'none'
    }, width)
    for (const kind of ['empty', 'badge'] as const) {
      const row = example.locator(`[data-catalog-label-case="${kind}"]`)
      const button = row.locator('[data-slot="sidebar-menu-button"]')
      const label = row.locator('[data-slot="sidebar-menu-label"]')
      const action = row.locator('[data-slot="sidebar-menu-action"]')
      const rest = await label.boundingBox()
      const buttonBox = await button.boundingBox()
      expect(rest).not.toBeNull()
      expect(buttonBox).not.toBeNull()
      expect(Math.abs(rest!.x + rest!.width - buttonBox!.x - buttonBox!.width)).toBeLessThanOrEqual(1)
      if (kind === 'badge') {
        const marks = row.locator('[data-slot="sidebar-menu-badge"]')
        await expect(marks).toHaveCount(3)
        for (let index = 0; index < await marks.count(); index += 1) await expect(marks.nth(index)).toBeVisible()
      }
      await row.hover()
      await expect(action).toBeVisible()
      const hover = await label.boundingBox()
      expect(hover).toEqual(rest)
    }
  }
})

async function setWidth(page: Page, width: number) {
  await sidebar(page).evaluate((node, width) => {
    node.parentElement!.style.width = `${width}px`
    // The preview's neighboring frame must yield to the wider sidebar too.
    const frame = node.parentElement!.parentElement!.parentElement!
    frame.parentElement!.style.gridTemplateColumns = `${Math.max(380, width + 2)}px minmax(0, 1fr)`
  }, width)
}

/**
 * Read a box once nothing on the page is moving it.
 *
 * Any transition holds its property at the old value until the next animation
 * frame starts it, and a runner that goes a while without a frame holds it
 * there, so reads that agree prove nothing. The suite runs with motion
 * reduced, and app.css used to answer that with a 0.01ms `transition-duration`
 * on every element, which made every property of every element a transition —
 * the padding a hovered row takes to make room for its ⋯, and the width
 * `setWidth` hands the column. In CI run 35328916230 every read of the mark
 * for 165ms after the hover agreed on where it stood before the hover, 2px
 * under the ⋯ — 459 against 457, the resting row's geometry at 480px to the
 * pixel. The rule is zero now (#785) and starts no transition, but a declared
 * delay still starts one, and so does any motion a test turns back on.
 *
 * So wait for the transitions themselves. `getAnimations()` flushes style
 * before it answers, which lists the one the last change has only just made;
 * ask again after each batch finishes, since one can hand over to the next.
 * The wait is bounded, and the bound can wake it: an animation that outlasts
 * `within`, or whose timeline never advances, fails the read by name rather
 * than holding it until the test's own timeout.
 */
async function settled(locator: Locator, within = 10_000) {
  return locator.evaluate(async (node, within) => {
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
    const rect = node.getBoundingClientRect()
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
  }, within)
}

async function unobstructed(locator: Locator) {
  return locator.evaluate(node => {
    const rect = node.getBoundingClientRect()
    return node.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2))
  })
}

test('settled waits out a transition that still holds the old box', async ({ page }) => {
  // The delay stands in for the frame a slow runner has not run yet: the
  // transition exists, and until it starts the box stands where it was. Two
  // reads 40ms apart agree on that box, which is what the old helper returned.
  await page.setContent(`
    <style>#box { transition: padding-left 1ms linear 300ms }</style>
    <div id="box"><span id="mark">mark</span></div>
  `)
  const mark = page.locator('#mark')
  const start = (await settled(mark)).left
  const held = await mark.evaluate(node => {
    node.parentElement!.style.paddingLeft = '100px'
    return node.getBoundingClientRect().left
  })
  expect(held).toBe(start)
  expect((await settled(mark)).left).toBe(start + 100)
})

test('settled gives up, by name, on an animation that outlasts its bound', async ({ page }) => {
  await page.setContent(`
    <style>
      @keyframes drift { to { translate: 10px } }
      #mark { display: inline-block; animation: drift 60s linear }
    </style>
    <span id="mark">mark</span>
  `)
  await expect(settled(page.locator('#mark'), 300)).rejects.toThrow('still moving after 300ms: drift')
})

test('settled gives up on an animation whose timeline never advances', async ({ page }) => {
  // A scroll timeline nobody scrolls is running, finite and never finished,
  // which is how every animation on the page looks while no frame runs.
  await page.setContent(`
    <style>
      @keyframes slide { to { translate: 10px } }
      #mark { display: inline-block; animation: slide 1s linear; animation-timeline: scroll(nearest) }
    </style>
    <div style="height: 100px; overflow: auto"><div style="height: 1000px"><span id="mark">mark</span></div></div>
  `)
  const mark = page.locator('#mark')
  // The control: without scroll-driven animations this would be a 1s clock,
  // and the case above over again.
  expect(await mark.evaluate(node => node.getAnimations()[0]?.timeline?.constructor.name)).toBe('ScrollTimeline')
  await expect(settled(mark, 300)).rejects.toThrow('still moving after 300ms: slide')
})

for (const theme of ['light', 'dark'] as const) {
test(`workspace hover keeps its pin visible and label width fixed (${theme})`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/preview.html')
    await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
    const group = workspace(page)
    const actions = group.getByRole('button', { name: 'Actions for HarnessDesk', exact: true })
    await group.hover()
    await actions.click()
    await page.getByRole('menuitem', { name: 'Pin', exact: true }).click()
    const pin = group.locator('[data-slot="sidebar-menu-badge"][aria-label="Pinned"]')
    const title = group.locator('[data-slot="sidebar-menu-label"]')
    await expect(pin).toBeVisible()

    for (const width of [260, 200, 480]) {
      await setWidth(page, width)
      // Neither metadata nor title should jump when hover controls appear.
      await page.mouse.move(1400, 0)
      await group.getByRole('button').first().blur()
      const before = await settled(title)
      await group.hover()
      const add = group.getByRole('button', { name: 'New session in HarnessDesk', exact: true })
      await expect(add).toBeVisible()
      const after = await settled(title)
      if (width === 260) {
        await group.screenshot({ path: testInfo.outputPath('workspace-hover.png') })
        await testInfo.attach('workspace-geometry', {
          body: JSON.stringify({ pin: await settled(pin), label: after, add: await settled(add), actions: await settled(actions) }),
          contentType: 'application/json',
        })
      }
      // The fixed trailing slot keeps the label's width while its actions appear.
      expect(after.left).toBe(before.left)
      expect(after.right).toBe(before.right)
      expect(after.top).toBe(before.top)
      // The action shares the trailing slot with the badge, so it may cover
      // the pin while hovered; the pin returns when the pointer leaves.
      await expect(pin).toBeVisible()
      expect(await unobstructed(add)).toBe(true)
      expect(await unobstructed(actions)).toBe(true)
    }
    await actions.click()
    await page.getByRole('menuitem', { name: 'Unpin', exact: true }).click()
    await expect(pin).toHaveCount(0)
  })

  for (const density of ['Compact', 'Comfortable'] as const) {
    test(`session hover actions leave checkout marks readable (${theme}, ${density})`, async ({ page }, testInfo) => {
      await page.emulateMedia({ colorScheme: theme })
      await page.goto('/preview.html')
      await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
      await sidebar(page).getByRole('button', { name: 'How this list is shown', exact: true }).click()
      await page.getByRole('menuitem', { name: /^Density\b/ }).hover()
      await page.getByRole('menuitemradio', { name: density, exact: true }).click()
      const label = 'Draft the 2.5 migration notes after reviewing the sidebar target behavior'
      const row = page.locator('[data-region="session-row"] [data-slot="sidebar-menu-item"]').filter({
        has: page.locator(`button[aria-label="Actions for ${label}"]`),
      })
      const open = row.locator('[data-slot="sidebar-menu-button"]')
      const action = row.getByRole('button', { name: `Actions for ${label}`, exact: true })
      const branch = row.getByRole('img', { name: 'Worktree chore/settings-audit', exact: true })
      const gone = row.getByRole('img', { name: /^Folder is gone/ })
      await expect(gone).toBeVisible()

      for (const width of [260, 200, 480]) {
        await setWidth(page, width)
        await row.scrollIntoViewIfNeeded()
        await page.mouse.move(1400, 0)
        await open.blur()
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
        await page.waitForTimeout(300)
        const before = await settled(branch)
        const goneBefore = await settled(gone)
        await row.hover()
        await expect(action).toBeVisible()
        await page.waitForTimeout(300)
        const moved = await settled(branch)
        if (width === 260) {
          await row.screenshot({ path: testInfo.outputPath('session-hover.png') })
          await testInfo.attach('session-geometry', {
            body: JSON.stringify({ branch: moved, gone: await settled(gone), action: await settled(action), font: await open.evaluate(node => getComputedStyle(node).fontSize) }),
            contentType: 'application/json',
          })
        }
        // The action takes the rail and each mark yields one shared target.
        expect(moved.left).toBe(before.left - 24)
        expect(moved.top).toBe(before.top)
        const actionBox = await settled(action)
        expect(actionBox.left + actionBox.width / 2).toBe(before.left + before.width / 2)
        for (const [mark, resting] of [[branch, before], [gone, goneBefore]] as const) {
          const markBox = await settled(mark)
          expect(markBox.left).toBe(resting.left - 24)
          expect(markBox.top).toBe(resting.top)
          expect(markBox.right <= actionBox.left || actionBox.right <= markBox.left).toBe(true)
          expect(await unobstructed(mark)).toBe(true)
        }
        expect(await unobstructed(action)).toBe(true)
        await action.click()
        await expect(page.getByRole('menuitem', { name: 'Archive', exact: true })).toBeVisible()
        await page.keyboard.press('Escape')
      }
      // Focusing the row must also expose its action to the keyboard.
      await page.mouse.move(1400, 0)
      await open.focus()
      await expect(action).toBeVisible()
      await action.focus()
      await page.keyboard.press('Enter')
      await expect(page.getByRole('menuitem', { name: 'Archive', exact: true })).toBeVisible()
    })
  }
}
