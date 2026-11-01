import { expect, test } from '@playwright/test'
import { COLLECT, textReasons, USER } from '../../script/shots/audit.mjs'
import { closeTeamDetails, selectTeamPage, teamSeats } from './team-frame-actions'

for (const theme of ['light', 'dark'] as const) {
  test(`general Team Overview gallery passes the whole-document text audit in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?team-overview&theme=${theme}`)
    await expect(page.locator('#team-overview-answer-approval [data-slot="team-overview"]')).toBeVisible()
    await expect.poll(() => page.locator('body').evaluate(body => body.hasAttribute('data-hd-dark-theme'))).toBe(theme === 'dark')
    expect(textReasons(await page.evaluate(COLLECT), { user: USER })).toEqual([])
  })
}

test('focused Overview exposes its mounted store to preview tooling', async ({ page }) => {
  await page.goto('/preview.html?team-overview=narrow&theme=light')
  await expect(page.locator('#team-overview-narrow [data-slot="team-overview"]')).toBeVisible()
  await expect(page.locator('body')).not.toHaveAttribute('data-hd-dark-theme', '')
  await page.evaluate(() => {
    const preview = (window as unknown as { __hdPreview: { store: { setTheme(value: 'dark'): void } } }).__hdPreview
    preview.store.setTheme('dark')
  })
  await expect(page.locator('body')).toHaveAttribute('data-hd-dark-theme', '')
  expect(await page.evaluate(() => {
    const preview = (window as unknown as { __hdPreview: {
      store: { getSnapshot(): { accountsByRuntime: object } }
    } }).__hdPreview
    return { accounts: preview.store.getSnapshot().accountsByRuntime, keys: Object.keys(preview).sort() }
  })).toEqual({ accounts: {}, keys: ['store'] })
  await page.evaluate(() => {
    const preview = (window as unknown as { __hdPreview: { store: { setTheme(value: 'light'): void } } }).__hdPreview
    preview.store.setTheme('light')
  })
  await expect(page.locator('body')).not.toHaveAttribute('data-hd-dark-theme', '')
  await page.goto('/preview.html?team-overview=narrow&theme=dark')
  await expect(page.locator('#team-overview-narrow [data-slot="team-overview"]')).toBeVisible()
  await expect(page.locator('body')).toHaveAttribute('data-hd-dark-theme', '')
})

test('default gallery keeps its conversation and sidebar preview helpers', async ({ page }) => {
  await page.goto('/preview.html')
  const details = await page.evaluate(() => {
    const preview = (window as unknown as { __hdPreview: {
      store: { getSnapshot(): { sessions: Map<string, unknown> } }
      sessionKey: string
      sidebarFolderlessStore: { getSnapshot(): unknown }
    } }).__hdPreview
    return { keys: Object.keys(preview).sort(), hasSession: preview.store.getSnapshot().sessions.has(preview.sessionKey),
      hasSidebar: !!preview.sidebarFolderlessStore.getSnapshot() }
  })
  expect(details).toEqual({ keys: ['sessionKey', 'sidebarFolderlessStore', 'store'], hasSession: true, hasSidebar: true })
})

