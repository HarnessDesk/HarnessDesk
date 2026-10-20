import { expectTitleRoom } from './title-contract'
import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { FRAME } from '../../packages/ui/src/design/frame'
import { teamBar, teamSeats, selectTeamPage, closeTeamDetails } from './team-frame-actions'

const captureFrame = async (page: import('@playwright/test').Page, name: string) => {
  const directory = process.env.TEAM_FRAME_SHOTS_DIR
  if (!directory) return
  if (name.endsWith('-dark')) await expect(page.locator('body')).toHaveAttribute('data-hd-dark-theme', '')
  else await expect(page.locator('body')).not.toHaveAttribute('data-hd-dark-theme', '')
  await page.evaluate(async () => { await document.fonts.ready })
  mkdirSync(directory, { recursive: true })
  await page.screenshot({ path: `${directory}/${name}.png` })
}

for (const theme of ['light', 'dark'] as const) {
  test(`Team frame: one sidebar, segmented tabs and a reversible layout toggle in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?team-frame=running&theme=${theme}`)
    if (theme === 'dark') await expect(page.locator('body')).toHaveAttribute('data-hd-dark-theme', '')
    else await expect(page.locator('body')).not.toHaveAttribute('data-hd-dark-theme', '')
    const team = page.locator('[data-frame-id="team-frame"]')
    await expect(team.getByRole('tablist', { name: 'Team views', exact: true }).getByRole('tab')).toHaveCount(3)
    await expect(team.locator('[data-slot="team-room"] aside')).toHaveCount(0)
    await expect(page.locator('[data-frame-region="left"]')).toHaveCount(1)
    await expect(page.getByRole('navigation', { name: 'Workspace actions', exact: true })).toHaveCount(1)
    const header = teamBar(team)
    await expect(header.locator('[data-slot="avatar-stack"]')).toHaveCount(0)
    const seats = await teamSeats(team)
    await expect(seats.locator('[data-slot="list-row-lead"] svg')).toHaveCount(2)
    await closeTeamDetails(team)
    await expect(header.getByRole('button', { name: 'Wrap', exact: true })).toHaveCount(0)
    expect((await header.locator('..').boundingBox())!.height).toBe(FRAME.bar.height)
    await expectTitleRoom(header.locator('[data-topbar-title]'))
    await captureFrame(page, `after-frame-running-1440-${theme}`)
    await selectTeamPage(team, 'room')
    await team.locator('[data-slot="workbench-main"]').getByRole('button', { name: /^(Chat|Split)$/ }).click()
    await page.getByRole('menuitemradio', { name: 'Split', exact: true }).click()
    await expect(team.locator('[data-slot="side-by-side-tile"]')).toHaveCount(2)
    await team.locator('[data-slot="workbench-main"]').getByRole('button', { name: /^(Chat|Split)$/ }).click()
    await expect(page.getByRole('menuitemradio', { name: 'Split', exact: true })).toHaveAttribute('aria-checked', 'true')
    await page.getByRole('menuitemradio', { name: 'Chat', exact: true }).click()
    await expect(team.locator('[data-slot="side-by-side-tile"]')).toHaveCount(0)
    await expect(team.locator('[data-team-page="room"]')).toHaveAttribute('data-active', '')
    await header.getByRole('button', { name: 'More', exact: true }).click()
    await expect(page.getByRole('menuitem', { name: 'Fill the window', exact: true })).toBeVisible()
  })
  test(`Team frame: folded destinations and tools stay reachable in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 720, height: 760 })
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?team-frame&theme=${theme}`)
    const team = page.locator('[data-frame-id="team-frame"]')
    const header = teamBar(team)
    await expect(header.getByRole('button', { name: 'Split', exact: true })).toBeHidden()
    await page.evaluate(async () => { await document.fonts.ready })
    await captureFrame(page, `after-frame-720-${theme}`)
    await header.locator('[data-topbar-title]').getByRole('button').click()
    await expect(page.getByRole('switch', { name: 'Hold messages at the board', exact: true })).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: 'Open pull request', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(header.locator('[data-topbar-title]').getByRole('button')).toBeFocused()
    await selectTeamPage(team, 'room')
    // A pending request stays in the stream while the Team composer remains available.
    await expect(team.getByRole('heading', { name: 'Grant additional access?', exact: true })).toBeVisible()
    const audience = team.getByRole('button', { name: 'Send to', exact: true })
    await expect(audience).toHaveCount(1)
    await expect(audience).toBeVisible()
    await expect(audience).toBeEnabled()
    await expect(team.locator('textarea')).toBeVisible()
    await expect(team.locator('textarea')).toBeEnabled()
    await selectTeamPage(team, 'findings')
    await expect(team.locator('[data-slot="tool-pane"][aria-label="Findings"]')).toBeVisible()
    expect(await team.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    expect(await header.getByRole('button', { name: 'More', exact: true }).evaluate(el => {
      const box = el.getBoundingClientRect(); const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
      return hit === el || el.contains(hit)
    })).toBe(true)
  })
  test(`Team frame: folded layout toggle reports its state in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 720, height: 760 })
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?team-frame=running&theme=${theme}`)
    const team = page.locator('[data-frame-id="team-frame"]')
    const header = teamBar(team)
    await selectTeamPage(team, 'room')
    await team.locator('[data-slot="workbench-main"]').getByRole('button', { name: /^(Chat|Split)$/ }).click()
    const toggle = page.getByRole('menuitemradio', { name: 'Split', exact: true })
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await toggle.click()
    await expect(team.locator('[data-slot="side-by-side-tile"]')).toHaveCount(2)
    await team.locator('[data-slot="workbench-main"]').getByRole('button', { name: /^(Chat|Split)$/ }).click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await page.getByRole('menuitemradio', { name: 'Chat', exact: true }).click()
    await expect(team.locator('[data-slot="side-by-side-tile"]')).toHaveCount(0)

  })
  test(`Team frame: subject menu labels share one left edge in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 720, height: 760 })
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?team-frame=running&theme=${theme}`)
    if (theme === 'dark') await expect(page.locator('body')).toHaveAttribute('data-hd-dark-theme', '')
    else await expect(page.locator('body')).not.toHaveAttribute('data-hd-dark-theme', '')
    const team = page.locator('[data-frame-id="team-frame"]')
    await teamBar(team).locator('[data-topbar-title]').getByRole('button').click()
    const labelLeft = (role: 'switch' | 'menuitem' | 'menuitemradio', label: string) =>
      page.getByRole(role, { name: label, exact: true }).evaluate((row, label) => {
        const text = [...row.querySelectorAll('span')].find(span => span.textContent?.trim() === label)
        return text!.getBoundingClientRect().left
      }, label)
    const edges = await Promise.all([
      labelLeft('menuitem', 'Open pull request'),
      labelLeft('menuitem', 'Wrap…'),
      labelLeft('menuitem', 'Rename'),
    ])
    expect(Math.max(...edges) - Math.min(...edges)).toBeLessThanOrEqual(1)
    await captureFrame(page, `after-controls-${theme}`)
    await page.keyboard.press('Escape')
    await selectTeamPage(team, 'room')
    await team.getByRole('button', { name: 'Send to', exact: true }).click()
    const audienceEdges = await Promise.all([
      labelLeft('menuitemradio', 'Everyone in the Team'),
      labelLeft('switch', 'Board-only'),
    ])
    expect(Math.max(...audienceEdges) - Math.min(...audienceEdges)).toBeLessThanOrEqual(1)
    await expect(page.getByRole('switch', { name: 'Board-only', exact: true })).toBeVisible()
  })
  test(`Team frame: Wrap is outlined on a ready Overview in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?team-frame=ready&theme=${theme}`)
    const team = page.locator('[data-frame-id="team-frame"]')
    const wrap = team.locator('[data-slot="team-overview"]').getByRole('button', { name: 'Wrap', exact: true })
    await expect(wrap).toBeVisible()
    await expect(wrap).toHaveAttribute('data-variant', 'outline')
    await expect(teamBar(team).getByRole('button', { name: 'Wrap', exact: true })).toHaveCount(0)
  })
}


