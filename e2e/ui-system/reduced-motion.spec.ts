import { expect, test, type Page } from '@playwright/test'

/*
  Motion reduced, every change arrives at once (#785).

  The suite runs with `reducedMotion: 'reduce'`, and app.css answers it by
  taking durations to zero. It used to take them to 0.01ms, and since
  `transition-property` is `all` unless an element names its own, that made
  every property of every element a transition: created by the change, not
  started until the next frame, and holding the old value until then.

  Each read below is taken in the same task as the change that should move
  it. No frame can run in between, so a transition that holds a value is
  caught every time; a read after an input's round trip catches it only when
  no frame happened to run first.
*/

const label = 'Learn from every single tab of the settings screen'

test('a focused row makes room for its ⋯ before the next frame', async ({ page }) => {
  await page.goto('/preview.html')
  const row = page.locator('[class*="sidebar_"] [class*="rowWrap_"]').filter({
    has: page.locator(`button[aria-label="Actions for ${label}"]`),
  })
  await expect(row.getByRole('img', { name: 'Worktree chore/settings-audit', exact: true })).toBeVisible()
  await page.mouse.move(1400, 0)
  const read = await row.evaluate(async (node) => {
    const mark = node.querySelector('[role="img"][aria-label="Worktree chore/settings-audit"]')!
    const box = () => {
      const rect = mark.getBoundingClientRect()
      return { left: rect.left, right: rect.right, top: rect.top }
    }
    const resting = box()
    // `:focus-within` gives the row the padding its ⋯ needs, as a hover does.
    node.querySelector<HTMLElement>('button[data-density]')!.focus()
    const first = box()
    const started = document.getAnimations()
      .filter((animation) => animation instanceof CSSTransition
        && node.contains((animation.effect as KeyframeEffect | null)?.target ?? null))
      .map((animation) => (animation as CSSTransition).transitionProperty)
    // Whatever the focus started, let it finish before the second read: a
    // transition waits a frame or two for its start time, then runs.
    await Promise.all(document.getAnimations()
      .filter((animation) => animation.playState === 'running' && animation.effect?.getComputedTiming().endTime !== Infinity)
      .map((animation) => animation.finished.catch(() => undefined)))
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    return { resting, first, later: box(), started }
  })
  // The control: focus does move the mark, so a held read would differ.
  expect(read.later.right).toBeLessThan(read.resting.right)
  expect(read.first).toEqual(read.later)
  expect(read.started).toEqual([])
})

test('a looping keyframe stands still at rest, and still ends as an animation', async ({ page }) => {
  await page.goto('/preview.html')
  const read = await page.evaluate(async () => {
    const ended: string[] = []
    document.addEventListener('animationend', (event) => ended.push(event.animationName))
    const line = document.createElement('span')
    line.className = 'hd-cadence'
    line.textContent = 'Writing the answer'
    document.body.append(line)
    const first = getComputedStyle(line).backgroundPosition
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const later = getComputedStyle(line).backgroundPosition
    line.remove()
    return { first, later, ended }
  })
  // Not the keyframe's first frame (140%), then its resting place a frame on.
  expect(read.first).toBe('0% 0%')
  expect(read.later).toBe('0% 0%')
  // An instant, not `animation: none`: whatever waits for its end still hears it.
  expect(read.ended).toContain('hd-cadence')
})

test('a declared transition arrives at once, and a declared delay still holds', async ({ page }) => {
  await page.goto('/preview.html')
  const read = await page.evaluate(async () => {
    // A width that slides and a visibility that waits for the slide, as
    // Workbench's sidebar declares them. The rule takes the slide away and
    // leaves the wait, so a surface whose wait was only for its slide has to
    // drop the wait itself; the two tests below hold the sidebar to that.
    const column = document.createElement('div')
    column.style.width = '100px'
    column.style.transition = 'width 300ms ease, visibility 0s linear 300ms'
    document.body.append(column)
    getComputedStyle(column).width
    column.style.width = '0px'
    column.style.visibility = 'hidden'
    const now = { width: column.getBoundingClientRect().width, visibility: getComputedStyle(column).visibility }
    await new Promise((resolve) => setTimeout(resolve, 450))
    const later = getComputedStyle(column).visibility
    column.remove()
    return { now, later }
  })
  expect(read.now).toEqual({ width: 0, visibility: 'visible' })
  expect(read.later).toBe('hidden')
})

/*
  Workbench's own sidebar, on the design catalog's Panels tab: the real
  component and stylesheet, over a store that answers the sidebar's verbs as
  the app's does. With the slide gone, a sidebar put away has nothing left to
  wait for, and until it is hidden its controls are in reach of Tab while
  nothing shows them. Each read is taken the moment the change lands.
*/
type Reading = { visibility: string, focusable: boolean }
type PutAway = { before: Reading, now: Reading, later: Reading }

/**
 * Arms a watch on the sidebar: the moment the attribute that puts it away
 * lands, it reads the column's visibility and whether one of its controls
 * takes focus, and again once the wait it used to have would be over.
 */
const watchPutAway = (page: Page) => page.evaluate(() => {
  const column = [...document.querySelectorAll<HTMLElement>('div')].find((node) => /(^|\s)_sidebar_/.test(node.className) && node.style.width)!
  const control = [...column.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === 'New session')!
  const read = (): Reading => {
    control.focus()
    const focusable = document.activeElement === control
    control.blur()
    return { visibility: getComputedStyle(column).visibility, focusable }
  }
  const before = read()
  ;(window as unknown as { putAway: Promise<PutAway> }).putAway = new Promise((resolve) => {
    const watch = new MutationObserver(() => {
      if (!column.hasAttribute('data-hidden') || column.hasAttribute('data-floating')) return
      watch.disconnect()
      const now = read()
      setTimeout(() => resolve({ before, now, later: read() }), 450)
    })
    watch.observe(column, { attributes: true, attributeFilter: ['data-hidden', 'data-floating'] })
  })
})
const readPutAway = (page: Page) => page.evaluate(() => (window as unknown as { putAway: Promise<PutAway> }).putAway)

test('a sidebar collapsed with motion reduced is hidden at once, with nothing in it to Tab to', async ({ page }) => {
  await page.goto('/design.html?view=panels')
  const hide = page.getByRole('button', { name: 'Hide sidebar', exact: true })
  await expect(hide).toBeVisible()
  await watchPutAway(page)
  await hide.click()
  const read = await readPutAway(page)
  // The control: before the change a control in it takes focus.
  expect(read.before).toEqual({ visibility: 'visible', focusable: true })
  expect(read.now).toEqual({ visibility: 'hidden', focusable: false })
  expect(read.later).toEqual({ visibility: 'hidden', focusable: false })
})

test('a floating sidebar put away with motion reduced is hidden at once, with nothing in it to Tab to', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 900 })
  await page.goto('/design.html?view=panels')
  // Its header's toggle lies under the right panel, which a window this
  // narrow gives the conversation's width; pressed where it is.
  const show = page.locator('button[aria-label="Show sidebar"]').filter({ visible: true }).first()
  await expect(show).toBeAttached()
  await show.evaluate((node: HTMLButtonElement) => node.click())
  await expect(page.getByRole('dialog', { name: 'Sidebar', exact: true })).toBeVisible()
  await watchPutAway(page)
  await page.keyboard.press('Escape')
  const read = await readPutAway(page)
  expect(read.before).toEqual({ visibility: 'visible', focusable: true })
  expect(read.now).toEqual({ visibility: 'hidden', focusable: false })
  expect(read.later).toEqual({ visibility: 'hidden', focusable: false })
})