for (const theme of ['light', 'dark'] as const) {
  test(`Team Overview: seat descriptions keep a readable line in the narrowest preview in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    for (const width of [240, 280, 320]) {
      await page.setViewportSize({ width, height: 1100 })
      await page.goto(`/preview.html?team-overview=narrow&theme=${theme}`)
      await page.evaluate(() => document.fonts.ready)
      const overview = page.locator('#team-overview-narrow [data-slot="team-overview"]')
      await expect(overview).toHaveAttribute('data-layout', 'narrow')
      if (width === 240) {
        expect(await overview.locator('[data-seat]').first().evaluate(element => element.getBoundingClientRect().width)).toBeCloseTo(128, 0)
      }
      for (const row of await overview.locator('[data-seat]').all()) {
        const geometry = await row.evaluate(element => {
          const heading = element.querySelector('[data-slot="list-row-heading"]')!.getBoundingClientRect()
          const face = element.querySelector('[data-slot="icon-tile"]')!.getBoundingClientRect()
          const description = element.querySelector('[data-slot="list-row-subtitle"]')!.getBoundingClientRect()
          const bounds = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          return {
            faceDelta: Math.abs((face.top + face.bottom - heading.top - heading.bottom) / 2),
            startDelta: Math.abs(description.left - bounds.left - parseFloat(style.paddingLeft) - parseFloat(style.borderLeftWidth)),
            endDelta: Math.abs(bounds.right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth) - description.right),
          }
        })
        expect(geometry.faceDelta).toBeLessThan(1.5)
        expect(geometry.startDelta).toBeLessThan(1)
        expect(geometry.endDelta).toBeLessThan(1)
      }
      const descriptions = overview.locator('[data-seat] [data-slot="list-row-subtitle"]').filter({ hasText: 'Reviewer · Alpha' })
      await expect(descriptions).toHaveCount(3)
      for (const description of await descriptions.all()) {
        const reading = await description.evaluate(element => {
          const lines = new Map<number, string[]>()
          const bounds = element.getBoundingClientRect()
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
          let clipped = false
          for (let node; (node = walker.nextNode());) {
            if (node.parentElement?.closest('.sr-only')) continue
            for (const word of node.textContent!.matchAll(/[^\s·]+/g)) {
              const range = document.createRange()
              range.setStart(node, word.index!)
              range.setEnd(node, word.index! + word[0].length)
              const box = range.getBoundingClientRect()
              if (box.width <= 1) continue
              const line = Math.round(box.top)
              lines.set(line, [...(lines.get(line) ?? []), word[0]])
              clipped ||= box.left < bounds.left - 1 || box.right > bounds.right + 1
            }
          }
          return { lines: [...lines.values()], clipped, overflow: element.scrollWidth > element.clientWidth }
        })
        expect(reading.lines, `seat description at viewport ${width}`).toEqual([['Reviewer', 'Alpha']])
        expect(reading.clipped).toBe(false)
        expect(reading.overflow).toBe(false)
      }
      expect(await overview.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    }
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`Team Overview: precedence, resting ink, faces, fold and pane width in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?team-overview&theme=${theme}`)
    const wide = page.locator('#team-overview-running [data-slot="team-overview"]')
    await expect(wide).toBeVisible()
    await expect(wide).toHaveAttribute('data-layout', 'table')
    await expect(wide.locator('[data-seat]')).toHaveCount(4)
    expect(await wide.locator('[data-seat]').evaluateAll(rows => rows.map(row => row.textContent))).toEqual(expect.arrayContaining([expect.stringContaining('Needs you'), expect.stringContaining('Unread'), expect.stringContaining('Working'), expect.stringContaining('Idle')]))
    expect(await wide.locator('[data-seat]').evaluateAll(rows => rows.map(row => row.getAttribute('data-seat')))).toEqual(['seat-1', 'seat-2', 'seat-0', 'seat-3'])
    await expect(wide.locator('[data-shape="face"]')).toHaveCount(4)
    // The face shares the whole cell centre, including the name and role.
    for (const row of await wide.locator('[data-seat]').all()) {
      const delta = await row.evaluate(e => {
        const face = e.querySelector('[data-slot="icon-tile"]')!.getBoundingClientRect()
        const cell = e.querySelector('[data-slot="table-cell"]')!.getBoundingClientRect()
        return Math.abs((face.top + face.bottom) / 2 - (cell.top + cell.bottom) / 2)
      })
      expect(delta).toBeLessThan(1.5)
    }
    const doing = wide.locator('[data-seat="seat-0"] [data-slot="seat-doing"]')
    await expect(doing).toHaveAttribute('title', /Edit/)
    expect(await doing.locator('[data-part="head"]').evaluate(e => e.scrollWidth > e.clientWidth)).toBe(true)
    const quiet = wide.locator('[data-resting]').last()
    const ink = await quiet.evaluate(e => {
      const text = e.querySelector('[data-slot="text"]') ?? e
      const mark = document.createElement('span'); mark.style.color = 'var(--hd-muted-foreground)'; e.append(mark)
      const expected = getComputedStyle(mark).color; const actual = getComputedStyle(text).color; mark.remove()
      return { actual, expected }
    })
    expect(ink.actual).toBe(ink.expected)
    const done = page.locator('#team-overview-done [data-slot="team-overview"]')
    await expect(done.getByRole('button', { name: '3 done' })).toHaveAttribute('aria-expanded', 'false')
    await expect(done.locator('[data-seat]')).toHaveCount(0)
    await done.getByRole('button', { name: '3 done' }).click()
    await expect(done.locator('[data-seat]')).toHaveCount(3)
    const narrow = page.locator('#team-overview-narrow [data-slot="team-overview"]')
    await expect(narrow).toHaveAttribute('data-layout', 'narrow')
    await expect(narrow.locator('[data-seat][data-slot="list-row"]')).toHaveCount(4)
    expect(await narrow.evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true)
    const rig = page.locator('#team-overview-team')
    await expect(rig.locator('[data-slot="team-overview"]')).toBeVisible()
    await expect(rig.locator('[data-slot="run-workspace"]')).toHaveAttribute('data-view', 'work')
    await expect(rig.locator('[data-slot="team-overview"] [aria-label="Seats"]')).toHaveCount(0)
    const members = await teamSeats(rig)
    await expect(members.locator('[data-slot="list-row"]')).toHaveCount(2)
    const completed = members.locator('[data-slot="list-row-trail"] [data-slot="chip"]').filter({ hasText: /^Done$/ })
    await expect(completed).toHaveCount(2)
    for (const state of await completed.all()) {
      expect(await state.evaluate(e => {
        const label = e.getBoundingClientRect()
        const row = e.closest('[data-slot="list-row"]')!.getBoundingClientRect()
        return label.left >= row.left && label.right <= row.right
      })).toBe(true)
    }
    await closeTeamDetails(rig)
    const tree = page.locator('#team-overview-sidebar')
    const rows = tree.locator('[data-left-row]')
    expect(await rows.count()).toBeGreaterThan(0)
    expect(await rows.evaluateAll(nodes => nodes.filter(node => getComputedStyle(node).display === 'list-item'))).toEqual([])
    await expect(tree.locator('ul, ol')).toHaveCount(0)
    const attention = tree.locator('[data-left-mark][aria-label="Needs you"]')
    await expect(attention).toBeVisible()
    await expect(attention.locator('[data-slot="dot"]')).toHaveAttribute('data-state', 'limit')
    await expect(tree.locator('[data-slot="spinner"]')).toHaveCount(0)
    await expect(tree.locator('[data-slot="chip"]')).toHaveCount(0)
    // A Team that is not open starts folded; its chevron lists the seats under it and folds them again.
    const disclosure = tree.getByRole('button', { name: 'Show the agents in Retry the checkout call', exact: true })
    await expect(disclosure).toHaveCount(1)
    await expect(tree.locator('[data-left-nested]')).toHaveCount(0)
    await disclosure.click()
    const fold = tree.getByRole('button', { name: 'Hide the agents in Retry the checkout call', exact: true })
    await expect(fold).toHaveCount(1)
    expect(await tree.locator('[data-left-nested]').count()).toBeGreaterThan(0)
    await tree.getByRole('button', { name: 'Room Retry the checkout call', exact: true }).hover({ position: { x: 8, y: 16 } })
    await fold.click()
    await expect(tree.locator('[data-left-nested]')).toHaveCount(0)
    const team = tree.getByRole('button', { name: 'Room Retry the checkout call', exact: true })
    const project = tree.locator('[data-project-root] button[data-draggable]')
    await expect(project).toHaveAttribute('aria-expanded', 'true')
    await project.click()
    await expect(project).toHaveAttribute('aria-expanded', 'false')
    await expect(team).toHaveCount(0)
    await project.click()
    await expect(project).toHaveAttribute('aria-expanded', 'true')
    await expect(team).toBeVisible()
    // Details still lists every seat with its conversation.
    const running = page.locator('#team-overview-live-running')
    const runningSeats = await teamSeats(running)
    await expect(runningSeats.locator('[data-slot="list-row"]')).toHaveCount(2)
    await expect(runningSeats.locator('[data-slot="list-row-title"]')).toHaveText(['Alpha', 'Beta'])
    await expect(runningSeats.locator('[data-slot="list-row"]').nth(0)).toHaveAccessibleName(/Writer conversation/)
    await expect(runningSeats.locator('[data-slot="list-row"]').nth(1)).toHaveAccessibleName(/Reviewer conversation/)
    await closeTeamDetails(running)
  })
}

for (const theme of ['light', 'dark'] as const) {
  {

    for (const [item0, scene] of (['running', 'narrow']).entries()) test(`Team Overview: attention sentences wrap whole in ${theme} [item ${[item0].join('-')}]`, async ({ page }) => {
      await page.goto(`/preview.html?team-overview&theme=${theme}`)
      const attention = page.locator(`#team-overview-${scene} [aria-label="Needs you"]`)
      const sentence = attention.locator('[data-slot="list-row-subtitle"]')
      await expect(sentence).toHaveText(/choose whether to keep the original payment method/)
      expect(await sentence.evaluate(e => {
        const style = getComputedStyle(e)
        const range = document.createRange(); range.selectNodeContents(e)
        const bounds = e.getBoundingClientRect()
        return { whiteSpace: style.whiteSpace, textOverflow: style.textOverflow, lines: range.getClientRects().length, fits: e.scrollWidth <= e.clientWidth && e.scrollHeight <= e.clientHeight, inside: [...range.getClientRects()].every(r => r.left >= bounds.left - 1 && r.right <= bounds.right + 1 && r.bottom <= bounds.bottom + 1) }
      })).toMatchObject({ whiteSpace: 'normal', textOverflow: 'clip', fits: true, inside: true })
      if (scene === 'narrow') expect(await sentence.evaluate(e => e.getBoundingClientRect().height)).toBeGreaterThan(30)


    })
  }
}