for (const theme of ['light', 'dark'] as const) {
  {

    for (const [item0, width] of ([1440, 720]).entries()) test(`Team frame: keyboard focus stays visible in body tabs in ${theme} [item ${[item0].join('-')}]`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme as 'light' | 'dark' })
      await page.goto(`/preview.html?team-frame=running&theme=${theme}`)
      await page.setViewportSize({ width, height: 900 })
      const frame = page.locator('[data-frame-id="team-frame"]')
      await selectTeamPage(frame, 'overview')
      const tab = frame.locator('[data-team-page="overview"]:visible')
      await tab.focus()
      await page.keyboard.press('ArrowRight')
      const focused = frame.locator('[data-team-page="board"]:visible')
      await expect(focused).toBeFocused()
      const ring = await focused.evaluate(node => ({ width: parseFloat(getComputedStyle(node).outlineWidth), box: node.getBoundingClientRect().toJSON() }))
      expect(ring.width).toBeGreaterThan(0)
      expect(ring.box.x).toBeGreaterThanOrEqual(0)
      expect(ring.box.x + ring.box.width).toBeLessThanOrEqual(width)


    })
  }
  test(`Team frame: narrow members preserve faces and bounded compact labels in ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 720, height: 760 })
    await page.emulateMedia({ colorScheme: theme as 'light' | 'dark' })
    await page.goto(`/preview.html?team-frame=running&theme=${theme}`)
    const members = await teamSeats(page.locator('[data-frame-id="team-frame"]'))
    await expect(members.locator('[data-slot="list-row-lead"] svg')).toHaveCount(2)
    for (const face of await members.locator('[data-slot="list-row-lead"] svg').all()) expect((await face.boundingBox())!.width).toBe(20)
    const rows = members.locator('[data-slot="list-row"]')
    const titles = rows.locator('[data-slot="list-row-title"]')
    await expect(titles).toHaveText(['Alpha', 'Beta'])
    // This fixture records no model. Only Beta earns a separate runtime label;
    // Alpha already carries that identity in its visible name.
    await expect(rows.nth(0)).toHaveAttribute('aria-label', /Writer conversation/)
    await expect(rows.nth(1)).toHaveAttribute('aria-label', /Reviewer conversation/)
    const runtimeLabel = rows.nth(1).locator('[data-slot="list-row-subtitle"]')
    await expect(runtimeLabel).toHaveText('Alpha')
    await expect(runtimeLabel).toBeVisible()
    const labels = members.locator('[data-slot="list-row-title"], [data-slot="list-row-subtitle"]:visible')
    await testInfo.attach('Seat label geometry', { body: JSON.stringify(await labels.evaluateAll(nodes => nodes.map(node => ({ text: node.textContent, width: node.getBoundingClientRect().width, overflow: node.scrollWidth > node.clientWidth })))), contentType: 'application/json' })
    for (const label of await labels.all()) {
      await expect(label).toBeVisible()
      expect(await label.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
      const box = (await label.boundingBox())!, bounds = (await members.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(bounds.x)
      expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width)
    }
    expect(await members.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
    await captureFrame(page, `after-members-720-${theme}`)
  })
}

test('the Team title uses the fixed shell width and stays inside the bar', async ({ page }) => {
  await page.goto('/preview.html?team-frame=running')
  const header = teamBar(page.locator('[data-frame-id="team-frame"]'))
  await expectTitleRoom(header.locator('[data-topbar-title]'))
  const bar = (await header.boundingBox())!, title = (await header.locator('[data-topbar-title]').boundingBox())!
  expect(title.x).toBeGreaterThanOrEqual(bar.x)
  expect(title.x + title.width).toBeLessThanOrEqual(bar.x + bar.width)
  expect((await header.locator('..').boundingBox())!.height).toBe(FRAME.bar.height)
})

for (const theme of ['light', 'dark'] as const) {
  {

    for (const [item0, name] of (['overview', 'board', 'room', 'findings']).entries()) test(`Team frame: page tabs stay in the first body row under every bar in ${theme} [item ${[item0].join('-')}]`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme })
      await page.goto(`/preview.html?team-frame=running&theme=${theme}`)
      const team = page.locator('[data-frame-id="team-frame"]')
      await selectTeamPage(team, name)
      const header = teamBar(team)
      const bar = (await header.locator('..').boundingBox())!
      const tab = team.locator('[data-team-page="overview"]:visible')
      const box = (await tab.boundingBox())!
      const step = await tab.evaluate(node => parseFloat(getComputedStyle(node).getPropertyValue('--hd-space-2')))
      expect(box.y - bar.y - bar.height, name).toBe(step)
      await expect(header.getByRole('tab')).toHaveCount(0)


    })
  }

  {

    for (const [item0, width] of ([1440, 720]).entries()) test(`Team frame: Details Seats retain their bounded reading width in ${theme} [item ${[item0].join('-')}]`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme })
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`/preview.html?team-frame=running&theme=${theme}`)
      const members = await teamSeats(page.locator('[data-frame-id="team-frame"]'))
      await expect(members).toBeVisible()
      const box = (await members.boundingBox())!
      if (width === 1440) expect((await members.locator('xpath=ancestor::*[@data-frame-region="rail"]').boundingBox())!.width).toBe(FRAME.infoCard.width)
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(width)
      expect(await members.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
      await captureFrame(page, `after-members-${width}-${theme}`)


    })
  }
}

for (const theme of ['light', 'dark']) {
  test(`Team Agent work sentences wrap in a narrow content column in ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 720, height: 760 })
    await page.emulateMedia({ colorScheme: theme as 'light' | 'dark' })
    await page.route('**/src/preview/frames-team-overview.tsx*', async route => {
      const response = await route.fetch(), source = await response.text()
      expect(source).toContain('overviewModel(scene)')
      const sentence = 'Edited the checkout error message and checked the retry budget before sending the review.'
      const model = `(scene === 'narrow' ? (() => { const model = overviewModel(scene); return { ...model, seats: model.seats.map(row => ({ ...row, doing: ${JSON.stringify(sentence)} })) }; })() : overviewModel(scene))`
      await route.fulfill({ response, body: source.replace('overviewModel(scene)', model) })
    })
    await page.goto(`/preview.html?team-overview&theme=${theme}`)
    const narrow = page.locator('#team-overview-narrow')
    await testInfo.attach('narrow work sentence slots', { body: JSON.stringify(await narrow.locator('[data-slot="team-overview"] [data-slot="list-row-subtitle"]').evaluateAll(nodes => nodes.map(node => ({ text: node.textContent, wrap: node.hasAttribute('data-wrap-subtitle'), whiteSpace: getComputedStyle(node).whiteSpace, overflow: getComputedStyle(node).textOverflow, className: node.className })))), contentType: 'application/json' })
    for (const subtitle of await narrow.locator('[data-slot="team-overview"] [data-slot="list-row-subtitle"]').all()) {
      expect(await subtitle.evaluate(node => getComputedStyle(node).whiteSpace)).toBe('normal')
      expect(await subtitle.evaluate(node => getComputedStyle(node).textOverflow)).toBe('clip')
    }
    const work = narrow.locator('[data-slot="team-overview"] [aria-label="Seats"] [data-slot="seat-doing"]').first()
    await expect(work).toBeVisible()
    await expect(work).toContainText('Edited the checkout error message and checked the retry budget before sending the review.')
    const geometry = await work.evaluate(node => {
      const range = document.createRange(); range.selectNodeContents(node)
      return { lines: range.getClientRects().length, space: getComputedStyle(node).whiteSpace, overflow: node.scrollWidth > node.clientWidth, width: node.getBoundingClientRect().width }
    })
    expect(geometry.width).toBeGreaterThanOrEqual(128)
    expect(geometry.space).toBe('normal')
    expect(geometry.lines).toBeGreaterThan(1)
    expect(geometry.overflow).toBe(false)
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`Team frame: narrow mounted More menu is held open in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 720, height: 760 })
    await page.emulateMedia({ colorScheme: theme as 'light' | 'dark' })
    await page.goto(`/preview.html?team-frame=controls&theme=${theme}`)
    await expect(page.getByRole('switch', { name: 'Hold messages at the board', exact: true })).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: 'Fill the window', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await teamBar(page.locator('[data-frame-id="team-frame"]')).locator('[data-topbar-title]').getByRole('button').click()
    await expect(page.getByRole('menuitem', { name: 'Open pull request', exact: true })).toBeVisible()
    await captureFrame(page, `after-controls-720-${theme}`)
  })
}


for (const theme of ['light', 'dark'] as const) {
  test(`Team frame: the attention scene matches the before frame in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?team-frame=needs-you&theme=${theme}`)
    const team = page.locator('[data-frame-id="team-frame"]')
    const work = team.locator('[data-slot="team-overview"]')
    await expect(work.getByText('1 request needs your reply', { exact: true })).toBeVisible()
    const openChat = work.getByRole('button', { name: 'Open Chat', exact: true })
    await expect(openChat).toHaveCount(1)
    await expect(openChat).toBeVisible()
    await captureFrame(page, `after-frame-1440-${theme}`)
    await openChat.click()
    await expect(team.locator('[data-team-page="room"]:visible')).toHaveAttribute('aria-selected', 'true')
    const approval = team.locator('[data-slot="approval-card"]')
    await expect(approval).toHaveCount(1)
    await expect(approval.getByRole('heading', { name: 'Grant additional access?', exact: true })).toBeVisible()
    await expect(approval.locator('[data-slot="approval-meta"][data-kind="person"]')).toContainText('Beta')
    await expect(approval.locator('[data-slot="approval-reason"]')).toHaveText('Beta asks to edit the checkout file before retrying the payment; choose whether to keep the original payment method so this review can continue.')
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`closing Team menus preserve the next control's focus in ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1600, height: 1000 })
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'no-preference' })
    await page.goto(`/preview.html?team-frame=member-chat&theme=${theme}`)
    const team = page.locator('[data-frame-id="team-frame"]')
    // Keep the old popup mounted while the person reaches the next control.
    await page.evaluate(() => document.body.style.setProperty('--hd-duration-exit', '2s'))
    await selectTeamPage(team, 'room')
    const view = team.getByRole('button', { name: /^(Chat|Split)$/ })
    await view.click()
    const actions = team.getByRole('button', { name: 'Actions for Beta', exact: true })
    // Exercise the observed ordering: another control takes focus before the
    // closing popup performs its final focus handoff.
    await page.evaluate(() => {
      const choice = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(node => node.textContent?.trim() === 'Split')!
      choice.click()
      const next = document.querySelector<HTMLButtonElement>('button[aria-label="Actions for Beta"]')!
      next.focus()
      next.click()
    })
    const closing = page.locator('[data-slot="popover-popup"][data-ending-style]')
    await expect(closing).toHaveCount(0)
    await expect(actions).toHaveAttribute('aria-expanded', 'true')
    await page.getByRole('menuitem', { name: 'Open conversation', exact: true }).click()
    await expect(team.getByText('The request helper makes one attempt. I am tracing where transient failures are returned.', { exact: true })).toBeVisible()
    await selectTeamPage(team, 'room')
    await view.click()
    await expect(page.getByRole('menuitemradio', { name: 'Split', exact: true })).toBeVisible()
    await expect(closing).toHaveCount(0)
    await expect(view).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByRole('menuitemradio', { name: 'Chat', exact: true })).toBeVisible()
    await expect(page.getByRole('menuitemradio', { name: 'Split', exact: true })).toBeVisible()
    await info.attach(`chat-view-stays-open-${theme}`, { body: await page.screenshot(), contentType: 'image/png' })
  })
}
