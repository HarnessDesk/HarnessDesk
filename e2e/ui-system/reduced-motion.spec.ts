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

const label = 'Draft the 2.5 migration notes after reviewing the sidebar target behavior'

test('a Diff hunk jump lands in the same task with motion reduced', async ({ page }) => {
  await page.goto('/design.html?view=code')
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true)
  const diff = page.getByTestId('diff-sample')
  await expect(diff).toBeVisible()
  await diff.locator('table').evaluate((table) => {
    const scroller = table.parentElement!
    scroller.style.height = '60px'
    scroller.style.overflowY = 'auto'
    scroller.scrollTop = 0
  })
  await page.evaluate(() => {
    const original = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = function (options) {
      const scroller = document.querySelector<HTMLElement>('[data-testid="diff-sample"] table')!.parentElement!
      const before = scroller.scrollTop
      original.call(this, options)
      if (!scroller.contains(this)) return
      ;(window as unknown as { __hunkRead?: { behavior: ScrollBehavior, before: number, top: number } }).__hunkRead = {
        behavior: typeof options === 'object' ? options.behavior ?? 'auto' : 'auto',
        before,
        top: scroller.scrollTop,
      }
    }
  })
  await diff.getByRole('button', { name: 'Next hunk', exact: true }).click()
  // Diff schedules the call for the row's mounting frame; the wrapper reads
  // immediately after the native call, before any smooth-scroll frame runs.
  await page.waitForFunction(() => '__hunkRead' in window)
  const read = await page.evaluate(() =>
    (window as unknown as { __hunkRead: { behavior: ScrollBehavior, before: number, top: number } }).__hunkRead,
  )
  expect(read.before).toBe(0)
  expect(read.top).toBeGreaterThan(read.before)
  expect(read.behavior).toBe('auto')
  await expect(diff).toContainText('Hunk 2 of 2')
})

test('Conversation jump-to-bottom lands in the same task with motion reduced', async ({ page }) => {
  await page.goto('/preview.html')
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true)
  const scroller = page.locator('[data-live-transcript]')
  await expect(scroller).toBeVisible()
  await scroller.evaluate(async (node) => {
    const element = node as HTMLElement
    element.style.height = '150px'
    element.style.maxHeight = '150px'
    element.scrollTop = element.scrollHeight
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
  await scroller.hover()
  await page.mouse.wheel(0, -10_000)
  const jump = page.getByRole('button', { name: 'Jump to latest', exact: true })
  await expect(jump).toBeVisible()
  await page.evaluate(() => {
    type ScrollArgs = [options?: ScrollToOptions] | [x: number, y: number]
    const original = HTMLElement.prototype.scrollTo as (this: HTMLElement, ...args: ScrollArgs) => void
    HTMLElement.prototype.scrollTo = function (...args: ScrollArgs) {
      const before = this.scrollTop
      original.apply(this, args)
      if (!this.hasAttribute('data-live-transcript')) return
      const options = args[0]
      ;(window as unknown as { __bottomRead?: { behavior: ScrollBehavior, before: number, top: number, bottom: number } }).__bottomRead = {
        behavior: typeof options === 'object' ? options.behavior ?? 'auto' : 'auto',
        before,
        top: this.scrollTop,
        bottom: this.scrollHeight - this.clientHeight,
      }
    }
  })
  await jump.click()
  const read = await page.evaluate(() =>
    (window as unknown as { __bottomRead: { behavior: ScrollBehavior, before: number, top: number, bottom: number } }).__bottomRead,
  )
  expect(read.before).toBeLessThan(read.bottom)
  expect(read.top).toBeCloseTo(read.bottom, 0)
  expect(read.behavior).toBe('auto')
})

test('a scripted transcript jump lands in the same task with motion reduced', async ({ page }) => {
  await page.goto('/preview.html')
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true)
  const scroller = page.locator('[data-live-transcript]')
  await expect(scroller).toBeVisible()
  await scroller.evaluate((node) => {
    const element = node as HTMLElement
    element.style.height = '150px'
    element.style.maxHeight = '150px'
    element.scrollTop = element.scrollHeight
  })
  const rail = page.locator('nav[aria-label="Jump to a message"]')
  await expect(rail).toBeVisible()

  await page.evaluate(() => {
    const original = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = function (options) {
      original.call(this, options)
      const scroller = document.querySelector<HTMLElement>('[data-live-transcript]')!
      ;(window as unknown as { __scrollRead?: { behavior: ScrollBehavior, top: number } }).__scrollRead = {
        behavior: typeof options === 'object' ? options.behavior ?? 'auto' : 'auto',
        top: scroller.scrollTop,
      }
    }
  })

  const before = await scroller.evaluate((node) => (node as HTMLElement).scrollTop)
  await rail.getByRole('option').first().click()
  const read = await page.evaluate(() =>
    (window as unknown as { __scrollRead: { behavior: ScrollBehavior, top: number } }).__scrollRead,
  )
  expect(read.behavior).toBe('auto')
  expect(read.top).toBeLessThan(before)
})