for (const theme of ['light', 'dark'] as const) {
  {

    for (const [item0, [scene, sentence]] of ([
      ['running', 'Alpha is working'],
      ['needs-you', 'Beta is waiting for your approval'],
      ['stalled', 'Choose the target before this Run can continue'],
    ]).entries()) test(`Team Work: live status and canonical Seat faces align in ${theme} [item ${[item0].join('-')}]`, async ({ page }) => {
      await page.goto(`/preview.html?team-overview&theme=${theme}`)
      await page.evaluate(() => document.fonts.ready)
      const frame = page.locator(`#team-overview-live-${scene}`)
      const overview = frame.locator('[data-slot="team-overview"]')
      await expect(frame.locator('[data-slot="run-workspace"]')).toHaveAttribute('data-view', 'work')
      if (scene === 'stalled') {
        const pending = frame.getByRole('region', { name: 'Pending', exact: true })
        await pending.getByRole('button', { name: 'Open Run', exact: true }).click()
        const inspector = frame.locator('[data-slot="run-inspector"]')
        await expect(inspector.locator('[aria-label="Team Run facts"]')).toBeVisible()
        await expect(inspector).toContainText(sentence!)
        expect((await inspector.textContent())?.split(sentence!)).toHaveLength(2)
        await frame.getByRole('button', { name: 'Close pane', exact: true }).click()
      } else if (scene === 'needs-you') {
        await overview.getByRole('button', { name: 'Open Chat', exact: true }).click()
        await expect(frame.locator('[data-slot="approval-card"] [data-slot="approval-meta"][data-kind="person"]')).toContainText('Beta')
        await expect(frame.locator('[data-slot="approval-card"]')).toContainText('Beta asks to edit the checkout file before retrying the payment')
        await selectTeamPage(frame, 'overview')
      } else await expect(overview.locator('[aria-label="Run"] [data-slot="room-live-line"]')).toContainText(sentence!)
      const seats = await teamSeats(frame)
      const rows = seats.locator('[data-slot="list-row"]')
      await expect(rows).toHaveCount(2)
      for (const row of await rows.all()) {
        await row.scrollIntoViewIfNeeded()
        const delta = await row.evaluate(e => {
          const face = e.querySelector('[data-slot="list-row-lead"] svg')!.getBoundingClientRect()
          const content = e.querySelector('[data-slot="list-row-content"]')!.getBoundingClientRect()
          const title = e.querySelector('[data-slot="list-row-title"]')!.getBoundingClientRect()
          const subtitle = e.querySelector('[data-slot="list-row-subtitle"]')?.getBoundingClientRect()
          return { face: Math.abs((face.top + face.bottom - content.top - content.bottom) / 2),
            column: subtitle ? Math.abs(title.left - subtitle.left) : 0 }
        })
        expect(delta.face).toBeLessThan(1.5)
        expect(delta.column).toBeLessThan(1.5)
        const opener = row.getByRole('button', { name: /^Actions for / })
        const box = (await opener.boundingBox())!
        expect(box.width).toBeGreaterThanOrEqual(24)
        expect(box.height).toBeGreaterThanOrEqual(24)
        for (const title of await row.locator('[data-slot="list-row-title"] [title]').all()) {
          expect(await title.evaluate(el => {
            const box = el.getBoundingClientRect(), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
            return hit !== null && el.contains(hit)
          })).toBe(true)
        }
      }
      await closeTeamDetails(frame)
    })
  }
}

for (const theme of ['light', 'dark'] as const) {
  test(`Team Overview: evidence and unrouted reasons stay visible once in ${theme}`, async ({ page }) => {
    await page.goto(`/preview.html?team-overview&theme=${theme}`)
    const waiting = page.locator('#team-overview-live-waiting-evidence [data-slot="team-overview"]')
    await expect(page.locator('#team-overview-live-waiting-evidence [data-topbar="state"] [aria-label="Running"]')).toBeVisible()
    await expect(waiting.locator('[aria-label="Run"]')).toContainText('Waiting for CI to go green at this revision.')
    await expect(waiting).not.toContainText('Rule ')
    await expect(waiting.locator('[data-slot="room-pending-release-line"]')).toHaveText('Waiting for a Seat to finish before releasing its checkout.')
    expect((await waiting.textContent())?.split('Waiting for CI to go green at this revision.')).toHaveLength(2)
    await expect(page.locator('#team-overview-live-waiting-evidence [data-slot="run-flow"]')).toBeVisible()
    await expect(page.locator('#team-overview-live-waiting-evidence [data-slot="run-view"]').first()).toBeVisible()
    const reason = '"Review the change" (#2) answered revise; no rule continues from it, so this waits for you'
    const unrouted = page.locator('#team-overview-live-unrouted')
    await expect(unrouted.locator('[data-slot="run-need"]')).toContainText(reason)
    expect((await unrouted.textContent())?.split(reason)).toHaveLength(2)

  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`Work keeps unknown stopped timing explicit in its Run facts and record in ${theme}`, async ({ page }) => {
    await page.goto(`/preview.html?team-overview&theme=${theme}`)
    const frame = page.locator('#team-overview-live-stopped-unknown')
    await teamSeats(frame)
    const facts = frame.locator('[aria-label="Team Run facts"] [data-slot="summary-item"]').filter({ has: page.locator('dt', { hasText: /^Elapsed$/ }) })
    await expect(facts).toContainText('Not recorded')
    await closeTeamDetails(frame)
    await frame.getByRole('button', { name: 'Full record', exact: true }).click()
    const record = frame.getByRole('list', { name: 'Run timeline', exact: true })
    await expect(record.locator('[data-slot="run-time"]')).toHaveText(['Time not recorded', 'Time not recorded'])
    await expect(record.locator('[data-step-row="writer"]')).toContainText('Stopped')
    await expect(record.locator('[data-step-row="reviewer"]')).toContainText('Stopped')
    await expect(record).not.toContainText('is working')
  })
  test(`Overview keeps findings, posting and pending release reasons once in ${theme}`, async ({ page }) => {
    await page.goto(`/preview.html?team-overview&theme=${theme}`)
    const overview = page.locator('#team-overview-live-findings-and-posting [data-slot="team-overview"]')
    const text = await overview.textContent()
    for (const reason of ['Waiting for 3 open blocking findings to be confirmed resolved.', 'This review is waiting to be posted.', 'Waiting for a Seat to finish before releasing its checkout.']) expect(text?.split(reason)).toHaveLength(2)
    await expect(overview).not.toContainText('after-review')
    await expect(overview.getByRole('button', { name: 'Open findings', exact: true })).toHaveCount(2)
    await overview.getByRole('button', { name: 'Open findings', exact: true }).first().click()
    await expect(page.locator('#team-overview-live-findings-and-posting [aria-label="Findings"]').first()).toBeVisible()
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`Overview gives the name the available width and drops empty readings in ${theme}`, async ({ page }) => {
    await page.goto(`/preview.html?team-overview&theme=${theme}`)
    const overview = page.locator('#team-overview-running [data-slot="team-overview"]')
    const widths = await overview.locator('th').evaluateAll(heads => heads.map(head => head.getBoundingClientRect().width))
    expect(widths[0]).toBeGreaterThan(widths[4]!)
    await expect(overview.locator('[data-seat="seat-0"] [data-slot="seat-card"]')).toHaveCSS('white-space', 'nowrap')
    const done = page.locator('#team-overview-comparison [data-slot="team-overview"]')
    await expect(done.locator('th')).toHaveText(['Agent', 'Card', 'Round', 'State', 'Time', 'Open conversation'])
    expect(await done.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)

  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`an unreadable findings ledger raises attention and opens Findings in ${theme}`, async ({ page }) => {
    await page.goto(`/preview.html?team-overview&theme=${theme}`)
    const rig = page.locator('#team-overview-live-unreadable-ledger')
    const overview = rig.locator('[data-slot="team-overview"]')
    const reason = 'Some findings could not be read, so this cannot be ready. A person has to look.'
    await expect(rig.locator('[data-topbar="state"] [aria-label="Needs you"]')).toBeVisible()
    await expect(overview.getByRole('region', { name: 'Pending', exact: true })).toContainText(reason)
    expect((await overview.textContent())?.split(reason)).toHaveLength(2)
    await expect(overview).not.toContainText('Rule ')
    const open = overview.getByRole('button', { name: 'Open findings', exact: true })
    await expect(open).toHaveAttribute('title', 'You or the reviewer can resolve this wait in Findings.')
    await open.click()
    await expect(rig.locator('[aria-label="Findings"]').first()).toBeVisible()
  })
}


for (const theme of ['light', 'dark'] as const) {
  test(`short Seat openers keep a 24px target in both layouts in ${theme}`, async ({ page }) => {
    await page.goto(`/preview.html?team-overview&theme=${theme}`)
    for (const width of [1440, 720]) {
      await page.setViewportSize({ width, height: 1100 })
      const opener = page.locator('#team-overview-running [data-slot="team-overview"]').getByRole('button', { name: /^Open / }).filter({ has: page.locator('[data-role="subject"]') }).first()
      await opener.locator('[data-role="subject"]').evaluate(node => { node.textContent = 'A' })
      const box = (await opener.boundingBox())!
      expect(box.width).toBeGreaterThanOrEqual(24)
      expect(box.height).toBeGreaterThanOrEqual(24)
    }
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`Team news: orange waits, blue clears on opening, and unchecked Overview has no count in ${theme}`, async ({page}) => {
    await page.setViewportSize({width:1200,height:900})
    await page.emulateMedia({colorScheme:theme})
    await page.goto(`/preview.html?team-overview&theme=${theme}`)
    await page.evaluate(() => document.fonts.ready)
    const sidebar=page.locator('#team-attention-sidebar')
    const orange=sidebar.getByRole('button',{name:'Room Waiting on you',exact:true}).locator('xpath=ancestor::*[@data-left-row][1]')
    const blue=sidebar.getByRole('button',{name:'Room Finished work',exact:true}).locator('xpath=ancestor::*[@data-left-row][1]')
    const quiet=sidebar.getByRole('button',{name:'Room Seen work',exact:true}).locator('xpath=ancestor::*[@data-left-row][1]')
    await expect(orange.locator('[data-left-mark]')).toHaveAttribute('aria-label','Needs you')
    await expect(orange.locator('[data-slot="dot"]')).toHaveAttribute('data-state','limit')
    await expect(blue.locator('[data-left-mark]')).toHaveAttribute('aria-label','New')
    await expect(blue.locator('[data-slot="dot"]')).toHaveAttribute('data-state','new')
    await expect(quiet.locator('[data-left-mark]')).toHaveCount(0)
    await sidebar.screenshot({path:`${process.env.HD_1777_FRAMES ?? 'output/playwright/1777'}/sidebar-${theme}.png`})
    await blue.getByRole('button',{name:'Room Finished work',exact:true}).locator('[data-left-fold-name]').click()
    await expect(blue.locator('[data-left-mark]')).toHaveCount(0)
    const frame=page.locator('#team-overview-live-unchecked')
    const overview=frame.locator('[data-slot="team-overview"]')
    await expect(overview.locator('[data-unchecked-done]')).toHaveText('141 cards finished without a checkOpen BoardWrap')
    await expect(frame.locator('[data-topbar="state"] [aria-label="Done"]')).toBeVisible()
    await expect(overview.getByRole('region', { name: 'Pending', exact: true })).toHaveCount(0)
    await expect(frame.locator('[data-team-page="overview"] [data-slot="switcher-count"], [data-team-page="overview"] [data-slot="tabs-count"]')).toHaveCount(0)
    await expect(frame.locator('[data-team-page="overview"]')).toHaveText('Work')
    await expect(overview.getByRole('button',{name:'Wrap',exact:true})).toBeVisible()
    const row = overview.locator('[data-unchecked-done]')
    const textBox = (await row.locator('[data-slot="list-row-title"]').boundingBox())!
    const actions = row.locator('[data-slot="list-row-trail"]')
    for (const label of ['Open Board', 'Wrap']) {
      const actionBox = (await actions.getByRole('button', {name:label, exact:true}).boundingBox())!
      expect(actionBox.x).toBeGreaterThan(textBox.x + textBox.width)
      expect(Math.abs(actionBox.y + actionBox.height / 2 - textBox.y - textBox.height / 2)).toBeLessThanOrEqual(2)
    }
    await frame.screenshot({path:`${process.env.HD_1777_FRAMES ?? 'output/playwright/1777'}/overview-${theme}.png`})
    await overview.getByRole('button',{name:'Open Board',exact:true}).click()
    await expect(frame.locator('[data-team-page="board"]')).toHaveAttribute('data-active','')
  })

  test(`Work keeps attention readable without a duplicate navigation count in ${theme}`, async ({page}) => {
    await page.goto(`/preview.html?team-overview&theme=${theme}`)
    for (const scene of ['needs-you','stalled','unrouted','findings-and-posting']) {
      const frame=page.locator(`#team-overview-live-${scene}`)
      if (scene === 'needs-you') {
        await expect(frame.getByRole('button', { name: 'Open Chat', exact: true })).toBeVisible()
        await expect(frame.locator('[data-team-page="room"]')).toHaveAttribute('title', '1 pending reply')
      } else if (scene === 'stalled') {
        await expect(frame.getByRole('region', { name: 'Pending', exact: true }).getByRole('button', { name: 'Open Run', exact: true })).toBeVisible()
      } else if (scene === 'unrouted') {
        await expect(frame.locator('[data-slot="run-need"]')).toBeVisible()
        await expect(frame.locator('[data-slot="run-need"]')).toContainText('no rule continues')
      } else {
        const rows=frame.getByRole('region', { name: 'Pending', exact: true }).locator('[data-slot="list-row"]')
        await expect(rows.first()).toBeVisible()
        expect(await rows.count()).toBeGreaterThan(0)
      }
      await expect(frame.locator('[data-team-page="overview"]')).toHaveText('Work')
      await expect(frame.locator('[data-team-page="overview"] [data-slot="tabs-count"]')).toHaveCount(0)
    }
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`Overview seat facts stay inside the row in ${theme}`, async ({ page }) => {
    for (const width of [240, 320, 420, 800, 1440]) {
      await page.setViewportSize({ width, height: 1100 })
      await page.goto(`/preview.html?team-overview=narrow&theme=${theme}`)
      await page.evaluate(() => document.fonts.ready)
      const rows = page.locator('#team-overview-narrow [data-slot="team-overview"] [data-seat]')
      await expect(rows).toHaveCount(4)
      for (const row of await rows.all()) {
        const result = await row.evaluate(el => {
          const box = el.getBoundingClientRect()
          const title = el.querySelector('[data-slot="list-row-title"]')!.getBoundingClientRect()
          const trail = el.querySelector('[data-slot="list-row-trail"]')?.getBoundingClientRect()
          const facts = [...el.querySelectorAll<HTMLElement>('[data-slot="seat-state"], [data-slot="seat-cost"]')]
          const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1
          return facts.map(fact => {
            const rect = fact.getBoundingClientRect()
            const range = document.createRange(); range.selectNodeContents(fact)
            const ink = [...range.getClientRects()].filter(r => r.width > 0 && r.height > 0)
            return {
              inside: rect.left >= box.left - 1 && rect.right <= box.right + 1 && ink.every(r => r.left >= box.left - 1 && r.right <= box.right + 1 && r.top >= box.top - 1 && r.bottom <= box.bottom + 1),
              uncut: fact.scrollWidth <= fact.clientWidth + 1 && ink.every(r => r.left >= rect.left - 1 && r.right <= rect.right + 1),
              overlapsTitle: overlaps(rect, title),
              overlapsTrail: trail ? overlaps(rect, trail) : false,
            }
          })
        })
        expect(result.length).toBeGreaterThan(0)
        for (const fact of result) expect(fact, `viewport ${width}`).toEqual({ inside: true, uncut: true, overlapsTitle: false, overlapsTrail: false })
      }
    }
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`Overview facts resize and seat actions remain usable in ${theme}`, async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', error => pageErrors.push(error.message))
    await page.addInitScript(() => {
      const errors: string[] = []
      Object.assign(window, { __seatObserverErrors: errors })
      window.addEventListener('error', event => { if (event.message.includes('ResizeObserver loop')) errors.push(event.message) })
    })
    await page.setViewportSize({ width: 420, height: 1100 })
    await page.goto(`/preview.html?team-overview=narrow&seat-facts-test=unavailable&theme=${theme}`)
    await page.evaluate(() => document.fonts.ready)
    const overview = page.locator('#team-overview-narrow [data-slot="team-overview"]')
    const short = overview.locator('[data-seat="seat-0"]')
    const long = overview.locator('[data-seat="seat-1"]')
    const unavailable = overview.locator('[data-seat="seat-2"]')
    const facts = short.locator('[data-slot="list-row-heading-facts"]')
    await expect(short.locator('[data-slot="seat-cost"]')).toHaveText('123456 turns')
    await expect(short.locator('[data-slot="seat-state"]')).toHaveText('Working')
    await expect(long.locator('[data-slot="seat-state"]')).toHaveText('Needs you')
    await expect(long.locator('[data-slot="seat-cost"]')).toHaveText('$0.21')
    await expect(unavailable.locator('[data-slot="seat-cost"]')).toHaveText('—')
    await expect(unavailable.getByRole('button', { name: /^Open / })).toHaveCount(0)
    await expect(facts).toHaveAttribute('data-placement', 'inline')
    await expect(long.locator('[data-slot="list-row-heading-facts"]')).toHaveAttribute('data-placement', 'inline')
    expect(await long.locator('[data-slot="text"][data-role="subject"]').evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true)
    await short.getByRole('button', { name: 'Open A', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('[data-seat-opened]')).toHaveText('seat-0')
    for (const width of [240, 320, 420, 240, 420]) {
      await page.setViewportSize({ width, height: 1100 })
      if (width === 420) await expect(facts).toHaveAttribute('data-placement', 'inline')
      if (width === 240) await expect(facts).toHaveAttribute('data-placement', 'below')
      await expect(facts).toBeVisible()
      const placements = await facts.evaluate(async el => {
        const values: string[] = []
        for (let i = 0; i < 6; i++) { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); values.push(el.getAttribute('data-placement') ?? '') }
        return values
      })
      expect(new Set(placements).size).toBe(1)
    }
    const opener = short.getByRole('button', { name: 'Open A', exact: true })
    const output = page.locator('[data-seat-opened]')
    await opener.focus(); await expect(opener).toBeFocused()
    await page.keyboard.press('Enter'); await page.keyboard.press('Space'); await opener.click()
    await short.click({ position: { x: 2, y: 2 } })
    await expect(output).toHaveText('seat-0,seat-0,seat-0,seat-0,seat-0')
    await unavailable.click({ position: { x: 2, y: 2 } })
    await expect(output).toHaveText('seat-0,seat-0,seat-0,seat-0,seat-0')
    await expect(long.getByRole('button', { name: 'Open A very long synthetic agent name for truncation' })).toBeVisible()
    await expect(long.locator('[title="A very long synthetic agent name for truncation"]')).toBeVisible()
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    expect(pageErrors).toEqual([])
    expect(await page.evaluate(() => (window as unknown as { __seatObserverErrors: string[] }).__seatObserverErrors)).toEqual([])
  })
}

for (const theme of ['light', 'dark'] as const) {
  for (const variant of ['done', 'stopped', 'unavailable'] as const) {
    test(`narrow Overview ${variant} facts and descriptions fit in ${theme}`, async ({ page }) => {
      for (const width of [240, 320, 420]) {
        await page.setViewportSize({ width, height: 1100 })
        await page.goto(`/preview.html?team-overview=narrow&seat-facts-test=${variant}&theme=${theme}`)
        await page.evaluate(() => document.fonts.ready)
        const rows = page.locator('#team-overview-narrow [data-seat]')
        await expect(rows.first().locator('[data-slot="list-row-heading"]')).toBeVisible()
        if (variant === 'done') await expect(rows.first().locator('[data-slot="seat-state"]')).toHaveText('Done')
        if (variant === 'stopped') await expect(rows.first().locator('[data-slot="seat-state"]')).toHaveText('Stopped')
        if (variant === 'unavailable') await expect(page.locator('#team-overview-narrow [data-seat="seat-2"]').getByRole('button', { name: /^Open / })).toHaveCount(0)
        for (const row of await rows.all()) {
          const geometry = await row.evaluate(el => {
            const row = el.getBoundingClientRect(), heading = el.querySelector('[data-slot="list-row-heading"]')!.getBoundingClientRect()
            const title = el.querySelector('[data-slot="list-row-title"]')!.getBoundingClientRect()
            const trail = el.querySelector('[data-slot="list-row-trail"]')?.getBoundingClientRect()
            const subtitle = el.querySelector('[data-slot="list-row-subtitle"]')?.getBoundingClientRect()
            const css = getComputedStyle(el)
            const overlap = (a: DOMRect, b: DOMRect) => a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1
            const facts = [...el.querySelectorAll<HTMLElement>('[data-slot="seat-state"], [data-slot="seat-cost"]')].map(fact => {
              const rect = fact.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(fact)
              const ink = [...range.getClientRects()].filter(r => r.width && r.height)
              return rect.left >= row.left - 1 && rect.right <= row.right + 1 && fact.scrollWidth <= fact.clientWidth + 1 &&
                ink.every(r => r.left >= rect.left - 1 && r.right <= rect.right + 1 && r.top >= row.top - 1 && r.bottom <= row.bottom + 1) &&
                !overlap(rect, title) && (!trail || !overlap(rect, trail))
            })
            return { facts, description: !subtitle || (Math.abs(subtitle.left - heading.left) < 1 && Math.abs(subtitle.right - heading.right) < 1),
              belowWidth: (() => { const f = el.querySelector<HTMLElement>('[data-placement="below"]'); if (!f) return true; const b = f.getBoundingClientRect(); return Math.abs(b.left - row.left - parseFloat(css.paddingLeft) - parseFloat(css.borderLeftWidth)) < 1 && Math.abs(row.right - parseFloat(css.paddingRight) - parseFloat(css.borderRightWidth) - b.right) < 1 })() }
          })
          expect(geometry.facts.length).toBeGreaterThan(0)
          expect(geometry.facts.every(Boolean), `${variant} at ${width}`).toBe(true)
          expect(geometry.description).toBe(true)
          expect(geometry.belowWidth).toBe(true)
        }
      }
    })
  }
}

test('Overview idle ticks retain heading observers while facts and width still reflow', async ({ page }) => {
  await page.clock.install()
  await page.addInitScript(() => {
    const NativeResizeObserver = window.ResizeObserver
    const counts = { created: 0, disconnected: 0 }
    const observed = new WeakSet<Element>()
    Object.assign(window, { __headingObserverCounts: counts, __headingObserved: observed })
    window.ResizeObserver = class extends NativeResizeObserver {
      private heading = false
      override observe(target: Element, options?: ResizeObserverOptions) {
        if (!this.heading && target.matches('[data-slot="list-row-heading"]')) {
          this.heading = true
          counts.created++
        }
        if (this.heading) observed.add(target)
        super.observe(target, options)
      }
      override disconnect() {
        if (this.heading) counts.disconnected++
        super.disconnect()
      }
    }
  })
  await page.setViewportSize({ width: 420, height: 1100 })
  await page.goto('/preview.html?team-overview=narrow&seat-facts-test=unavailable&theme=light')
  await page.evaluate(() => document.fonts.ready)
  const row = page.locator('#team-overview-narrow [data-seat="seat-0"]')
  const facts = row.locator('[data-slot="list-row-heading-facts"]')
  await page.clock.runFor(500)
  await expect(facts).toHaveAttribute('data-placement', 'inline')
  const counts = () => page.evaluate(() => ({ ...(window as unknown as { __headingObserverCounts: { created: number; disconnected: number } }).__headingObserverCounts }))
  const before = await counts()
  expect(before.created - before.disconnected).toBe(4)
  await page.clock.runFor(3000)
  expect(await counts()).toEqual(before)

  // Moving the facts below mounts them afresh, so a cost written into the DOM would be lost on the
  // move and the row would flip straight back. A stylesheet keyed on a body attribute survives it,
  // and the body attribute is one of the changes the row already listens for (themes use it).
  const longCost = (on: boolean) => page.evaluate(on => {
    if (!document.getElementById('long-seat-cost')) {
      const style = document.createElement('style')
      style.id = 'long-seat-cost'
      style.textContent = 'body[data-long-seat-cost] #team-overview-narrow [data-seat="seat-0"] [data-slot="seat-cost"]::after { content: " 999999999999999999999999999 turns" }'
      document.head.append(style)
    }
    document.body.toggleAttribute('data-long-seat-cost', on)
  }, on)
  await longCost(true)
  await page.clock.runFor(100)
  await expect(facts).toHaveAttribute('data-placement', 'below')
  await facts.locator('[data-slot="seat-cost"]').evaluate(el => {
    const replacement = document.createElement('span')
    replacement.setAttribute('data-slot', 'seat-cost')
    replacement.textContent = '2 turns'
    el.replaceWith(replacement)
  })
  await page.clock.runFor(100)
  await expect(facts).toHaveAttribute('data-placement', 'below')
  expect(await facts.locator('[data-slot="seat-cost"]').evaluate(el => (window as unknown as { __headingObserved: WeakSet<Element> }).__headingObserved.has(el))).toBe(true)
  await longCost(false)
  await page.clock.runFor(100)
  await expect(facts).toHaveAttribute('data-placement', 'inline')
  await page.setViewportSize({ width: 240, height: 1100 })
  await page.clock.runFor(100)
  await expect(facts).toHaveAttribute('data-placement', 'below')
  await page.setViewportSize({ width: 420, height: 1100 })
  await page.clock.runFor(100)
  await expect(facts).toHaveAttribute('data-placement', 'inline')
})