test('a focused row yields its fixed priority slot immediately before the next frame', async ({ page }) => {
  await page.goto('/preview.html')
  const row = page.locator('[data-region="session-row"] [data-left-row]').filter({
    has: page.locator(`button[aria-label="Actions for ${label}"]`),
  })
  const priority = row.locator('[data-left-mark]')
  await expect(priority).toHaveCount(1)
  await expect(priority).toHaveAttribute('role', 'img')
  await expect(priority).toHaveAccessibleName('This folder no longer exists.. The transcript can be read; nothing more can be sent.')
  await expect(priority).toBeVisible()
  await page.mouse.move(1400, 0)
  await row.scrollIntoViewIfNeeded()
  const read = await row.evaluate(async (node) => {
    const mark = node.querySelector('[data-left-mark]')!
    const action = node.querySelector<HTMLElement>('[data-slot="sidebar-menu-action"]')!
    const box = () => {
      const rect = mark.getBoundingClientRect()
      return { left: rect.left, right: rect.right, top: rect.top }
    }
    const resting = box()
    const restingVisibility = { mark: getComputedStyle(mark).visibility, action: getComputedStyle(action).visibility }
    // `:focus-within` gives the fixed trailing slot to the row's action.
    node.querySelector<HTMLElement>('[data-slot="sidebar-menu-button"]')!.focus()
    const first = box()
    const firstVisibility = { mark: getComputedStyle(mark).visibility, action: getComputedStyle(action).visibility }
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
    return { resting, restingVisibility, first, firstVisibility, later: box(),
      laterVisibility: { mark: getComputedStyle(mark).visibility, action: getComputedStyle(action).visibility },
      title: node.querySelector<HTMLButtonElement>('[data-slot="sidebar-menu-button"]')!.title, started }
  })
  // The mark yields at once, without moving its slot or losing the checkout fact.
  expect(read.restingVisibility).toEqual({ mark: 'visible', action: 'hidden' })
  expect(read.firstVisibility).toEqual({ mark: 'hidden', action: 'visible' })
  expect(read.laterVisibility).toEqual(read.firstVisibility)
  expect(read.first).toEqual(read.later)
  expect(read.later).toEqual(read.resting)
  expect(read.title).toContain('Worktree')
  expect(read.title).toContain('chore/settings-audit')
  expect(read.title).toContain('This folder no longer exists.')
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
  const column = [...document.querySelectorAll<HTMLElement>('div')].find((node) => /(^|\s)_sidebar_/.test(node.className) && node.closest('[data-frame-region="left"]'))!
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
  // At this width the right panel covers main, including the sidebar toggle.
  // Collapse the panel through its visible control before opening the sidebar.
  const hidePanel = page.getByRole('button', { name: 'Close pane', exact: true })
  await expect(hidePanel).toBeVisible()
  await hidePanel.click()
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
